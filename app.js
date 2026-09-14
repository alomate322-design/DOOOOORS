// Панель расширения «Двери». Только интерфейс: вся игровая логика в background.js.

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { collectDoors } from "./geometry.js";
import { fmtMod } from "./dice.js";
import { ICON_KEY, PLAYERS_KEY, loadDC, saveDC, loadLocalRoll, saveLocalRoll } from "./store.js";

let isGM = false, myId = null, players = {}, doors = [], maps = [];
const $ = (id) => document.getElementById(id);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c;
  if (x !== undefined) n.textContent = x; return n; };

const logs = [];
function log(text, kind) {
  logs.unshift({ text, kind });
  if (logs.length > 40) logs.pop();
  const box = $("log"); box.innerHTML = "";
  for (const l of logs) {
    const r = el("div", "logrow" + (l.kind ? " " + l.kind : ""));
    r.appendChild(el("b", null, l.text));
    box.appendChild(r);
  }
}

async function refreshDoors() {
  if (!await OBR.scene.isReady()) { doors = []; return; }
  const items = await OBR.scene.items.getItems();
  doors = collectDoors(items.filter((i) => !i.metadata?.[ICON_KEY]));
  const gridDpi = 150;
  maps = items.filter((i) => i.layer === "MAP" && i.image).map((i) => {
    const dpi = i.grid?.dpi || gridDpi;
    const w = (i.image.width / dpi) * gridDpi * (i.scale?.x ?? 1);
    const h = (i.image.height / dpi) * gridDpi * (i.scale?.y ?? 1);
    return { name: (i.name || "карта").slice(0, 22),
             x0: i.position.x, y0: i.position.y, x1: i.position.x + w, y1: i.position.y + h };
  });
}

function renderPlayers() {
  const tb = $("players").querySelector("tbody");
  tb.innerHTML = "";
  for (const [pid, p] of Object.entries(players)) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", null, p.name || pid.slice(0, 8)));
    for (const field of ["str", "sleight"]) {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number"; inp.className = "num"; inp.value = p[field] ?? 0;
      inp.addEventListener("change", async () => {
        players[pid][field] = Number(inp.value || 0);
        await OBR.room.setMetadata({ [PLAYERS_KEY]: players });
      });
      td.appendChild(inp); tr.appendChild(td);
    }
    const td = document.createElement("td");
    const b = el("button", "btn danger", "✕");
    b.addEventListener("click", async () => {
      delete players[pid];
      await OBR.room.setMetadata({ [PLAYERS_KEY]: players });
      renderPlayers();
    });
    td.appendChild(b); tr.appendChild(td);
    tb.appendChild(tr);
  }
}

function floorOf(d) {
  // к какой карте относится дверь — по попаданию в её прямоугольник
  for (const m of maps) {
    if (d.x >= m.x0 && d.x <= m.x1 && d.y >= m.y0 && d.y <= m.y1) return m.name;
  }
  return "—";
}

async function focusDoor(d) {
  try {
    await OBR.viewport.animateTo({
      position: { x: -d.x + (await OBR.viewport.getWidth()) / 2,
                  y: -d.y + (await OBR.viewport.getHeight()) / 2 },
      scale: 1,
    });
  } catch {
    try { await OBR.player.select([`com.cos.doors-${d.id}`]); } catch {}
  }
}

function renderDoors() {
  const dc = loadDC();
  const onlyEmpty = $("only-empty").checked;
  const list = doors.filter((d) => !onlyEmpty || !(dc[d.id]?.pick || dc[d.id]?.force || dc[d.id]?.locked));
  $("dcount").textContent = `${list.length} из ${doors.length}`;
  const box = $("doors"); box.innerHTML = "";
  list.forEach((d) => {
    const cur = dc[d.id] || {};
    const row = el("div", "doorrow");
    const go = el("button", "btn", "▣");
    go.title = "Показать на карте";
    go.addEventListener("click", () => focusDoor(d));
    row.appendChild(go);

    const nm = el("span", "nm", cur.name || `${floorOf(d)} · ${Math.round(d.x)},${Math.round(d.y)}`);
    row.appendChild(nm);
    if (d.open) row.appendChild(el("span", "tag open", "открыта"));
    if (cur.locked) row.appendChild(el("span", "tag locked", "заперта"));

    const lock = document.createElement("input");
    lock.type = "checkbox"; lock.checked = !!cur.locked; lock.title = "Заперта";
    const pick = document.createElement("input");
    pick.type = "number"; pick.className = "num"; pick.placeholder = "взлом"; pick.value = cur.pick ?? "";
    const force = document.createElement("input");
    force.type = "number"; force.className = "num"; force.placeholder = "сила"; force.value = cur.force ?? "";
    const save = () => {
      const map = loadDC();
      map[d.id] = { ...(map[d.id] || {}), locked: lock.checked,
        pick: pick.value === "" ? null : Number(pick.value),
        force: force.value === "" ? null : Number(force.value) };
      saveDC(map); renderDoors();
    };
    [lock, pick, force].forEach((i) => i.addEventListener("change", save));
    row.append(lock, pick, force);
    box.appendChild(row);
  });
}

function renderPlayerPanel() {
  const p = players[myId];
  $("mymods").textContent = p
    ? `Сила ${fmtMod(Number(p.str || 0))}, Ловкость рук ${fmtMod(Number(p.sleight || 0))}`
    : "Мастер ещё не задал твои показатели.";
  const { bonus, mode } = loadLocalRoll();
  $("bonus").value = bonus;
  $("adv").checked = mode === "adv";
  $("dis").checked = mode === "dis";
}

function wirePlayerInputs() {
  const save = () => {
    const mode = $("adv").checked ? "adv" : $("dis").checked ? "dis" : "normal";
    if (mode === "adv") $("dis").checked = false;
    if (mode === "dis") $("adv").checked = false;
    saveLocalRoll(Number($("bonus").value || 0), mode);
  };
  ["bonus", "adv", "dis"].forEach((id) => $(id).addEventListener("change", save));
}

OBR.onReady(async () => {
  myId = await OBR.player.getId();
  isGM = (await OBR.player.getRole()) === "GM";
  $("title").textContent = isGM ? "Двери — мастер" : "Двери";
  $("gm").hidden = !isGM;
  $("pl").hidden = isGM;
  $("btn-sync").hidden = !isGM;
  $("btn-clear").hidden = !isGM;

  const meta = await OBR.room.getMetadata();
  players = meta[PLAYERS_KEY] || {};
  OBR.room.onMetadataChange((m) => {
    players = m[PLAYERS_KEY] || {};
    if (isGM) renderPlayers(); else renderPlayerPanel();
  });

  await refreshDoors();

  if (isGM) {
    renderPlayers(); renderDoors();
    $("only-empty").addEventListener("change", renderDoors);
    $("btn-sync").addEventListener("click", async () => {
      await refreshDoors(); renderDoors();
      log(`Найдено дверей: ${doors.length}`);
    });
    $("btn-clear").addEventListener("click", async () => {
      const items = await OBR.scene.items.getItems();
      const ids = items.filter((i) => i.metadata?.[ICON_KEY]).map((i) => i.id);
      if (ids.length) await OBR.scene.items.deleteItems(ids);
      log(`Убрано иконок: ${ids.length}`);
    });
    $("btn-add").addEventListener("click", async () => {
      const name = $("new-name").value.trim();
      if (!name) return;
      const party = await OBR.party.getPlayers();
      const match = party.find((p) => p.name === name);
      players[match ? match.id : `manual:${name}`] = { name, str: 0, sleight: 0 };
      await OBR.room.setMetadata({ [PLAYERS_KEY]: players });
      $("new-name").value = ""; renderPlayers();
    });
    $("btn-bulk").addEventListener("click", () => {
      const v = Number($("bulk-dc").value || 0);
      if (!v) return;
      const map = loadDC();
      for (const d of doors) {
        const cur = map[d.id] || {};
        if (cur.locked) continue;
        map[d.id] = { ...cur, pick: v, force: v };
      }
      saveDC(map); renderDoors();
      log(`Сл ${v} проставлена незапертым дверям`);
    });
  } else {
    renderPlayerPanel(); wirePlayerInputs();
  }
});
