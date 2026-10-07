#!/usr/bin/env python3
"""Dependency-free static host and authoritative WebSocket match server."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import mimetypes
import os
import random
import re
import socket
import struct
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
MAP = json.loads((ROOT / "map.json").read_text(encoding="utf-8"))
WEAPONS = {gun["name"]: gun for gun in json.loads((ROOT / "weapons.json").read_text(encoding="utf-8"))}
MAX_PLAYERS = 12
MATCH_SECONDS = 300
SCORE_LIMIT = 30
TICK_SECONDS = 0.05
ROOM_CODE = re.compile(r"^[A-Z0-9]{4,8}$")
_WALLS = MAP["walls"]


def is_blocked(x: float, y: float) -> bool:
    if x < 0 or y < 0 or x >= MAP["width"] or y >= MAP["height"]:
        return True
    return any(wx <= x < wx + ww and wy <= y < wy + wh for wx, wy, ww, wh in _WALLS)


def collides(x: float, y: float, radius: float = 0.22) -> bool:
    return any(is_blocked(px, py) for px, py in
               ((x - radius, y), (x + radius, y), (x, y - radius), (x, y + radius)))


def line_distance(x: float, y: float, angle: float, limit: float) -> float:
    distance = 0.12
    while distance < limit:
        if is_blocked(x + math.cos(angle) * distance, y + math.sin(angle) * distance):
            return distance
        distance += 0.12
    return limit


def safe_name(value: object) -> str:
    if not isinstance(value, str):
        return "Operator"
    name = "".join(ch for ch in value.strip() if ch.isalnum() or ch in " _-")[:18].strip()
    return name or "Operator"


def create_player(name: str, team: int, loadout: object, attachments: object = None) -> dict:
    if isinstance(loadout, dict):
        choices = loadout.get("weapons", [])
        attachments = loadout
    else:
        choices = loadout
    valid = choices if isinstance(choices, list) else []
    primary = valid[0] if valid and isinstance(valid[0], str) and valid[0] in WEAPONS else "Kestrel"
    secondary = valid[1] if len(valid) > 1 and isinstance(valid[1], str) and valid[1] in WEAPONS else "Mica"
    spawn = random.choice(MAP["spawns"][str(team)])
    choices = attachments if isinstance(attachments, dict) else {}
    return {
        "id": uuid.uuid4().hex, "name": safe_name(name), "team": team,
        "x": spawn[0] + random.uniform(-0.3, 0.3),
        "y": spawn[1] + random.uniform(-0.3, 0.3), "angle": spawn[2],
        "health": 100, "alive": True, "kills": 0, "deaths": 0,
        "respawnAt": 0.0, "weapon": primary, "weapons": [primary, secondary],
        "attachments": {
            "optic": choices.get("optic") if choices.get("optic") in ("iron", "reflex", "scope") else "iron",
            "barrel": choices.get("barrel") if choices.get("barrel") in ("standard", "comp", "suppressor") else "standard",
            "grip": choices.get("grip") if choices.get("grip") in ("standard", "vertical", "laser") else "standard",
        },
        "ammo": {weapon: {"mag": WEAPONS[weapon]["mag"], "reserve": WEAPONS[weapon]["reserve"]}
                 for weapon in set((primary, secondary))},
        "input": {"forward": 0, "strafe": 0, "sprint": False, "fire": False, "fireEdge": False},
        "fireAt": 0.0, "reloadAt": 0.0, "reloadWeapon": None
    }


def weapon_stats(player: dict) -> dict:
    gun = dict(WEAPONS[player["weapon"]])
    attachments = player["attachments"]
    if attachments["optic"] == "reflex":
        gun["spread"] *= 0.79
    elif attachments["optic"] == "scope":
        gun["spread"] *= 0.48
        gun["range"] *= 1.14
    if attachments["barrel"] == "comp":
        gun["recoil"] *= 0.72
    elif attachments["barrel"] == "suppressor":
        gun["range"] *= 0.84
    if attachments["grip"] == "vertical":
        gun["recoil"] *= 0.7
    elif attachments["grip"] == "laser":
        gun["spread"] *= 0.73
    return gun


class Peer:
    def __init__(self, connection: socket.socket, address: tuple):
        self.socket = connection
        self.address = address
        self.send_lock = threading.Lock()
        self.room = None
        self.player = None
        self.closed = False

    def send(self, packet: dict) -> None:
        data = json.dumps(packet, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(data) > 65535:
            return
        length = len(data)
        if length < 126:
            frame = bytes((0x81, length)) + data
        else:
            frame = bytes((0x81, 126)) + struct.pack("!H", length) + data
        with self.send_lock:
            if self.closed:
                return
            try:
                self.socket.sendall(frame)
            except OSError:
                self.closed = True


class Room:
    def __init__(self, code: str, mode: str):
        self.code = code
        self.mode = mode if mode in ("tdm", "dom") else "tdm"
        self.peers: list[Peer] = []
        self.score = [0, 0]
        self.started = time.monotonic()
        self.last_tick = self.started
        self.last_dom_score = self.started
        self.ended = False
        self.sites = [dict(site, owner=-1, progress=0.0, capturing=-1) for site in MAP["sites"]]
        self.lock = threading.RLock()


class MatchHub:
    def __init__(self):
        self.rooms: dict[str, Room] = {}
        self.lock = threading.RLock()
        self.running = True
        self.thread = threading.Thread(target=self._tick_loop, name="match-ticker", daemon=True)
        self.thread.start()

    def connect(self, peer: Peer, packet: dict) -> None:
        kind = packet.get("type")
        with self.lock:
            code = str(packet.get("code", "")).strip().upper()
            if kind == "create":
                if not ROOM_CODE.fullmatch(code):
                    peer.send({"type": "error", "message": "Invalid room code."})
                    return
                if code in self.rooms:
                    peer.send({"type": "error", "message": "That room code is already in use. Create another."})
                    return
                room = Room(code, str(packet.get("mode", "tdm")))
                self.rooms[code] = room
            elif kind == "join":
                if not ROOM_CODE.fullmatch(code) or code not in self.rooms:
                    peer.send({"type": "error", "message": "Room not found. Check the code with the host."})
                    return
                room = self.rooms[code]
            else:
                peer.send({"type": "error", "message": "Create or join a room to connect."})
                return
            with room.lock:
                if room.ended:
                    peer.send({"type": "error", "message": "This match has ended. Create a new room."})
                    if kind == "create":
                        self.rooms.pop(code, None)
                    return
                if len(room.peers) >= MAX_PLAYERS:
                    peer.send({"type": "error", "message": "Room is full (12 players maximum)."})
                    return
                counts = [sum(1 for item in room.peers if item.player["team"] == team) for team in (0, 1)]
                team = 0 if counts[0] <= counts[1] else 1
                player = create_player(packet.get("name"), team, packet.get("loadout"))
                peer.room = room
                peer.player = player
                room.peers.append(peer)
                peer.send({"type": "room", "code": code, "playerId": player["id"], "mode": room.mode})
                self.broadcast(room)

    def receive(self, peer: Peer, packet: dict) -> None:
        with self.lock:
            room = peer.room
            player = peer.player
            if room is None or player is None:
                if packet.get("type") in ("create", "join"):
                    self.connect(peer, packet)
                return
            with room.lock:
                if room.ended or player not in [item.player for item in room.peers]:
                    return
                kind = packet.get("type")
                if kind == "input":
                    self._set_input(player, packet)
                    return
                if kind == "weapon":
                    name = packet.get("name")
                    if name in player["weapons"]:
                        player["weapon"] = name
                    return
                if kind == "reload":
                    self._reload(player)
                    return
                if kind == "fire":
                    self._fire(room, peer, force=True)

    @staticmethod
    def _set_input(player: dict, packet: dict) -> None:
        def axis(name: str) -> float:
            value = packet.get(name, 0)
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                return 0.0
            return max(-1.0, min(1.0, float(value)))
        angle = packet.get("angle")
        if isinstance(angle, (int, float)) and math.isfinite(angle):
            player["angle"] = math.atan2(math.sin(angle), math.cos(angle))
        was_firing = player["input"]["fire"]
        player["input"] = {
            "forward": axis("forward"), "strafe": axis("strafe"),
            "sprint": packet.get("sprint") is True, "fire": packet.get("fire") is True,
            "fireEdge": packet.get("fire") is True and not was_firing
        }

    @staticmethod
    def _reload(player: dict) -> None:
        weapon = WEAPONS[player["weapon"]]
        ammo = player["ammo"][weapon["name"]]
        now = time.monotonic()
        if weapon["class"] == "Melee" or ammo["mag"] >= weapon["mag"] or ammo["reserve"] <= 0 or now < player["reloadAt"]:
            return
        player["reloadAt"] = now + weapon["reload"]
        player["reloadWeapon"] = weapon["name"]

    @staticmethod
    def _spawn(player: dict) -> None:
        spot = random.choice(MAP["spawns"][str(player["team"])])
        player.update(x=spot[0] + random.uniform(-0.3, 0.3), y=spot[1] + random.uniform(-0.3, 0.3),
                      angle=spot[2], health=100, alive=True)
        player["ammo"] = {name: {"mag": WEAPONS[name]["mag"], "reserve": WEAPONS[name]["reserve"]}
                          for name in set(player["weapons"])}

    def _fire(self, room: Room, shooter_peer: Peer, force: bool = False) -> None:
        shooter = shooter_peer.player
        now = time.monotonic()
        gun = weapon_stats(shooter)
        if not shooter["alive"] or now < shooter["fireAt"] or now < shooter["reloadAt"]:
            return
        ammo = shooter["ammo"][gun["name"]]
        if ammo["mag"] <= 0:
            self._reload(shooter)
            return
        shooter["fireAt"] = now + gun["rate"]
        ammo["mag"] -= 1
        candidates = []
        for peer in room.peers:
            target = peer.player
            if target is shooter or not target["alive"] or target["team"] == shooter["team"]:
                continue
            dx, dy = target["x"] - shooter["x"], target["y"] - shooter["y"]
            distance = math.hypot(dx, dy)
            if distance > gun["range"]:
                continue
            angle = math.atan2(dy, dx)
            if line_distance(shooter["x"], shooter["y"], angle, distance) < distance - 0.22:
                continue
            delta = math.atan2(math.sin(angle - shooter["angle"]), math.cos(angle - shooter["angle"]))
            inaccuracy = gun["spread"] + gun["recoil"] * 0.35
            if abs(delta) <= max(inaccuracy * 1.8, 0.018) + 0.28 / max(distance, 1):
                candidates.append((distance, peer))
        if candidates:
            _, target_peer = min(candidates, key=lambda item: item[0])
            target = target_peer.player
            target["health"] -= gun["damage"]
            self.event(room, {"event": "hit", "target": target["id"], "source": shooter["id"]})
            if target["health"] <= 0:
                target["health"] = 0
                target["alive"] = False
                target["deaths"] += 1
                target["respawnAt"] = now + 3.0
                shooter["kills"] += 1
                room.score[shooter["team"]] += 1
                self.event(room, {"event": "kill", "target": target["id"], "source": shooter["id"]})
                if room.score[shooter["team"]] >= SCORE_LIMIT:
                    self._end(room, shooter["team"])
        self.broadcast(room)

    def _tick_loop(self) -> None:
        while self.running:
            time.sleep(TICK_SECONDS)
            with self.lock:
                rooms = list(self.rooms.values())
            for room in rooms:
                with room.lock:
                    if not room.peers:
                        continue
                    now = time.monotonic()
                    dt = max(0.0, min(0.15, now - room.last_tick))
                    room.last_tick = now
                    for peer in list(room.peers):
                        player = peer.player
                        if not player["alive"]:
                            if now >= player["respawnAt"]:
                                self._spawn(player)
                            continue
                        movement = player["input"]
                        magnitude = math.hypot(movement["forward"], movement["strafe"])
                        if magnitude:
                            speed = 4.4 if movement["sprint"] else 3.2
                            dx = (math.cos(player["angle"]) * movement["forward"] +
                                  math.cos(player["angle"] + math.pi / 2) * movement["strafe"]) / max(1, magnitude) * speed * dt
                            dy = (math.sin(player["angle"]) * movement["forward"] +
                                  math.sin(player["angle"] + math.pi / 2) * movement["strafe"]) / max(1, magnitude) * speed * dt
                            if not collides(player["x"] + dx, player["y"]):
                                player["x"] += dx
                            if not collides(player["x"], player["y"] + dy):
                                player["y"] += dy
                        weapon = WEAPONS[player["weapon"]]
                        if movement["fireEdge"] or (movement["fire"] and weapon["automatic"]):
                            self._fire(room, peer)
                        movement["fireEdge"] = False
                        if player["reloadAt"] and now >= player["reloadAt"]:
                            reload_weapon = player["reloadWeapon"]
                            if reload_weapon in player["ammo"]:
                                weapon = WEAPONS[reload_weapon]
                                ammo = player["ammo"][reload_weapon]
                                amount = min(weapon["mag"] - ammo["mag"], ammo["reserve"])
                                ammo["mag"] += amount
                                ammo["reserve"] -= amount
                            player["reloadAt"] = 0.0
                            player["reloadWeapon"] = None
                    if room.mode == "dom":
                        self._tick_domination(room, dt, now)
                    if now - room.started >= MATCH_SECONDS:
                        self._end(room, 0 if room.score[0] > room.score[1] else 1 if room.score[1] > room.score[0] else -1)
                    self.broadcast(room)

    def _tick_domination(self, room: Room, dt: float, now: float) -> None:
        for site in room.sites:
            present = [peer.player for peer in room.peers
                       if peer.player["alive"] and math.hypot(peer.player["x"] - site["x"], peer.player["y"] - site["y"]) <= 2.15]
            teams = {player["team"] for player in present}
            if len(teams) == 1 and present:
                team = next(iter(teams))
                if site["owner"] != team:
                    site["progress"] = min(1.0, site["progress"] + dt * 0.18)
                    site["capturing"] = team
                    if site["progress"] >= 1:
                        site["owner"] = team
                        self.event(room, {"event": "capture", "site": site["id"], "team": team})
                else:
                    site["progress"] = min(1.0, site["progress"] + dt * 0.08)
            elif len(teams) > 1:
                site["progress"] = max(0.0, site["progress"] - dt * 0.06)
        if now - room.last_dom_score >= 3.0:
            room.last_dom_score = now
            for site in room.sites:
                if site["owner"] in (0, 1):
                    room.score[site["owner"]] += 1
            if max(room.score) >= SCORE_LIMIT:
                self._end(room, 0 if room.score[0] > room.score[1] else 1)

    def _end(self, room: Room, winner: int) -> None:
        if room.ended:
            return
        room.ended = True
        self.event(room, {"event": "match-end", "winner": winner})
        self.broadcast(room)

    @staticmethod
    def event(room: Room, event: dict) -> None:
        for peer in list(room.peers):
            peer.send({"type": "event", **event})

    @staticmethod
    def broadcast(room: Room) -> None:
        players = []
        for peer in room.peers:
            player = peer.player
            players.append({
                "id": player["id"], "name": player["name"], "team": player["team"],
                "x": player["x"], "y": player["y"], "angle": player["angle"],
                "health": player["health"], "alive": player["alive"],
                "kills": player["kills"], "deaths": player["deaths"],
                "weapon": player["weapon"], "weapons": player["weapons"], "attachments": player["attachments"],
                "ammo": player["ammo"], "reloadAt": player["reloadAt"]
            })
        packet = {"type": "snapshot", "players": players, "score": room.score,
                  "sites": room.sites, "mode": room.mode, "started": True, "ended": room.ended,
                  "timeLeft": max(0, MATCH_SECONDS - (time.monotonic() - room.started)),
                  "winner": 0 if room.score[0] > room.score[1] else 1 if room.score[1] > room.score[0] else -1}
        for peer in list(room.peers):
            peer.send(packet)

    def disconnect(self, peer: Peer) -> None:
        with self.lock:
            room = peer.room
            if room is None:
                peer.closed = True
                return
            with room.lock:
                if peer in room.peers:
                    room.peers.remove(peer)
                peer.closed = True
                peer.room = None
                peer.player = None
                if room.peers:
                    self.broadcast(room)
                else:
                    self.rooms.pop(room.code, None)


HUB = MatchHub()


def read_frame(connection: socket.socket) -> tuple[int, bytes] | None:
    def exact(size: int) -> bytes | None:
        result = bytearray()
        while len(result) < size:
            chunk = connection.recv(size - len(result))
            if not chunk:
                return None
            result.extend(chunk)
        return bytes(result)

    first = exact(2)
    if first is None:
        return None
    opcode, length = first[0] & 0x0F, first[1] & 0x7F
    if first[1] & 0x80 == 0:
        raise ValueError("client websocket frames must be masked")
    if length == 126:
        data = exact(2)
        if data is None:
            return None
        length = struct.unpack("!H", data)[0]
    elif length == 127:
        data = exact(8)
        if data is None:
            return None
        length = struct.unpack("!Q", data)[0]
    if length > 65535:
        raise ValueError("websocket message exceeds 64 KiB")
    mask = exact(4)
    if mask is None:
        return None
    chunks = bytearray()
    remaining = length
    while remaining:
        chunk = exact(remaining)
        if chunk is None:
            return None
        chunks.extend(chunk)
        remaining = 0
    for index in range(length):
        chunks[index] ^= mask[index & 3]
    return opcode, bytes(chunks)


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "IronfallHost/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[http] {self.address_string()} {format_string % args}")

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/ws":
            self._websocket()
            return
        relative = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        if relative.startswith(".") or ".." in Path(relative).parts:
            self.send_error(404)
            return
        target = (ROOT / relative).resolve()
        allowed = {ROOT / "index.html", ROOT / "style.css", ROOT / "map.json",
                   ROOT / "weapons.json", ROOT / "src" / "main.js"}
        if target not in allowed or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _websocket(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            self.send_error(400, "WebSocket upgrade required")
            return
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
        ).digest()).decode("ascii")
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        peer = Peer(self.connection, self.client_address)
        try:
            self.connection.settimeout(40)
            while not peer.closed:
                frame = read_frame(self.connection)
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 8:
                    break
                if opcode == 9:
                    peer.socket.sendall(bytes((0x8A, len(payload))) + payload)
                    continue
                if opcode != 1:
                    continue
                if len(payload) > 16384:
                    raise ValueError("message exceeds 16 KiB")
                packet = json.loads(payload.decode("utf-8"))
                if isinstance(packet, dict):
                    HUB.receive(peer, packet)
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError) as error:
            if not isinstance(error, OSError):
                print(f"[ws] rejected {self.address_string()}: {error}")
        finally:
            HUB.disconnect(peer)
            try:
                peer.socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def main() -> None:
    host = os.environ.get("IRONFALL_HOST", "0.0.0.0")
    port = int(os.environ.get("IRONFALL_PORT", "8080"))
    try:
        server = ThreadingHTTPServer((host, port), RequestHandler)
    except OSError as error:
        raise SystemExit(f"Could not bind {host}:{port}: {error}") from error
    server.daemon_threads = True
    print(f"Ironfall host listening at http://{host}:{port}")
    print("Open the displayed address locally; share a publicly reachable host address for internet play.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Ironfall host.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
