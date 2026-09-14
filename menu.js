// Настройка двери прямо на карте: открывается из контекстного меню мастера.
// Так не нужно искать нужную строку в списке — кликнул по двери и задал Сл.

import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { ICON_KEY, loadDC, saveDC, num } from "./store.js";

const $ = (id) => document.getElementById(id);
let doorId = null;

OBR.onReady(async () => {
  const sel = await OBR.player.getSelection();
  const items = sel ? await OBR.scene.items.getItems(sel) : [];
  const icon = items.find((i) => i.metadata?.[ICON_KEY]);
  if (!icon) {
    $("status").textContent = "Не удалось определить дверь.";
    $("status").className = "hint bad";
    return;
  }
  doorId = icon.metadata[ICON_KEY].doorId;

  const map = loadDC();
  const cur = map[doorId] || {};
  $("name").value = cur.name || "";
  $("locked").checked = !!cur.locked;
  $("pick").value = cur.pick ?? "";
  $("force").value = cur.force ?? "";

  $("save").addEventListener("click", async () => {
    const m = loadDC();
    m[doorId] = {
      name: $("name").value.trim(),
      locked: $("locked").checked,
      pick: $("pick").value === "" ? null : num($("pick").value),
      force: $("force").value === "" ? null : num($("force").value),
    };
    saveDC(m);
    $("status").textContent = "Сохранено. Иконка обновится сразу.";
    // фон перерисует иконку: он слушает изменения сцены
    try {
      await OBR.scene.items.updateItems([icon.id], (list) => {
        for (const it of list) it.metadata[ICON_KEY] = { ...it.metadata[ICON_KEY], touched: Date.now() };
      });
    } catch {}
  });
});
