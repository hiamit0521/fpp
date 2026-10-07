const [map, weapons] = await Promise.all([
  fetch("../map.json").then(response => response.json()),
  fetch("../weapons.json").then(response => response.json())
]);

const canvas = document.querySelector("#view");
const ctx = canvas.getContext("2d", { alpha: false });
const mini = document.querySelector("#minimap");
const mctx = mini.getContext("2d");
const $ = selector => document.querySelector(selector);
const byName = new Map(weapons.map(weapon => [weapon.name, weapon]));
const byClass = name => weapons.filter(weapon => weapon.class === name);
const secondaryWeapons = weapons.filter(weapon => ["Pistol", "Revolver", "Melee"].includes(weapon.class));
const primaryWeapons = weapons.filter(weapon => !["Pistol", "Revolver", "Melee"].includes(weapon.class));
const loadout = { primary: "Kestrel", secondary: "Mica", optic: "iron", barrel: "standard", grip: "standard" };
const held = new Set();
const clock = () => performance.now() / 1000;
const rand = (min, max) => min + Math.random() * (max - min);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapAngle = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const wallGrid = Array.from({ length: map.height }, () => Array(map.width).fill(false));
for (const [x, y, width, height] of map.walls) {
  for (let ty = Math.floor(y); ty < Math.ceil(y + height); ty++) {
    for (let tx = Math.floor(x); tx < Math.ceil(x + width); tx++) {
      if (wallGrid[ty] && tx >= 0 && tx < map.width) wallGrid[ty][tx] = true;
    }
  }
}
const blocked = (x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y);
  return ix < 0 || iy < 0 || ix >= map.width || iy >= map.height || wallGrid[iy][ix];
};
const lineClear = (x, y, angle, maxRange) => {
  for (let d = 0.12; d < maxRange; d += 0.12) {
    if (blocked(x + Math.cos(angle) * d, y + Math.sin(angle) * d)) return d;
  }
  return maxRange;
};
const weaponStatCache = new Map();
const effectiveWeapon = name => {
  const key = `${name}:${loadout.optic}:${loadout.barrel}:${loadout.grip}`;
  const cached = weaponStatCache.get(key);
  if (cached) return cached;
  const original = byName.get(name) || weapons[0];
  const gun = { ...original };
  if (loadout.optic === "reflex") gun.spread *= .79;
  if (loadout.optic === "scope") { gun.spread *= .48; gun.range *= 1.14; }
  if (loadout.barrel === "comp") gun.recoil *= .72;
  if (loadout.barrel === "suppressor") { gun.range *= .84; gun.quiet = true; }
  if (loadout.grip === "vertical") gun.recoil *= .7;
  if (loadout.grip === "laser") gun.spread *= .73;
  weaponStatCache.set(key, gun);
  return gun;
};
const state = {
  mode: "tdm", online: false, socket: null, match: false, player: null, bots: [],
  players: [], sites: [], score: [0, 0], kills: 0, deaths: 0, start: 0, end: 0,
  lastFrame: 0, netSend: 0, lastShot: 0, reloadUntil: 0, noticeUntil: 0,
  notice: "", hitUntil: 0, deadUntil: 0, selectedSlot: 0, remoteId: null,
  lastDamage: 0, lastFootstep: 0, sessionWinner: null, triggerEdge: false
};

function populateSelectors() {
  const fill = (selector, guns, selected) => {
    const select = $(selector);
    select.replaceChildren(...guns.map(gun => {
      const option = document.createElement("option");
      option.value = gun.name;
      option.textContent = `${gun.name} · ${gun.class}`;
      return option;
    }));
    select.value = selected;
  };
  fill("#primary-select", primaryWeapons, loadout.primary);
  fill("#secondary-select", secondaryWeapons, loadout.secondary);
  for (const [selector, key] of [["#optic-select", "optic"], ["#barrel-select", "barrel"], ["#grip-select", "grip"]]) {
    $(selector).value = loadout[key];
    $(selector).addEventListener("change", () => { loadout[key] = $(selector).value; updateHud(); });
  }
  $("#primary-select").addEventListener("change", () => { loadout.primary = $("#primary-select").value; updateHud(); });
  $("#secondary-select").addEventListener("change", () => { loadout.secondary = $("#secondary-select").value; updateHud(); });
}
populateSelectors();

function currentPlayer() {
  if (state.online) return state.player;
  return state.player;
}
function currentWeaponName() {
  return state.selectedSlot === 0 ? loadout.primary : loadout.secondary;
}
function updateHud() {
  const p = currentPlayer();
  const gun = effectiveWeapon(currentWeaponName());
  $("#weapon-name").textContent = gun.name.toUpperCase();
  $("#weapon-class").textContent = gun.class.toUpperCase();
  const active = [loadout.optic === "iron" ? "" : loadout.optic.toUpperCase(), loadout.barrel === "standard" ? "" : loadout.barrel.toUpperCase(), loadout.grip === "standard" ? "" : loadout.grip.toUpperCase()].filter(Boolean);
  $("#weapon-attachments").textContent = active.length ? active.join("  ·  ") : "STOCK CONFIGURATION";
  if (p) {
    $("#health-value").textContent = Math.max(0, Math.round(p.health));
    $("#health-bar").style.width = `${clamp(p.health, 0, 100)}%`;
    if (state.online) {
      const ammo = p.ammo?.[gun.name] || { mag: gun.mag, reserve: gun.reserve };
      $("#ammo").innerHTML = `${ammo.mag} <small>/ ${ammo.reserve}</small>`;
    } else {
      const ammo = p.ammo[gun.name];
      $("#ammo").innerHTML = `${ammo.mag} <small>/ ${ammo.reserve}</small>`;
    }
  }
  $("#reload-state").textContent = performance.now() / 1000 < state.reloadUntil || state.online && p?.reloadAt > 0 ? "RELOADING…" : "1 / 2  ·  SWITCH";
}

function setNotice(text, seconds = 2) {
  state.notice = text;
  state.noticeUntil = clock() + seconds;
  $("#center-message").textContent = text;
}
function makePlayer(name, team, x, y, angle = 0, isBot = false) {
  const ammo = {};
  for (const gun of weapons) ammo[gun.name] = { mag: gun.mag, reserve: gun.reserve };
  return { id: crypto.randomUUID?.() || Math.random().toString(36).slice(2), name, team, x, y, angle, health: 100, ammo, kills: 0, deaths: 0, isBot, alive: true, fireAt: 0, respawnAt: 0, target: null };
}
function randomSpawn(team) {
  const options = map.spawns[String(team)];
  const spawn = options[Math.floor(Math.random() * options.length)];
  return { x: spawn[0] + rand(-.4, .4), y: spawn[1] + rand(-.4, .4), angle: spawn[2] };
}

async function startPractice() {
  closeSocket();
  state.online = false;
  state.mode = $("#mode-select").value;
  state.players = [];
  state.sites = map.sites.map(site => ({ ...site, owner: -1, progress: 0, capturing: -1 }));
  state.score = [0, 0];
  state.kills = 0;
  state.deaths = 0;
  state.selectedSlot = 0;
  const spawn = randomSpawn(0);
  state.player = makePlayer("YOU", 0, spawn.x, spawn.y, spawn.angle);
  state.bots = [];
  const names = ["Mako", "Silt", "Rivet", "Gale", "Quarry"];
  for (let index = 0; index < names.length; index++) {
    const team = index < 3 ? 1 : 0;
    const position = randomSpawn(team);
    state.bots.push(makePlayer(names[index], team, position.x, position.y, position.angle, true));
  }
  beginMatch();
  setNotice(state.mode === "dom" ? "CAPTURE AND HOLD A, B, OR C" : "ENGAGE THE OPPOSING TEAM", 3);
}

function beginMatch() {
  state.match = true;
  state.start = clock();
  state.end = state.start + 300;
  state.reloadUntil = 0;
  state.lastShot = 0;
  $("#lobby").classList.add("hidden");
  $("#results").classList.add("hidden");
  $("#match-info").innerHTML = `${state.mode === "dom" ? "DOMINATION" : "TEAM DEATHMATCH"} <span>IRONFALL ISLAND</span>`;
  $("#connection span").textContent = state.online ? "PRIVATE ROOM · ONLINE" : "OFFLINE PRACTICE";
  $("#connection i").style.background = state.online ? "#8bdfb0" : "#b0c46a";
  $("#score-caption").textContent = state.mode === "dom" ? "TICKETS" : "ELIMINATIONS";
  state.lastFrame = performance.now();
  updateHud();
  requestAnimationFrame(frame);
}

function endMatch(reason = "") {
  if (!state.match) return;
  state.match = false;
  document.exitPointerLock?.();
  const p = state.player;
  const winTeam = state.score[0] === state.score[1] ? -1 : state.score[0] > state.score[1] ? 0 : 1;
  const result = winTeam < 0 ? "DRAW" : winTeam === (p?.team ?? 0) ? "VICTORY" : "DEFEAT";
  $("#result-title").textContent = reason || result;
  $("#result-detail").textContent = `${state.score[0]} — ${state.score[1]}   ·   ${state.kills} ELIMINATIONS   ·   ${state.deaths} DEATHS${state.online ? "" : "   ·   PRACTICE MATCH"}`;
  $("#results").classList.remove("hidden");
}

async function connectRoom(code, create = false) {
  $("#lobby-error").textContent = "";
  closeSocket();
  const host = new URLSearchParams(location.search).get("server");
  const endpoint = host
    ? `${host.replace(/^http/, "ws").replace(/\/$/, "")}/ws`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  const socket = new WebSocket(endpoint);
  state.socket = socket;
  $("#lobby-error").textContent = "CONNECTING TO MATCH HOST…";
  const timeout = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.close();
      $("#lobby-error").textContent = "HOST NOT REACHABLE. Check the server address and network.";
    }
  }, 5000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    socket.send(JSON.stringify({ type: create ? "create" : "join", code, name: "Operator", mode: $("#mode-select").value,
      loadout: { weapons: [loadout.primary, loadout.secondary], optic: loadout.optic, barrel: loadout.barrel, grip: loadout.grip } }));
  });
  socket.addEventListener("message", event => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.type === "error") {
      $("#lobby-error").textContent = packet.message;
      closeSocket();
      return;
    }
    if (packet.type === "room") {
      state.remoteId = packet.playerId;
      state.aimAngle = null;
      $("#room-code").value = packet.code;
      $("#lobby-error").textContent = `ROOM ${packet.code} READY · SHARE THIS CODE WITH FRIENDS`;
      $("#room-hint").textContent = "Joining with this code puts both players in the same authoritative match.";
      state.online = true;
      state.mode = packet.mode;
      return;
    }
    if (packet.type === "snapshot") applySnapshot(packet);
    if (packet.type === "event") {
      if (packet.event === "hit" && packet.target === state.remoteId) showHit();
      if (packet.event === "kill" && packet.target === state.remoteId) setNotice("ELIMINATED", 1.6);
      if (packet.event === "capture") setNotice(`${packet.site} CAPTURED`, 1.5);
      if (packet.event === "match-end") endMatch();
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket && state.online && state.match) {
      state.online = false;
      state.match = false;
      $("#lobby").classList.remove("hidden");
      $("#lobby-error").textContent = "DISCONNECTED FROM MATCH HOST.";
      $("#connection span").textContent = "OFFLINE PRACTICE";
      $("#connection i").style.background = "#b0c46a";
    }
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    $("#lobby-error").textContent = "COULD NOT CONNECT. Run the host server and check its address.";
  });
}
function applySnapshot(packet) {
  const prior = state.player;
  state.players = packet.players || [];
  const self = state.players.find(player => player.id === state.remoteId) || prior;
  if (self) {
    if (state.aimAngle === null || state.aimAngle === undefined) state.aimAngle = self.angle;
    self.angle = state.aimAngle;
  }
  state.player = self;
  state.score = packet.score || [0, 0];
  state.sites = packet.sites || state.sites;
  state.timeLeft = packet.timeLeft;
  if (packet.mode) state.mode = packet.mode;
  if (packet.started && !state.match) beginMatch();
  if (state.player) {
    if (prior && state.player.health < prior.health) flashDamage();
    if (prior && prior.health > 0 && state.player.health <= 0) state.deaths++;
    updateHud();
  }
  if (packet.ended && state.match) endMatch();
}
function closeSocket() {
  if (state.socket) {
    const old = state.socket;
    state.socket = null;
    old.onclose = null;
    old.close();
  }
  state.online = false;
  $("#connection span").textContent = "OFFLINE PRACTICE";
  $("#connection i").style.background = "#b0c46a";
}

function respawn(player) {
  const spawn = randomSpawn(player.team);
  player.x = spawn.x; player.y = spawn.y; player.angle = spawn.angle;
  player.health = 100; player.alive = true;
  if (player === state.player) setNotice("DEPLOYED", 1);
}
function collides(x, y, radius = .22) {
  return blocked(x - radius, y) || blocked(x + radius, y) || blocked(x, y - radius) || blocked(x, y + radius);
}
function move(player, dx, dy) {
  if (!collides(player.x + dx, player.y)) player.x += dx;
  if (!collides(player.x, player.y + dy)) player.y += dy;
}
function flashDamage() {
  $("#damage-flash").style.opacity = ".72";
  setTimeout(() => { $("#damage-flash").style.opacity = "0"; }, 100);
}
function showHit() {
  const hit = $("#hit-marker");
  hit.style.opacity = "1";
  state.hitUntil = clock() + .1;
}
function killPlayer(victim, killer) {
  victim.health = 0; victim.alive = false; victim.respawnAt = clock() + 3.2; victim.deaths++;
  killer.kills++;
  state.score[killer.team]++;
  if (victim === state.player) { state.deaths++; setNotice("ELIMINATED\nRESPAWNING…", 3); }
  if (killer === state.player) { state.kills++; setNotice("ELIMINATION", 1); }
}
function fireLocal(shooter, playerWeapon = true) {
  const name = playerWeapon ? currentWeaponName() : shooter.weapon || (shooter.team === 0 ? "Morrow" : "Rook");
  const gun = playerWeapon ? effectiveWeapon(name) : byName.get(name);
  const ammo = shooter.ammo[name];
  const now = clock();
  if (!shooter.alive || now < shooter.fireAt || now < state.reloadUntil && playerWeapon) return;
  if (!ammo || ammo.mag <= 0) {
    if (playerWeapon) reload();
    else if (ammo && ammo.reserve > 0) { ammo.reserve -= gun.mag; ammo.mag = gun.mag; shooter.fireAt = now + gun.reload; }
    return;
  }
  shooter.fireAt = now + gun.rate;
  ammo.mag--;
  const pellets = gun.pellets || 1;
  let hit = false;
  for (let pellet = 0; pellet < pellets; pellet++) {
    const inaccuracy = gun.spread + gun.recoil * .35;
    const direction = shooter.angle + rand(-inaccuracy, inaccuracy) * (loadout.optic === "scope" && playerWeapon ? .58 : 1);
    const wallDistance = lineClear(shooter.x, shooter.y, direction, gun.range);
    const candidates = state.bots.concat(state.player).filter(target => target !== shooter && target.alive && target.team !== shooter.team);
    let target = null, nearest = wallDistance;
    for (const candidate of candidates) {
      const dx = candidate.x - shooter.x, dy = candidate.y - shooter.y;
      const along = dx * Math.cos(direction) + dy * Math.sin(direction);
      const side = Math.abs(dx * Math.sin(direction) - dy * Math.cos(direction));
      if (along > 0 && along < nearest && side < .28 + along * .009) {
        nearest = along;
        target = candidate;
      }
    }
    if (target) {
      const damage = Math.max(1, gun.damage * (gun.pellets ? 1 : 1));
      target.health -= damage;
      hit = true;
      if (target.health <= 0) killPlayer(target, shooter);
    }
  }
  if (hit && playerWeapon) showHit();
  if (playerWeapon) updateHud();
}
function reload() {
  if (!state.match || state.online) {
    if (state.online) state.socket?.send(JSON.stringify({ type: "reload" }));
    return;
  }
  const gun = effectiveWeapon(currentWeaponName());
  const ammo = state.player.ammo[gun.name];
  if (!ammo || ammo.mag >= gun.mag || ammo.reserve <= 0 || clock() < state.reloadUntil) return;
  if (gun.class === "Melee") return;
  state.reloadUntil = clock() + gun.reload;
  setTimeout(() => {
    if (!state.match || state.online) return;
    const amount = Math.min(gun.mag - ammo.mag, ammo.reserve);
    ammo.mag += amount; ammo.reserve -= amount; updateHud();
  }, gun.reload * 1000);
}
function changeWeapon(slot) {
  state.selectedSlot = slot;
  state.reloadUntil = 0;
  if (state.online) state.socket?.send(JSON.stringify({ type: "weapon", name: currentWeaponName() }));
  updateHud();
}

function updateBots(dt) {
  const p = state.player;
  if (!p?.alive) return;
  for (const bot of state.bots) {
    if (!bot.alive) {
      if (clock() >= bot.respawnAt) respawn(bot);
      continue;
    }
    const enemy = p.alive && p.team !== bot.team ? p : state.bots.find(other => other.alive && other.team !== bot.team);
    if (!enemy) continue;
    const dx = enemy.x - bot.x, dy = enemy.y - bot.y, d = Math.hypot(dx, dy);
    const direct = Math.atan2(dy, dx);
    const visible = d < 16 && lineClear(bot.x, bot.y, direct, d) >= d - .2;
    if (visible) {
      bot.angle = direct + rand(-.075, .075);
      if (d < 14 && clock() >= bot.fireAt) {
        const weapon = bot.weapon || (bot.team === 0 ? "Kestrel" : "Vandal");
        bot.weapon = weapon;
        fireLocal(bot, false);
      }
    } else {
      bot.angle = direct;
      const speed = (bot.team === 1 ? 1.3 : .85) * dt;
      move(bot, Math.cos(direct) * speed, Math.sin(direct) * speed);
    }
  }
}
function updateOfflineDomination(dt) {
  if (state.mode !== "dom") return;
  for (const site of state.sites) {
    const present = [state.player, ...state.bots].filter(player => player.alive && dist(player, site) < 2.15);
    const teams = new Set(present.map(player => player.team));
    if (teams.size === 1 && present.length) {
      const team = present[0].team;
      if (site.owner !== team) {
        site.progress = clamp((site.progress || 0) + dt * .19, 0, 1);
        site.capturing = team;
        if (site.progress >= 1) { site.owner = team; setNotice(`${site.id} CAPTURED`, 1.2); }
      } else site.progress = Math.min(1, (site.progress || 1) + dt * .08);
    } else if (teams.size > 1) site.progress = Math.max(0, (site.progress || 0) - dt * .1);
  }
  if (clock() - state.lastShot > 3) {
    for (const site of state.sites) if (site.owner >= 0) state.score[site.owner]++;
    state.lastShot = clock();
  }
}
function updateLocal(dt) {
  const p = state.player;
  if (!p) return;
  if (!p.alive) {
    if (clock() >= p.respawnAt) respawn(p);
    return;
  }
  const forward = (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0);
  const strafe = (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0);
  const speed = held.has("ShiftLeft") ? 4.4 : 3.2;
  const magnitude = Math.hypot(forward, strafe) || 1;
  move(p, (Math.cos(p.angle) * forward + Math.cos(p.angle + Math.PI / 2) * strafe) / magnitude * speed * dt,
    (Math.sin(p.angle) * forward + Math.sin(p.angle + Math.PI / 2) * strafe) / magnitude * speed * dt);
  const triggerHeld = held.has("Space") || held.has("Mouse0");
  const trigger = triggerHeld && (effectiveWeapon(currentWeaponName()).automatic || state.triggerEdge);
  if (trigger) fireLocal(p);
  state.triggerEdge = false;
  updateBots(dt);
  updateOfflineDomination(dt);
  if (state.score.some(score => score >= 20)) endMatch();
}
function updateNetwork(dt) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (clock() - state.netSend > .05) {
    state.netSend = clock();
    state.socket.send(JSON.stringify({
      type: "input", forward: (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0),
      strafe: (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0),
      sprint: held.has("ShiftLeft"), fire: held.has("Space") || held.has("Mouse0"), angle: state.aimAngle ?? state.player?.angle ?? 0
    }));
  }
}
function updateHudScores() {
  $("#blue-score").textContent = state.score[0] || 0;
  $("#red-score").textContent = state.score[1] || 0;
  const remaining = state.online && Number.isFinite(state.timeLeft)
    ? state.timeLeft : Math.max(0, state.end - clock());
  const minutes = Math.floor(remaining / 60).toString().padStart(2, "0");
  const seconds = Math.floor(remaining % 60).toString().padStart(2, "0");
  $("#score-caption").textContent = `${state.mode === "dom" ? "TICKETS" : "ELIMINATIONS"} · ${minutes}:${seconds}`;
  const p = state.player;
  if (p) {
    const nearest = map.landmarks.reduce((best, land) => dist(p, land) < dist(p, best) ? land : best, map.landmarks[0]);
    $("#match-info span").textContent = dist(p, nearest) < 7 ? nearest.name.toUpperCase() : "IRONFALL ISLAND";
  }
}

function drawScene() {
  if (!state.player) return;
  const p = state.player;
  const width = canvas.width, height = canvas.height;
  const horizon = Math.floor(height * .49);
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#4d6261"); sky.addColorStop(1, "#a3a586");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, width, horizon);
  const floor = ctx.createLinearGradient(0, horizon, 0, height);
  floor.addColorStop(0, "#77745e"); floor.addColorStop(1, "#343d34");
  ctx.fillStyle = floor; ctx.fillRect(0, horizon, width, height - horizon);
  const focal = width * .58;
  const stride = width > 900 ? 2 : 1;
  for (let x = 0; x < width; x += stride) {
    const camera = (2 * x / width - 1);
    const angle = p.angle + Math.atan(camera * width / (2 * focal));
    const cosineFix = Math.cos(angle - p.angle);
    let distance = .15, hit = false;
    while (distance < 30) {
      const wx = p.x + Math.cos(angle) * distance, wy = p.y + Math.sin(angle) * distance;
      if (blocked(wx, wy)) { hit = true; break; }
      distance += .035;
    }
    const corrected = Math.max(.15, distance * cosineFix);
    const wallHeight = Math.min(height * 1.5, height / corrected * .76);
    const y = horizon - wallHeight / 2;
    const cellx = Math.floor(p.x + Math.cos(angle) * distance);
    const celly = Math.floor(p.y + Math.sin(angle) * distance);
    const border = cellx !== Math.floor(p.x + Math.cos(angle) * (distance - .04));
    let shade = clamp(1 - corrected / 28, .2, .88) * (border ? .82 : 1);
    const wall = hit ? wallGrid[celly]?.[cellx] : false;
    const wallColor = wall ? [109, 113, 99] : [130, 131, 108];
    const hitX = (p.x + Math.cos(angle) * distance) % 1;
    const hitY = (p.y + Math.sin(angle) * distance) % 1;
    if (Math.min(hitX, 1-hitX, hitY, 1-hitY) < .035) shade *= .68;
    ctx.fillStyle = `rgb(${Math.floor(wallColor[0]*shade)},${Math.floor(wallColor[1]*shade)},${Math.floor(wallColor[2]*shade)})`;
    ctx.fillRect(x, y, stride + 1, wallHeight);
    const depthShade = Math.floor((1 - shade) * 34);
    ctx.fillStyle = `rgba(15,20,18,${Math.min(.45, depthShade / 70)})`;
    ctx.fillRect(x, y + wallHeight - 2, stride + 1, 2);
  }
  drawSprites(p, width, height, focal, horizon);
  drawWeapon(width, height);
}
function drawSprites(p, width, height, focal, horizon) {
  const actors = (state.online ? state.players : [state.player, ...state.bots]).filter(other => other.id !== p.id && other.alive);
  for (const actor of actors) {
    const dx = actor.x - p.x, dy = actor.y - p.y;
    const d = Math.hypot(dx, dy);
    let delta = wrapAngle(Math.atan2(dy, dx) - p.angle);
    if (Math.abs(delta) > .95 || d < .3) continue;
    const wall = lineClear(p.x, p.y, Math.atan2(dy, dx), d);
    if (wall < d - .2) continue;
    const screenX = width / 2 + Math.tan(delta) * focal;
    const scale = Math.min(height * .64, height / d * .52);
    const top = horizon - scale / 2;
    const w = Math.max(5, scale * .38);
    const color = actor.team === 0 ? "#78afd0" : "#d6785e";
    ctx.fillStyle = "#080d0dcc";
    ctx.fillRect(screenX - w/2 - 2, top - 8, w + 4, 5);
    ctx.fillStyle = actor.team === 0 ? "#9bc7ef" : "#fa947c";
    ctx.fillRect(screenX - w/2 - 1, top - 7, (w + 2) * clamp(actor.health / 100, 0, 1), 3);
    ctx.fillStyle = color;
    ctx.fillRect(screenX - w * .38, top + scale * .25, w * .76, scale * .62);
    ctx.fillStyle = "#d3c3a1";
    ctx.beginPath(); ctx.arc(screenX, top + scale * .19, w * .23, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#15201f";
    ctx.fillRect(screenX + w*.12, top + scale*.44, w*.52, Math.max(2, scale*.045));
  }
  for (const site of state.sites || []) {
    const dx=site.x-p.x,dy=site.y-p.y,d=Math.hypot(dx,dy),angle=wrapAngle(Math.atan2(dy,dx)-p.angle);
    if (Math.abs(angle)>.75 || d<1) continue;
    const sx=width/2+Math.tan(angle)*focal, sy=horizon-height/d*.32;
    const color=site.owner===0?"#8dc9ed":site.owner===1?"#f28a70":"#e8e2bd";
    ctx.fillStyle=color;ctx.fillRect(sx-2,sy,4,Math.max(12,height/d*.34));
    ctx.font=`bold ${Math.max(10,Math.min(18, height/d*.075))}px monospace`;ctx.textAlign="center";
    ctx.fillText(site.id,sx,sy-4);
  }
}
function drawWeapon(width, height) {
  const recoil = performance.now() / 1000 < state.player.fireAt - .08 ? 10 : 0;
  ctx.save();
  ctx.translate(width * .72, height * .84 + recoil);
  ctx.rotate(-.04);
  ctx.fillStyle = "#141a18"; ctx.fillRect(0, 0, width * .32, height * .15);
  ctx.fillStyle = "#56584d"; ctx.fillRect(width*.03,-height*.035,width*.27,height*.07);
  ctx.fillStyle = "#9a9675"; ctx.fillRect(width*.18,-height*.02,width*.19,height*.027);
  ctx.fillStyle = "#272d29"; ctx.fillRect(width*.06,height*.07,width*.07,height*.12);
  ctx.restore();
  ctx.strokeStyle="#eff0de";ctx.lineWidth=2;ctx.globalAlpha=.8;
  ctx.beginPath();ctx.moveTo(width/2-7,height/2);ctx.lineTo(width/2-2,height/2);ctx.moveTo(width/2+2,height/2);ctx.lineTo(width/2+7,height/2);ctx.moveTo(width/2,height/2-7);ctx.lineTo(width/2,height/2-2);ctx.moveTo(width/2,height/2+2);ctx.lineTo(width/2,height/2+7);ctx.stroke();ctx.globalAlpha=1;
}
function drawMiniMap() {
  const w=mini.width,h=mini.height, sx=w/map.width,sy=h/map.height;
  mctx.fillStyle="#26312d";mctx.fillRect(0,0,w,h);
  for(const [x,y,ww,hh] of map.walls){mctx.fillStyle="#59655a";mctx.fillRect(x*sx,y*sy,ww*sx,hh*sy)}
  for(const land of map.landmarks){mctx.fillStyle=land.color;mctx.globalAlpha=.62;mctx.font="6px monospace";mctx.fillText(land.name.toUpperCase(),land.x*sx-13,land.y*sy-4);mctx.globalAlpha=1}
  for(const site of state.sites||map.sites){mctx.beginPath();mctx.arc(site.x*sx,site.y*sy,5,0,Math.PI*2);mctx.fillStyle=site.owner===0?"#90c8ef":site.owner===1?"#fa8a72":"#ddd9c2";mctx.fill();mctx.fillStyle="#111";mctx.font="bold 7px monospace";mctx.textAlign="center";mctx.fillText(site.id,site.x*sx,site.y*sy+2.5)}
  const players=state.online?state.players:[state.player,...state.bots];
  for(const player of players){if(!player?.alive)continue;mctx.beginPath();mctx.arc(player.x*sx,player.y*sy,player.id===state.player?.id?3.3:2.2,0,Math.PI*2);mctx.fillStyle=player.team===0?"#9bc7ef":"#fa947c";mctx.fill()}
}
function frame(timestamp) {
  if (!state.match) return;
  const dt = Math.min(.06, Math.max(0, (timestamp - state.lastFrame) / 1000));
  state.lastFrame = timestamp;
  if (state.online) updateNetwork(dt); else updateLocal(dt);
  drawScene();
  drawMiniMap();
  updateHudScores();
  if (clock() >= state.end && !state.online) endMatch("TIME LIMIT");
  if (clock() > state.noticeUntil && state.notice) { state.notice = ""; $("#center-message").textContent = ""; }
  if (clock() > state.hitUntil) $("#hit-marker").style.opacity = "0";
  requestAnimationFrame(frame);
}

function rotate(delta) {
  if (state.player) {
    state.player.angle = wrapAngle(state.player.angle + delta);
    if (state.online) state.aimAngle = state.player.angle;
  }
}
window.addEventListener("keydown", event => {
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
  if (event.code === "Escape" && state.match) {
    state.match = false;
    if (state.online) {
      closeSocket();
      $("#lobby-error").textContent = "LEFT PRIVATE ROOM.";
    }
    document.exitPointerLock?.();
    $("#lobby").classList.remove("hidden");
    return;
  }
  if (event.code === "Space" && !event.repeat) state.triggerEdge = true;
  held.add(event.code);
  if (event.code === "Digit1") changeWeapon(0);
  if (event.code === "Digit2") changeWeapon(1);
  if (event.code === "KeyR") reload();
});
window.addEventListener("keyup", event => {
  held.delete(event.code);
  if ((event.code === "Space" || event.code === "Mouse0") && state.online && state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "input", forward: (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0), strafe: (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0), sprint: held.has("ShiftLeft"), fire: held.has("Space") || held.has("Mouse0"), angle: state.aimAngle ?? state.player?.angle ?? 0 }));
  }
});
canvas.addEventListener("mousedown", event => {
  if (event.button === 0 && state.match) {
    state.triggerEdge = true;
    held.add("Mouse0");
  }
});
window.addEventListener("mouseup", event => {
  if (event.button === 0) {
    held.delete("Mouse0");
    if (state.online && state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "input", forward: (held.has("KeyW") ? 1 : 0) - (held.has("KeyS") ? 1 : 0), strafe: (held.has("KeyD") ? 1 : 0) - (held.has("KeyA") ? 1 : 0), sprint: held.has("ShiftLeft"), fire: held.has("Space"), angle: state.aimAngle ?? state.player?.angle ?? 0 }));
    }
  }
});
canvas.addEventListener("click", () => {
  if (state.match && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
document.addEventListener("mousemove", event => {
  if (document.pointerLockElement === canvas && state.match) rotate(event.movementX * .0022);
});
document.addEventListener("pointerlockchange", () => {
  if (state.match && !state.online && !document.pointerLockElement) setNotice("CLICK TO RESUME AIM", 3);
});
window.addEventListener("blur", () => held.clear());

$("#practice-button").addEventListener("click", startPractice);
$("#create-room-button").addEventListener("click", () => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  connectRoom(code, true);
});
$("#join-room-button").addEventListener("click", () => {
  const code = $("#room-code").value.trim().toUpperCase();
  if (!code) { $("#lobby-error").textContent = "ENTER THE ROOM CODE SHARED BY THE HOST."; return; }
  connectRoom(code, false);
});
$("#room-code").addEventListener("keydown", event => { if (event.key === "Enter") $("#join-room-button").click(); });
$("#return-button").addEventListener("click", () => {
  closeSocket();
  state.match = false;
  state.player = null;
  state.bots = [];
  $("#results").classList.add("hidden");
  $("#lobby").classList.remove("hidden");
});

function resize() {
  const ratio = Math.min(1.4, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * ratio);
  canvas.height = Math.round(canvas.clientHeight * ratio);
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener("resize", resize);
resize();
