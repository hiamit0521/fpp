# Ironfall Island

An original, dependency-free, browser-playable first-person combat game. It uses hand-built raycast rendering, original fictional weapons and a primitive-art island map. There are no downloaded game assets or external game services.

## Run locally

1. Install Python 3.10 or newer.
2. Open a terminal in this folder and run `python server.py` on Windows, or `python3 server.py` on macOS/Linux.
3. Open `http://localhost:8080` in a modern desktop browser.
4. Choose a loadout and game mode, then select **Practice Match**.

No package installation or build step is required. `npm start` is also available when Node/npm are installed; it runs the same Python host.

## Controls

- **W / A / S / D**: move and strafe; **Shift**: sprint.
- **Mouse**: aim (click the game view to capture the pointer).
- **Space / left mouse button**: fire. Automatic weapons fire while held; semiautomatic weapons fire once per press.
- **1 / 2**: switch between the selected primary and secondary weapons.
- **R**: reload; **Esc**: release the pointer and return to the lobby (leaves a private room).

The match HUD shows health, ammunition, weapon, team score, remaining time, current map zone, and the island minimap. Practice matches include five explicitly local practice bots. Team Deathmatch ends at 20 eliminations or five minutes; Domination scores owned sites every three seconds, with a 20-ticket practice limit. Deaths respawn after a short delay.

## Private rooms and online play

The **Create Room** and **Join** controls connect through the Python WebSocket host in `server.py`; this is real network play, not simulated remote players. Room codes are private join codes, the server assigns balanced teams, simulates movement and respawns, validates hits and ammunition, and owns health, score, capture progress, and match completion. Rooms support up to 12 connected players and end at 30 points or five minutes. Network Domination awards a point every three seconds for each held site. Network rooms contain only connected humans—bots are only in the explicitly offline practice mode.

For a friend on the same LAN, run the server on a machine reachable by both players and have the friend open `http://<host-LAN-IP>:8080`. Allow inbound TCP port 8080 through the host firewall. For internet play, deploy the host on a publicly reachable machine and allow/forward TCP port 8080, then share `http://<public-host>:8080` and the room code. The host must remain running for the match. There is no matchmaking, relay, account service, or automatic NAT traversal. HTTPS deployments need a TLS reverse proxy that also forwards WebSocket upgrades. The optional `?server=http://host:8080` or `?server=https://host` page parameter connects to a separate match host; HTTPS pages require a secure (`wss://`) match server.

The server uses plain HTTP/WebSocket by default and has no authentication beyond the room code. Do not expose it to untrusted users without putting it behind appropriate access controls and TLS. Set `IRONFALL_HOST` / `IRONFALL_PORT` to change the bind address and port. The default bind is `0.0.0.0:8080`.

## Map and arsenal

Ironfall Island contains Central City, Industrial Complex, Military Base, Pinebreak Forest, Redstone Outpost, Farmland, Greywater Harbor, Crown Ridge, and Sublevel Facility, with three Domination points: Foundry, Crossroads, and Harbor. Walls and cover separate routes through the island; the two team spawn sets are placed on opposing edges.

All 34 requested fictional weapons have separate damage, firing cadence, magazine, reserve, reload, range, spread, recoil, and firing-mode data in `weapons.json`: Kestrel, Brimstone, Vandal, Longwake, Morrow, Pike; Flicker, Rook, Needle, Torrent, Wisp; Bastion, Hail, Anvil; Breaker, Cinder, Riptide; Northstar, Glasswing, Monolith; Wayfinder, Sable, Meridian; Osprey, Redoubt; Mica, Torch, Relay, Lumen; Grit, Sundown; Field Knife, Rescue Hatchet, Training Baton. Optic, barrel, and grip choices apply real accuracy, range, recoil, and hip-fire modifiers.

## Temporary assets and checks

The world, weapons, player silhouettes, weapon-in-hand view, and minimap are rendered from simple original shapes and colors. These are temporary primitive assets, not production art or licensed third-party assets. There is no audio or dedicated 3D asset bundle.

Run the standard-library unit tests with `python -m unittest discover -s tests -v` (Windows) or `python3 -m unittest discover -s tests -v` (macOS/Linux). Tests cover map collision, spawn/objective reachability, all weapon data, attachment modifiers, authoritative damage, Domination scoring, and respawn.
