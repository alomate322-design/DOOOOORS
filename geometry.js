// Геометрия дверей Dynamic Fog.
//
// Dynamic Fog хранит дверь не отдельным объектом, а записью в метаданных куска
// тумана: {open, start:{distance,index}, end:{distance,index}}. Расстояние
// отсчитывается вдоль контура. Здесь это переводится в мировые координаты,
// чтобы поставить в проём иконку.

export const FOG_DOORS_KEY = "rodeo.owlbear.dynamic-fog/doors";

// Команды пути: [0,x,y] — переход, [1,x,y] — линия, [5] — замыкание.
function subpaths(commands) {
  const subs = [];
  let cur = [];
  for (const c of commands || []) {
    const op = c[0];
    if (op === 0) {
      if (cur.length > 1) subs.push({ pts: cur, closed: false });
      cur = [[c[1], c[2]]];
    } else if (op === 1) {
      cur.push([c[1], c[2]]);
    } else if (op === 5) {
      if (cur.length > 1) subs.push({ pts: cur, closed: true });
      cur = [];
    } else if (c.length >= 3) {
      // кривые в тумане не используются, но точку всё равно учитываем
      cur.push([c[c.length - 2], c[c.length - 1]]);
    }
  }
  if (cur.length > 1) subs.push({ pts: cur, closed: false });
  return subs;
}

function pointAt(sub, dist) {
  const seq = sub.closed ? [...sub.pts, sub.pts[0]] : sub.pts;
  let acc = 0;
  for (let i = 0; i < seq.length - 1; i++) {
    const [x1, y1] = seq[i];
    const [x2, y2] = seq[i + 1];
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (acc + L >= dist || i === seq.length - 2) {
      const t = L ? Math.max(0, Math.min(1, (dist - acc) / L)) : 0;
      return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
    }
    acc += L;
  }
  const last = seq[seq.length - 1];
  return { x: last[0], y: last[1] };
}

function subsOf(item) {
  if (item.type === "LINE") {
    return [{
      pts: [[item.startPosition.x, item.startPosition.y],
            [item.endPosition.x, item.endPosition.y]],
      closed: false,
    }];
  }
  return subpaths(item.commands);
}

// Локальные координаты -> мировые, с учётом позиции, масштаба и поворота.
function toWorld(item, p) {
  const sx = item.scale?.x ?? 1;
  const sy = item.scale?.y ?? 1;
  let x = p.x * sx;
  let y = p.y * sy;
  const rot = ((item.rotation || 0) * Math.PI) / 180;
  if (rot) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    [x, y] = [x * cos - y * sin, x * sin + y * cos];
  }
  return { x: item.position.x + x, y: item.position.y + y };
}

export function doorId(itemId, index) {
  return `${itemId}:${index}`;
}

// Все двери сцены: [{id, itemId, index, x, y, angle, width, open}]
export function collectDoors(items) {
  const out = [];
  for (const item of items) {
    const doors = item.metadata?.[FOG_DOORS_KEY];
    if (!Array.isArray(doors) || !doors.length) continue;
    const subs = subsOf(item);
    doors.forEach((d, index) => {
      const si = d.start?.index ?? 0;
      const sub = subs[si];
      if (!sub) return;
      const a = pointAt(sub, d.start?.distance ?? 0);
      const b = pointAt(sub, d.end?.distance ?? 0);
      const wa = toWorld(item, a);
      const wb = toWorld(item, b);
      const width = Math.hypot(wb.x - wa.x, wb.y - wa.y);
      out.push({
        id: doorId(item.id, index),
        itemId: item.id,
        index,
        x: (wa.x + wb.x) / 2,
        y: (wa.y + wb.y) / 2,
        angle: (Math.atan2(wb.y - wa.y, wb.x - wa.x) * 180) / Math.PI,
        width,
        open: !!d.open,
      });
    });
  }
  return out;
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
