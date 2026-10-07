import unittest
from collections import deque

import server


class WeaponAndMapTests(unittest.TestCase):
    def test_all_requested_weapons_have_distinct_tuning(self):
        expected = {
            "Kestrel", "Brimstone", "Vandal", "Longwake", "Morrow", "Pike",
            "Flicker", "Rook", "Needle", "Torrent", "Wisp",
            "Bastion", "Hail", "Anvil", "Breaker", "Cinder", "Riptide",
            "Northstar", "Glasswing", "Monolith", "Wayfinder", "Sable", "Meridian",
            "Osprey", "Redoubt", "Mica", "Torch", "Relay", "Lumen", "Grit", "Sundown",
            "Field Knife", "Rescue Hatchet", "Training Baton",
        }
        self.assertEqual(set(server.WEAPONS), expected)
        for weapon in server.WEAPONS.values():
            self.assertGreater(weapon["damage"], 0)
            self.assertGreater(weapon["rate"], 0)
            self.assertGreater(weapon["mag"], 0)
            self.assertGreater(weapon["range"], 0)
        signatures = {(weapon["damage"], weapon["rate"], weapon["mag"], weapon["range"],
                       weapon["spread"], weapon["recoil"]) for weapon in server.WEAPONS.values()}
        self.assertEqual(len(signatures), len(expected))

    def test_spawn_points_are_clear_and_sites_are_three_distinct_points(self):
        for spawns in server.MAP["spawns"].values():
            for x, y, _ in spawns:
                self.assertFalse(server.collides(x, y))
        self.assertEqual(len(server.MAP["sites"]), 3)
        self.assertEqual(len({site["id"] for site in server.MAP["sites"]}), 3)
        expected_zones = {
            "Central City", "Industrial Complex", "Military Base", "Pinebreak Forest",
            "Redstone Outpost", "Farmland", "Greywater Harbor", "Crown Ridge", "Sublevel Facility",
        }
        self.assertEqual({land["name"] for land in server.MAP["landmarks"]}, expected_zones)

    def test_all_objectives_are_reachable_from_team_spawn(self):
        step = 0.5
        start = (4, 4)
        queue = deque([start])
        visited = {start}
        while queue:
            x, y = queue.popleft()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                point = (x + dx, y + dy)
                if point in visited or server.collides(point[0] * step, point[1] * step):
                    continue
                visited.add(point)
                queue.append(point)
        for site in server.MAP["sites"]:
            closest = min(((x * step - site["x"]) ** 2 + (y * step - site["y"]) ** 2) ** 0.5
                          for x, y in visited)
            self.assertLess(closest, 2.15, site["id"])

    def test_walls_block_movement_and_sight(self):
        self.assertTrue(server.collides(5.5, 4.5))
        self.assertFalse(server.collides(2, 2))
        self.assertLess(server.line_distance(4, 4, 0, 5), 5)

    def test_equipped_attachments_modify_authoritative_weapon_stats(self):
        player = server.create_player("Tester", 0, {
            "weapons": ["Kestrel", "Mica"], "optic": "scope",
            "barrel": "comp", "grip": "vertical"
        })
        base = server.WEAPONS["Kestrel"]
        tuned = server.weapon_stats(player)
        self.assertAlmostEqual(tuned["spread"], base["spread"] * 0.48)
        self.assertAlmostEqual(tuned["range"], base["range"] * 1.14)
        self.assertAlmostEqual(tuned["recoil"], base["recoil"] * 0.72 * 0.7)


class AuthoritativeMatchTests(unittest.TestCase):
    def test_player_loadout_is_limited_to_known_weapons(self):
        player = server.create_player("  Ada  ", 0, ["Unknown", {"bad": "value"}])
        self.assertEqual(player["name"], "Ada")
        self.assertEqual(player["weapons"], ["Kestrel", "Mica"])
        self.assertEqual(player["health"], 100)

    def test_hitscan_updates_only_the_server_owned_victim_state(self):
        class LocalPeer:
            def __init__(self, player):
                self.player = player
                self.sent = []

            def send(self, packet):
                self.sent.append(packet)

        room = server.Room("ABC123", "tdm")
        attacker = server.create_player("Attacker", 0, ["Kestrel", "Mica"])
        victim = server.create_player("Victim", 1, ["Kestrel", "Mica"])
        attacker.update(x=10.0, y=10.0, angle=0.0, fireAt=0.0)
        victim.update(x=12.0, y=10.0, health=100)
        attacker["ammo"]["Kestrel"]["mag"] = 3
        first, second = LocalPeer(attacker), LocalPeer(victim)
        room.peers.extend((first, second))
        server.HUB._fire(room, first, force=True)
        self.assertEqual(victim["health"], 74)
        self.assertEqual(attacker["ammo"]["Kestrel"]["mag"], 2)
        self.assertTrue(any(packet.get("type") == "event" and packet.get("event") == "hit"
                            for packet in first.sent))

    def test_domination_capture_and_owned_site_scoring(self):
        class LocalPeer:
            def __init__(self, player):
                self.player = player
                self.sent = []

            def send(self, packet):
                self.sent.append(packet)

        room = server.Room("DOM123", "dom")
        site = room.sites[0]
        player = server.create_player("Defender", 0, ["Kestrel", "Mica"])
        player.update(x=site["x"], y=site["y"])
        peer = LocalPeer(player)
        room.peers.append(peer)
        room.last_dom_score = room.started + 6.0
        server.HUB._tick_domination(room, 6.0, room.started + 6.0)
        self.assertEqual(site["owner"], 0)
        self.assertTrue(any(packet.get("event") == "capture" for packet in peer.sent))
        server.HUB._tick_domination(room, 0.1, room.started + 10.0)
        self.assertEqual(room.score[0], 1)

    def test_respawn_restores_health_and_ammunition(self):
        player = server.create_player("Downed", 0, ["Kestrel", "Mica"])
        player.update(health=0, alive=False)
        player["ammo"]["Kestrel"]["mag"] = 0
        server.HUB._spawn(player)
        self.assertTrue(player["alive"])
        self.assertEqual(player["health"], 100)
        self.assertEqual(player["ammo"]["Kestrel"]["mag"], server.WEAPONS["Kestrel"]["mag"])


if __name__ == "__main__":
    unittest.main()
