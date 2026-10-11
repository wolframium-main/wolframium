// Wolframium — личный сайт из сети Избранет. Весь сайт в одном файле.
// Страницы собираются на сервере по дизайн-системе Wolframium. Записи читаются даже без JavaScript.
// Записи лежат в приватном Vercel Blob: каждая — отдельный файл entries/<id>.json. Пароль — переменная WRITE_PASSWORD.
// Часовой пояс автора — SITE_TZ (по умолчанию Asia/Vladivostok): по нему считаются «сегодня» и время записей.
// Для запуска на своём компьютере без Blob: LOCAL_STORE=./data WRITE_PASSWORD=... node server.js
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const DIR = "entries/";
const LEGACY = "notebook/entries.json"; // старый формат: все записи в одном файле
const TZ = process.env.SITE_TZ || "Asia/Vladivostok";

// ================= Хранилище =================
// Два варианта с одинаковым интерфейсом: Vercel Blob (на сайте) и папка на диске (для разработки).

function blobStore(blob) {
  const { get, put, del, list, BlobNotFoundError } = blob;
  async function readJSON(pathname, useCache) {
    try {
      const res = await get(pathname, { access: "private", useCache });
      if (!res || res.statusCode !== 200 || !res.stream) return null;
      return JSON.parse(await new Response(res.stream).text());
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  }
  async function listAll() {
    const blobs = [];
    let cursor;
    do {
      const page = await list({ cursor, limit: 1000 });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }
  async function save(entry) {
    await put(DIR + entry.id + ".json", JSON.stringify(entry), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  }
  async function migrateLegacy() {
    const legacy = await readJSON(LEGACY, false);
    if (Array.isArray(legacy)) {
      const base = Date.now() - 60000;
      await Promise.all(legacy.map((e, i) => save({ ...e, created: e.created ?? base - i })));
    }
    await del(LEGACY);
  }
  return {
    async all() {
      let blobs = await listAll();
      if (blobs.some(b => b.pathname === LEGACY)) {
        await migrateLegacy();
        blobs = await listAll();
      }
      const files = blobs.filter(b => b.pathname.startsWith(DIR) && b.pathname.endsWith(".json"));
      return Promise.all(files.map(b => readJSON(b.pathname, true)));
    },
    one: id => readJSON(DIR + id + ".json", false),
    save,
    remove: id => del(DIR + id + ".json"),
  };
}

function diskStore(root) {
  const path = id => join(root, id + ".json");
  return {
    async all() {
      await mkdir(root, { recursive: true });
      const names = (await readdir(root)).filter(n => n.endsWith(".json"));
      return Promise.all(names.map(async n => JSON.parse(await readFile(join(root, n), "utf8"))));
    },
    async one(id) {
      try { return JSON.parse(await readFile(path(id), "utf8")); } catch { return null; }
    },
    async save(entry) {
      await mkdir(root, { recursive: true });
      await writeFile(path(entry.id), JSON.stringify(entry));
    },
    remove: id => rm(path(id), { force: true }),
  };
}

const storage = process.env.LOCAL_STORE
  ? diskStore(process.env.LOCAL_STORE)
  : blobStore(await import("@vercel/blob"));

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0);

async function readEntries() {
  const entries = (await storage.all()).filter(e => e && e.id && e.text && isDate(e.date));
  return entries.sort(byNewest);
}

// После записи список читается из кэша и может отставать на одну запись: подставляем свежую.
async function withFresh(entry) {
  const entries = (await readEntries()).filter(e => e.id !== entry.id);
  entries.push(entry);
  return entries.sort(byNewest);
}

// ================= Доступ =================
function passwordIsSet() {
  return Boolean(process.env.WRITE_PASSWORD);
}

// Пароль приходит в заголовке Authorization: Bearer <пароль, закодированный encodeURIComponent>.
async function authorized(request) {
  const expected = process.env.WRITE_PASSWORD;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  let given = "";
  try {
    given = header.startsWith("Bearer ") ? decodeURIComponent(header.slice(7)) : "";
  } catch {
    given = "";
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  const ok = timingSafeEqual(a, b);
  if (!ok) await new Promise(r => setTimeout(r, 800)); // замедляем подбор пароля
  return ok;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const detail = err => String((err && err.message) || err).slice(0, 200);
const MAX_LENGTH = 20000;
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = s => /^[a-z0-9]{1,40}$/i.test(s);

async function guard(request) {
  if (!passwordIsSet()) return json({ error: "На Vercel не задан WRITE_PASSWORD" }, 500);
  if (!(await authorized(request))) return json({ error: "Пароль не подошёл" }, 401);
  return null;
}

async function readText(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: json({ error: "Пустой запрос" }, 400) };
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return { error: json({ error: "Запись пустая" }, 400) };
  if (text.length > MAX_LENGTH) return { error: json({ error: "Запись слишком длинная" }, 400) };
  return { body, text };
}

// ================= API (прежний, совместим со старым сайтом) =================
async function entriesGET() {
  try {
    return json({ entries: await readEntries() });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось прочитать записи", detail: detail(err) }, 500);
  }
}

async function entriesPOST(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const { error, body, text } = await readText(request);
  if (error) return error;
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: isDate(body.date) ? body.date : todayISO(),
    text,
    created: Date.now(),
  };
  try {
    await storage.save(entry);
    return json({ entry, entries: await withFresh(entry) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось сохранить", detail: detail(err) }, 500);
  }
}

async function entriesPUT(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!isId(id)) return json({ error: "Не указано, что исправить" }, 400);
  const { error, text } = await readText(request);
  if (error) return error;
  try {
    const old = await storage.one(id);
    if (!old) return json({ error: "Такой записи нет" }, 404);
    const entry = { ...old, text, edited: Date.now() };
    await storage.save(entry);
    return json({ entry, entries: await withFresh(entry) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось сохранить", detail: detail(err) }, 500);
  }
}

async function entriesDELETE(request) {
  const denied = await guard(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!isId(id)) return json({ error: "Не указано, что вычеркнуть" }, 400);
  try {
    await storage.remove(id);
    return json({ entries: (await readEntries()).filter(e => e.id !== id) });
  } catch (err) {
    console.error(err);
    return json({ error: "Не удалось вычеркнуть", detail: detail(err) }, 500);
  }
}

async function authPOST(request) {
  const denied = await guard(request);
  return denied || json({ ok: true });
}

// ================= Даты (в часовом поясе автора) =================
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const pad = n => String(n).padStart(2, "0");
const partsIn = ms => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const todayISO = () => partsIn(Date.now()).iso;
const shiftISO = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const dotted = iso => iso.split("-").reverse().join(".");
const longDate = iso => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const weekday = iso => {
  const today = todayISO();
  if (iso === today) return "Сегодня";
  if (iso === shiftISO(today, -1)) return "Вчера";
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const timeOf = e => (e.created ? partsIn(e.created).time : "");
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;

// ================= Текст =================
const NB = " ";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Ёлочки, тире, многоточие, неразрывные пробелы после коротких слов и чисел.
function typo(s) {
  return String(s)
    .replace(/(^|[\s(«])"(?=\S)/g, "$1«")
    .replace(/(\S)"(?=$|[\s.,!?;:)…])/g, "$1»")
    .replace(/\.\.\./g, "…")
    .replace(/(\S) [-–] (?=\S)/g, "$1" + NB + "— ")
    .replace(/(\S) — /g, "$1" + NB + "— ")
    .replace(/(^|[\s(«])([А-ЯЁа-яёA-Za-z]{1,2}|не|ни|но|на|по|за|из|от|до|для|без|под|над|при|про|что|как|это|все|всё)[ \t]+/g, (m, pre, w) => pre + w + NB)
    .replace(/(\d)[ \t]+(?=[^\s\d])/g, "$1" + NB);
}
const paragraphs = text => String(text).split(/\n\s*\n/).map(p => `<p>${esc(typo(p.trim()))}</p>`).join("");
const firstLine = text => { const t = String(text).trim().split(/\n/)[0]; return t.length > 140 ? t.slice(0, 139).replace(/\s+\S*$/, "") + "…" : t; };

// ================= Оформление: токены дизайн-системы Wolframium =================
const CSS = `
:root {
  --bg: #100d18; --surface: #171325; --surface-raised: #1f1a31;
  --line: #2c2645; --line-strong: #6e6b82;
  --ink: #e9e7ef; --ink-2: #b3b0c0; --ink-3: #8f8c9f;
  --violet: #3b2475; --violet-hover: #462b88; --on-violet: #eeecf3;
  --amber: #f2a93b; --amber-hover: #f5b95e; --on-amber: #2a1a04; --amber-ink: #f2a93b;
  --focus: var(--amber); --success: #5fc9a8; --danger: #f47c86;
  --space-dense: 4px; --space-1: 8px; --space-2: 16px; --space-3: 24px; --space-4: 32px; --space-6: 48px; --space-8: 64px; --space-12: 96px;
  --radius: 2px; --stroke: 1px;
  --font-sans: "IBM Plex Sans", system-ui, sans-serif; --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --ease: cubic-bezier(0.215, 0.61, 0.355, 1); --dur: 120ms;
  color-scheme: dark;
}
@media print {
  :root {
    --bg: #f4f3f8; --surface: #fbfafd; --surface-raised: #ffffff; --line: #dcd8e6; --line-strong: #8b889c;
    --ink: #16121f; --ink-2: #4a4757; --ink-3: #67647a; --amber-ink: #8a5200; --focus: var(--amber-ink); --success: #17735a; --danger: #b3263a;
    color-scheme: light;
  }
  .nav, .foot, .owner, .pager { display: none !important; }
}
* { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/24px var(--font-sans); -webkit-font-smoothing: antialiased; }
h1, h2, p, ol, figure { margin: 0; }
a { color: inherit; }
::selection { background: var(--violet); color: var(--on-violet); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
[hidden] { display: none !important; }

.display { font: 600 76px/80px var(--font-sans); letter-spacing: -0.02em; }
.title { font: 600 50px/56px var(--font-sans); letter-spacing: -0.015em; }
.heading { font: 600 34px/40px var(--font-sans); letter-spacing: -0.01em; }
.subheading { font: 600 22px/32px var(--font-sans); }
.strong { font-weight: 600; }
.meta { font: 400 12px/16px var(--font-mono); color: var(--ink-3); }
.ink-2 { color: var(--ink-2); }

.page { max-width: calc(864px + 2 * var(--space-3)); margin: 0 auto; padding: calc(var(--space-4) + env(safe-area-inset-top, 0px)) var(--space-3) calc(var(--space-8) + env(safe-area-inset-bottom, 0px)); }
.row { display: grid; grid-template-columns: 176px minmax(0, 640px); column-gap: var(--space-6); }
.row > .main { grid-column: 2; }
.side { display: flex; flex-direction: column; gap: var(--space-dense); padding-top: var(--space-dense); }

/* Навигация: слова в строку, текущий раздел ink, остальные ink-2 */
.top { align-items: baseline; padding-bottom: var(--space-12); }
.home { font-weight: 600; text-decoration: none; padding: var(--space-1) 0; }
.nav { display: flex; flex-wrap: wrap; gap: 0 var(--space-3); }
.nav a { color: var(--ink-2); text-decoration: none; padding: var(--space-1) 0; transition: color var(--dur) var(--ease); }
.nav a:hover { color: var(--ink); }
.nav a[aria-current] { color: var(--ink); }

/* Шапка страницы */
.head { padding-bottom: var(--space-8); }
.head .main { display: flex; flex-direction: column; gap: var(--space-2); }
.lede { color: var(--ink-2); max-width: 34em; }

/* Блоки: метка слева, содержание справа, между блоками линия */
.block { border-top: var(--stroke) solid var(--line); padding: var(--space-4) 0 var(--space-8); }
.entry-text { display: flex; flex-direction: column; gap: var(--space-2); overflow-wrap: anywhere; }
.entry-text p { white-space: pre-line; }
.foot-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--space-2); margin-top: var(--space-2); min-height: 32px; }

/* Ссылка: цвет текста, подчёркивание amber-ink */
.link { color: inherit; text-decoration: underline; text-decoration-color: var(--amber-ink); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color var(--dur) var(--ease); }
.link:hover { color: var(--amber-ink); }
/* Действие в строке: ink-3, подчёркивание line-strong */
.act { font: inherit; color: var(--ink-3); background: none; border: 0; padding: var(--space-1) 0; cursor: pointer; text-decoration: underline; text-decoration-color: var(--line-strong); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color var(--dur) var(--ease), text-decoration-color var(--dur) var(--ease); }
.act:hover { color: var(--ink); text-decoration-color: var(--amber-ink); }
.act.is-danger { color: var(--danger); text-decoration-color: var(--danger); }

/* Нажимаемое */
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: var(--space-1) var(--space-2); font: 600 15px/24px var(--font-sans); border-radius: var(--radius); border: var(--stroke) solid var(--line-strong); background: transparent; color: var(--ink); cursor: pointer; white-space: nowrap; transition: background-color var(--dur) var(--ease), transform var(--dur) var(--ease); }
.btn:hover { background: var(--surface-raised); }
.btn:active { transform: translateY(1px); }
.btn.is-primary { background: var(--amber); color: var(--on-amber); border-color: var(--amber); }
.btn.is-primary:hover { background: var(--amber-hover); border-color: var(--amber-hover); }
.btn.is-second { background: var(--violet); color: var(--on-violet); border-color: var(--violet); }
.btn.is-second:hover { background: var(--violet-hover); border-color: var(--violet-hover); }

/* Поле ввода: на bg — фон surface */
.label { display: block; font-weight: 600; margin-bottom: var(--space-1); }
.input, .textarea { width: 100%; min-height: 40px; padding: var(--space-1) var(--space-2); font: 400 15px/24px var(--font-sans); color: var(--ink); background: var(--surface); border: var(--stroke) solid var(--line-strong); border-radius: var(--radius); }
.input::placeholder, .textarea::placeholder { color: var(--ink-3); opacity: 1; }
.textarea { display: block; min-height: 192px; resize: none; overflow: hidden; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); margin-top: var(--space-2); }
.inline { display: flex; gap: var(--space-1); }
.inline .input { flex: 1; min-width: 0; }
.say { color: var(--ink-3); }
.say.is-error { color: var(--danger); }
.say.is-ok { color: var(--success); }

/* Чертёж ритма: столбики ink-3, сегодня — amber-ink */
.rhythm svg { display: block; width: 100%; height: auto; overflow: visible; }
.rhythm .bar-day { fill: var(--ink-3); }
.rhythm .bar-zero { fill: var(--line); }
.rhythm .bar-today { fill: var(--amber-ink); }
.rhythm .base { stroke: var(--line); stroke-width: 1; }
.rhythm .axis { display: flex; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-1); }
.rhythm a:hover .bar-day, .rhythm a:focus-visible .bar-day { fill: var(--ink-2); }

/* Записи */
.day { border-top: var(--stroke) solid var(--line); padding: var(--space-4) 0 var(--space-6); scroll-margin-top: var(--space-3); }
.entries { display: flex; flex-direction: column; gap: var(--space-6); }
.time { color: var(--ink-3); text-decoration-color: var(--line-strong); }

/* Листалка между записями */
.pager { border-top: var(--stroke) solid var(--line); padding-top: var(--space-3); }
.pager .main { display: flex; justify-content: space-between; gap: var(--space-3); }
.pager a { display: flex; flex-direction: column; gap: var(--space-dense); text-decoration: none; padding: var(--space-1) 0; max-width: 50%; }
.pager a .t { color: var(--ink-2); transition: color var(--dur) var(--ease); }
.pager a:hover .t { color: var(--ink); }
.pager .next { text-align: right; margin-left: auto; }

/* Правила */
.rules { list-style: none; padding: 0; border-top: var(--stroke) solid var(--line); }
.rules li { display: grid; grid-template-columns: 48px 1fr; align-items: baseline; padding: var(--space-2) 0; border-bottom: var(--stroke) solid var(--line); }

.list { list-style: none; padding: 0; }
.list li { border-bottom: var(--stroke) solid var(--line); }
.list a { display: grid; grid-template-columns: 96px 1fr; gap: var(--space-2); padding: var(--space-2) 0; text-decoration: none; color: var(--ink-2); transition: color var(--dur) var(--ease); }
.list a:hover { color: var(--ink); }

.foot { margin-top: var(--space-8); }
.foot .main { display: flex; justify-content: space-between; align-items: center; }

@media (max-width: 760px) {
  .page { padding-top: calc(var(--space-2) + env(safe-area-inset-top, 0px)); }
  .row { grid-template-columns: minmax(0, 1fr); }
  .row > .main { grid-column: 1; }
  .display { font: 600 50px/56px var(--font-sans); letter-spacing: -0.015em; }
  .title { font: 600 34px/40px var(--font-sans); letter-spacing: -0.01em; }
  .top { padding-bottom: var(--space-8); }
  .side { flex-direction: row; flex-wrap: wrap; gap: 0 var(--space-1); padding: 0 0 var(--space-2); }
  .side > * + *::before { content: "· "; }
  .list a { grid-template-columns: 1fr; gap: var(--space-dense); }
}
@media (hover: none) { .kbd { display: none; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22 width=%2232%22 height=%2232%22%3E%3Ctitle%3EWolframium%3C/title%3E%3Crect width=%2232%22 height=%2232%22 rx=%221%22 fill=%22%233b2475%22/%3E%3Cpath fill=%22%23eeecf3%22 d=%22M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z%22/%3E%3C/svg%3E";

// ================= Каркас страницы =================
const NAV = [["/", "Сейчас"], ["/zapisi", "Записи"], ["/izbranet", "Избранет"]];

function layout({ title, active, body, home = false, status = 200 }) {
  const nav = NAV.map(([href, name]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ""}>${name}</a>`).join("");
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title ? title + " · Wolframium" : "Wolframium")}</title>
<meta name="description" content="Здесь то, что происходит в моей жизни, и то, что у меня на уме.">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#100d18">
<meta name="color-scheme" content="dark">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <header class="row top">
    ${home ? "<span></span>" : '<a class="home" href="/">Wolframium</a>'}
    <nav class="nav" aria-label="Разделы">${nav}</nav>
  </header>
  <main>${body}</main>
  <footer class="row foot">
    <div class="main meta">
      <span>С 2026 · Избранет</span>
      <a class="act" id="owner-link" href="/pisat">Войти</a>
    </div>
  </footer>
</div>
<script>${CLIENT}</script>
</body>
</html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

const wdSpan = iso => `<span data-d="${iso}">${weekday(iso)}</span>`;
const sideDate = (iso, extra = "") =>
  `<div class="side meta"><time datetime="${iso}">${dotted(iso)}</time>${wdSpan(iso)}${extra}</div>`;

// Время показывается в часовом поясе читателя: сервер даёт запасной вариант, браузер уточняет.
const timeLine = e => {
  const t = timeOf(e);
  const text = t ? (e.edited ? `${t} · исправлено` : t) : e.edited ? "Исправлено" : "Запись";
  return e.created ? `<span data-t="${e.created}"${e.edited ? " data-ed" : ""}>${text}</span>` : text;
};

// ================= Страницы =================

// Чертёж ритма: сколько записей в каждый из последних 30 дней. Сегодня — янтарём.
function rhythm(entries) {
  const today = todayISO();
  const first = entries.reduce((a, e) => (e.date < a ? e.date : a), today);
  const span = Math.max(1, Math.min(30, daysBetween(first, today) + 1));
  const start = shiftISO(today, -(span - 1));
  const counts = {};
  for (const e of entries) counts[e.date] = (counts[e.date] || 0) + 1;
  const inRange = Object.keys(counts).filter(d => d >= start);
  const max = Math.max(1, ...inRange.map(d => counts[d]));
  const peak = inRange.filter(d => counts[d] === max).sort().pop();
  const SLOT = 20, BAR = 14, H = 88, W = span * SLOT;
  let bars = "";
  for (let i = 0; i < span; i++) {
    const iso = shiftISO(start, i);
    const n = counts[iso] || 0;
    const x = i * SLOT + (SLOT - BAR) / 2;
    const label = `${dotted(iso)} · ${n ? count(n, "запись", "записи", "записей") : "без записей"}`;
    if (!n) { bars += `<g><title>${label}</title><rect class="bar-zero" x="${x}" y="${H - 2}" width="${BAR}" height="2"/></g>`; continue; }
    const h = Math.max(4, Math.round((H - 8) * n / max));
    bars += `<a href="/zapisi#d-${iso}" aria-label="${label}"><title>${label}</title><rect x="${i * SLOT}" y="0" width="${SLOT}" height="${H}" fill="transparent"/><rect class="${iso === today ? "bar-today" : "bar-day"}" x="${x}" y="${H - h}" width="${BAR}" height="${h}" rx="2"/></a>`;
  }
  return `<figure class="rhythm" style="width:${W}px;max-width:100%">
<svg viewBox="0 0 ${W} ${H + 1}" width="${W}" height="${H + 1}" role="img" aria-label="Записи по дням за последние ${count(span, "день", "дня", "дней")}">
<line class="base" x1="0" y1="${H + 0.5}" x2="${W}" y2="${H + 0.5}"/>${bars}
</svg>
<div class="axis meta">${span >= 5 ? `<span>${dotted(start)}</span>` : "<span></span>"}<span>Сегодня</span></div>
</figure>
<p class="meta" style="margin-top:var(--space-2)">Писал ${count(inRange.length, "день", "дня", "дней")} из ${span}. Больше всего — ${count(max, "запись", "записи", "записей")}, ${dotted(peak || today)}. Правило 02: пиши часто.</p>`;
}

async function pageNow() {
  const entries = await readEntries();
  if (!entries.length) {
    return layout({ active: "/", home: true, body: `
<section class="row head"><div class="main">
  <h1 class="display">Wolframium</h1>
  <p class="lede">Здесь то, что происходит в&nbsp;моей жизни, и&nbsp;то, что у&nbsp;меня на&nbsp;уме.</p>
</div></section>
<section class="row block"><div class="main"><p class="ink-2">Записей пока нет.</p></div></section>` });
  }
  const last = entries[0];
  const first = entries[entries.length - 1].date;
  const days = new Set(entries.map(e => e.date)).size;
  const recent = entries.slice(1, 6).map(e =>
    `<li><a href="/zapisi/${e.id}"><span class="meta">${dotted(e.date)}</span><span>${esc(typo(firstLine(e.text)))}</span></a></li>`).join("");
  return layout({ active: "/", home: true, body: `
<section class="row head"><div class="main">
  <h1 class="display">Wolframium</h1>
  <p class="lede">Здесь то, что происходит в&nbsp;моей жизни, и&nbsp;то, что у&nbsp;меня на&nbsp;уме.</p>
  <p class="meta">${count(entries.length, "запись", "записи", "записей")} · ${count(days, "день", "дня", "дней")} · с ${dotted(first)}</p>
</div></section>

<section class="row block" aria-labelledby="now">
  ${sideDate(last.date, `<span>${timeLine(last)}</span>`)}
  <div class="main">
    <h2 id="now" class="subheading" style="margin-bottom:var(--space-3)">Последнее на уме</h2>
    <div class="entry-text">${paragraphs(last.text)}</div>
    <div class="foot-line meta"><a class="act" href="/zapisi/${last.id}">Ссылка на запись</a></div>
  </div>
</section>

<section class="row block" aria-labelledby="rhythm">
  <div class="side meta"><span>Ритм</span></div>
  <div class="main">
    <h2 id="rhythm" class="subheading" style="margin-bottom:var(--space-3)">Как часто я пишу</h2>
    ${rhythm(entries)}
  </div>
</section>

${recent ? `<section class="row block" aria-labelledby="before">
  <div class="side meta"><span>Раньше</span></div>
  <div class="main">
    <h2 id="before" class="subheading" style="margin-bottom:var(--space-2)">Предыдущие записи</h2>
    <ol class="list">${recent}</ol>
    <p style="margin-top:var(--space-3)"><a class="link" href="/zapisi">Все ${count(entries.length, "запись", "записи", "записей")} →</a></p>
  </div>
</section>` : ""}` });
}

async function pageAll() {
  const entries = await readEntries();
  const days = [];
  for (const e of entries) {
    const d = days[days.length - 1];
    if (d && d.date === e.date) d.items.push(e); else days.push({ date: e.date, items: [e] });
  }
  const body = days.map(d => `
<article class="row day" id="d-${d.date}">
  ${sideDate(d.date, `<span>${count(d.items.length, "запись", "записи", "записей")}</span>`)}
  <div class="main entries">${d.items.map(e => `
    <div class="entry">
      <div class="entry-text">${paragraphs(e.text)}</div>
      <div class="foot-line meta"><a class="act time" href="/zapisi/${e.id}">${timeLine(e)}</a></div>
    </div>`).join("")}
  </div>
</article>`).join("");
  return layout({ title: "Записи", active: "/zapisi", body: `
<section class="row head"><div class="main">
  <h1 class="title">Записи</h1>
  <p class="meta">${entries.length ? `${count(entries.length, "запись", "записи", "записей")} · сначала новые` : "Записей пока нет"}</p>
</div></section>${body}` });
}

async function pageEntry(id) {
  const entries = await readEntries();
  const i = entries.findIndex(e => e.id === id);
  if (i === -1) return pageNotFound();
  const e = entries[i];
  const newer = entries[i - 1], older = entries[i + 1];
  const pagerLink = (x, cls, arrow) => x
    ? `<a class="${cls}" href="/zapisi/${x.id}"><span class="meta">${arrow === "←" ? "← Раньше" : "Позже →"} · ${dotted(x.date)}</span><span class="t">${esc(typo(firstLine(x.text)).slice(0, 80))}${firstLine(x.text).length > 80 ? "…" : ""}</span></a>`
    : "<span></span>";
  return layout({ title: dotted(e.date), active: "/zapisi", body: `
<section class="row head"><div class="main">
  <h1 class="heading">${longDate(e.date)}</h1>
  <p class="meta">${wdSpan(e.date)} · ${timeLine(e)}</p>
</div></section>
<article class="row block" data-entry="${e.id}">
  <div class="side meta"><span>Запись</span></div>
  <div class="main">
    <div class="entry-text" id="entry-text">${paragraphs(e.text)}</div>
    <div class="owner" id="owner" hidden></div>
    <textarea id="entry-raw" hidden>${esc(e.text)}</textarea>
  </div>
</article>
<nav class="row pager" aria-label="Соседние записи"><div class="main">${pagerLink(older, "prev", "←")}${pagerLink(newer, "next", "→")}</div></nav>` });
}

function pageIzbranet() {
  return layout({ title: "Избранет", active: "/izbranet", body: `
<section class="row head"><div class="main">
  <h1 class="title">Избранет</h1>
  <p class="lede">Сеть личных сайтов, куда попадают только по&nbsp;ссылке. Этот сайт&nbsp;— первый из&nbsp;них.</p>
</div></section>
<section class="row block" aria-labelledby="rules">
  <div class="side meta"><span>Правила</span></div>
  <div class="main">
    <h2 id="rules" class="subheading" style="margin-bottom:var(--space-3)">Пять правил</h2>
    <ol class="rules">
      <li><span class="meta">01</span><span>Пиши о&nbsp;себе.</span></li>
      <li><span class="meta">02</span><span>Пиши часто и&nbsp;с&nbsp;минимальным фильтром.</span></li>
      <li><span class="meta">03</span><span>Не&nbsp;скрывай изъяны.</span></li>
      <li><span class="meta">04</span><span>Не&nbsp;стирай записи.</span></li>
      <li><span class="meta">05</span><span>Ссылку получают только избранные.</span></li>
    </ol>
  </div>
</section>` });
}

function pageWrite() {
  const today = todayISO();
  return layout({ title: "Писать", active: "", body: `
<section class="row head"><div class="main">
  <h1 class="title">Писать</h1>
  <p class="meta">${dotted(today)} · <span data-d="${today}">Сегодня</span></p>
</div></section>
<section class="row block" id="login-block">
  <div class="side meta"><span>Вход</span></div>
  <form class="main" id="login" novalidate>
    <label for="pw" class="label">Пароль</label>
    <div class="inline">
      <input class="input" id="pw" type="password" autocomplete="current-password" enterkeyhint="go">
      <button class="btn is-primary" type="submit">Войти</button>
    </div>
    <p class="say meta" id="login-say" role="status" style="margin-top:var(--space-1)">Пароль запомнится на этом устройстве.</p>
  </form>
</section>
<section class="row block" id="write-block" hidden>
  <div class="side meta"><span>Новая запись</span></div>
  <div class="main">
    <label for="draft" class="label">Что сейчас на уме?</label>
    <textarea class="textarea" id="draft" autocapitalize="sentences" spellcheck="true"></textarea>
    <div class="bar">
      <button class="btn is-primary" id="save" type="button">Записать</button>
      <span class="kbd meta" id="kbd">Ctrl + Enter</span>
      <span class="say" id="say" role="status"></span>
    </div>
  </div>
</section>
<section class="row" id="out-block" hidden>
  <div class="main meta"><button class="act" id="logout" type="button">Выйти на этом устройстве</button></div>
</section>`, script: "" });
}

function pageNotFound() {
  return layout({ title: "Не найдено", active: "", status: 404, body: `
<section class="row head"><div class="main">
  <p class="meta">Ошибка 404</p>
  <h1 class="heading">Этой страницы не&nbsp;существует. Проверил дважды.</h1>
  <p><a class="link" href="/">← На главную</a></p>
</div></section>` });
}

// ================= Скрипт в браузере: только для автора =================
// Без шаблонных строк, чтобы безопасно жить внутри шаблона страницы.
const CLIENT = String.raw`
(function () {
  "use strict";
  var KEY_PW = "wolframium-pw", KEY_DRAFT = "wolframium-draft";
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var $ = function (id) { return document.getElementById(id); };
  var password = store.get(KEY_PW);
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var todayISO = function () { var t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate()); };

  if (location.hash === "#write") { location.replace("/pisat"); return; }

  // Время и «Сегодня/Вчера» — в часовом поясе читателя.
  var WD = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  var isoOf = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var yd = new Date(); yd.setDate(yd.getDate() - 1);
  var tIso = isoOf(new Date()), yIso = isoOf(yd);
  Array.prototype.forEach.call(document.querySelectorAll("[data-t]"), function (el) {
    var d = new Date(Number(el.getAttribute("data-t")));
    if (isNaN(d)) return;
    el.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + (el.hasAttribute("data-ed") ? " · исправлено" : "");
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-d]"), function (el) {
    var iso = el.getAttribute("data-d");
    el.textContent = iso === tIso ? "Сегодня" : iso === yIso ? "Вчера" : WD[new Date(iso + "T12:00:00").getDay()];
  });

  function api(method, url, body) {
    var headers = { "content-type": "application/json" };
    if (password) headers.authorization = "Bearer " + encodeURIComponent(password);
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var err = new Error(data.error || "Ошибка"); err.status = res.status; throw err; }
        return data;
      });
    });
  }
  function say(el, text, kind) { el.className = el.className.replace(/\s?is-(ok|error)/g, "") + (kind ? " is-" + kind : ""); el.textContent = text; }
  function grow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }
  function forget() { password = null; store.del(KEY_PW); }

  var ownerLink = $("owner-link");
  if (password && ownerLink) ownerLink.textContent = "Писать";

  // ---------- Страница записи: исправить и вычеркнуть ----------
  var art = document.querySelector("[data-entry]");
  if (art && password) {
    var id = art.getAttribute("data-entry");
    var box = $("owner"), textEl = $("entry-text"), raw = $("entry-raw").value;
    var showActions = function () {
      box.hidden = false;
      box.className = "owner foot-line meta";
      box.innerHTML = "";
      var edit = document.createElement("button"); edit.type = "button"; edit.className = "act"; edit.textContent = "Исправить";
      var strike = document.createElement("button"); strike.type = "button"; strike.className = "act"; strike.textContent = "Вычеркнуть";
      edit.onclick = showEditor;
      strike.onclick = function () {
        box.innerHTML = "";
        var q = document.createElement("span"); q.textContent = "Точно?";
        var yes = document.createElement("button"); yes.type = "button"; yes.className = "act is-danger"; yes.textContent = "Да, вычеркнуть";
        var no = document.createElement("button"); no.type = "button"; no.className = "act"; no.textContent = "Отмена";
        no.onclick = showActions;
        yes.onclick = function () {
          box.textContent = "Вычёркиваю…";
          api("DELETE", "/api/entries?id=" + encodeURIComponent(id)).then(function () { location.href = "/zapisi"; }, function (err) {
            if (err.status === 401) { forget(); box.textContent = "Пароль изменился. Войди снова на странице «Писать»."; return; }
            box.textContent = "Не вычеркнулось. Попробуй ещё раз.";
          });
        };
        box.append(q, yes, no);
        no.focus();
      };
      box.append(edit, strike);
    };
    var showEditor = function () {
      textEl.hidden = true;
      box.className = "owner";
      box.innerHTML = "";
      var ta = document.createElement("textarea"); ta.className = "textarea"; ta.value = raw; ta.setAttribute("aria-label", "Текст записи");
      var bar = document.createElement("div"); bar.className = "bar";
      var save = document.createElement("button"); save.type = "button"; save.className = "btn is-second"; save.textContent = "Сохранить";
      var cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn"; cancel.textContent = "Отмена";
      var msg = document.createElement("span"); msg.className = "say"; msg.setAttribute("role", "status");
      cancel.onclick = function () { textEl.hidden = false; showActions(); };
      save.onclick = function () {
        var text = ta.value.trim();
        if (!text) { say(msg, "Пустую запись не сохранить. Если она не нужна — вычеркни.", "error"); ta.focus(); return; }
        if (text === raw.trim()) { cancel.onclick(); return; }
        say(msg, "Сохраняю…");
        api("PUT", "/api/entries?id=" + encodeURIComponent(id), { text: text }).then(function () { location.reload(); }, function (err) {
          if (err.status === 401) { forget(); say(msg, "Пароль изменился. Войди снова на странице «Писать».", "error"); return; }
          say(msg, "Не сохранилось. Текст на месте, попробуй ещё раз.", "error");
        });
      };
      ta.addEventListener("input", function () { grow(ta); });
      ta.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save.click(); }
        if (ev.key === "Escape") { ev.preventDefault(); cancel.onclick(); }
      });
      bar.append(save, cancel, msg);
      box.append(ta, bar);
      grow(ta); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    showActions();
  }

  // ---------- Страница «Писать» ----------
  var login = $("login");
  if (login) {
    var loginBlock = $("login-block"), writeBlock = $("write-block"), outBlock = $("out-block");
    var draft = $("draft"), save = $("save"), msg = $("say"), loginSay = $("login-say");
    if (/Mac|iPhone|iPad/.test(navigator.platform || "")) $("kbd").textContent = "⌘ + Enter";
    var openWriter = function () {
      loginBlock.hidden = true; writeBlock.hidden = false; outBlock.hidden = false;
      if (ownerLink) ownerLink.textContent = "Писать";
      var saved = store.get(KEY_DRAFT);
      if (saved && !draft.value) draft.value = saved;
      grow(draft); draft.focus();
    };
    var openLogin = function (note, isError) {
      loginBlock.hidden = false; writeBlock.hidden = true; outBlock.hidden = true;
      if (ownerLink) ownerLink.textContent = "Войти";
      if (note) say(loginSay, note, isError ? "error" : "");
      $("pw").focus();
    };
    if (password) openWriter(); else openLogin();

    login.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var value = $("pw").value;
      if (!value) { say(loginSay, "Сначала введи пароль.", "error"); $("pw").focus(); return; }
      say(loginSay, "Проверяю…");
      password = value;
      api("POST", "/api/auth").then(function () {
        store.set(KEY_PW, value); $("pw").value = ""; say(loginSay, "Пароль запомнится на этом устройстве."); openWriter();
      }, function (err) {
        password = null;
        say(loginSay, err.status === 401 ? "Пароль не подошёл." : "Не получилось войти. Проверь соединение.", "error");
        $("pw").select();
      });
    });

    var timer;
    draft.addEventListener("input", function () {
      grow(draft); say(msg, "");
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (draft.value.trim()) { store.set(KEY_DRAFT, draft.value); say(msg, "Черновик сохранён"); } else store.del(KEY_DRAFT);
      }, 600);
    });
    draft.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save.click(); }
    });
    var busy = false;
    save.onclick = function () {
      if (busy) return;
      var text = draft.value.trim();
      if (!text) { say(msg, "Сначала напиши что-нибудь.", "error"); draft.focus(); return; }
      busy = true; say(msg, "Записываю…");
      api("POST", "/api/entries", { text: text, date: todayISO() }).then(function (data) {
        store.del(KEY_DRAFT);
        location.href = data.entry ? "/zapisi/" + data.entry.id : "/zapisi";
      }, function (err) {
        busy = false;
        if (err.status === 401) { forget(); openLogin("Пароль изменился. Войди снова.", true); return; }
        say(msg, "Не сохранилось. Текст на месте, попробуй ещё раз.", "error");
      });
    };
    $("logout").onclick = function () { forget(); openLogin("Готово, на этом устройстве ты вышел."); };
  }
})();
`;

// ================= Маршруты =================
async function route(request) {
  const url = new URL(request.url);
  const m = request.method;
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/entries") {
    if (m === "GET") return entriesGET();
    if (m === "POST") return entriesPOST(request);
    if (m === "PUT") return entriesPUT(request);
    if (m === "DELETE") return entriesDELETE(request);
    return json({ error: "Метод не поддерживается" }, 405);
  }
  if (p === "/api/auth" && m === "POST") return authPOST(request);
  if (m !== "GET" && m !== "HEAD") return json({ error: "Метод не поддерживается" }, 405);
  try {
    if (p === "/" || p === "/index.html") return await pageNow();
    if (p === "/zapisi") return await pageAll();
    const one = p.match(/^\/zapisi\/([a-z0-9]{1,40})$/i);
    if (one) return await pageEntry(one[1]);
    if (p === "/izbranet") return pageIzbranet();
    if (p === "/pisat") return pageWrite();
  } catch (err) {
    console.error(err);
    return layout({ title: "Ошибка", active: "", status: 500, body: `
<section class="row head"><div class="main">
  <p class="meta">Ошибка 500</p>
  <h1 class="heading">Записи не&nbsp;загрузились.</h1>
  <p class="ink-2">Обнови страницу через минуту. Если не&nbsp;поможет — значит, сломалось всерьёз.</p>
</div></section>` });
  }
  return pageNotFound();
}

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request("http://" + (req.headers.host || "localhost") + req.url, {
      method: req.method,
      headers: req.headers,
      body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });
    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Ошибка сервера");
  }
});

server.listen(Number(process.env.PORT ?? 3000));
