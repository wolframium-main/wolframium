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

// Сайт дизайн-системы: самодостаточная страница, собранная из README.md и tokens.json системы.
const SISTEMA = "<!doctype html>\n<html lang=\"ru\" data-theme=\"dark\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Дизайн-система · Wolframium</title>\n<meta name=\"description\" content=\"Дизайн-система Wolframium: принципы, голос, цвет, шрифт, форма и правила вывода любого элемента.\">\n<meta name=\"robots\" content=\"noindex, nofollow\">\n<meta name=\"theme-color\" content=\"#100d18\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22 width=%2232%22 height=%2232%22%3E%3Ctitle%3EWolframium%3C/title%3E%3Crect width=%2232%22 height=%2232%22 rx=%221%22 fill=%22%233b2475%22/%3E%3Cpath fill=%22%23eeecf3%22 d=%22M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z%22/%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&family=IBM+Plex+Sans:wght@400;600&display=swap\">\n<style>\n/* Wolframium — generated from tokens.json */\n:root, [data-theme=\"dark\"] {\n  --bg: #100d18;\n  --surface: #171325;\n  --surface-raised: #1f1a31;\n  --line: #2c2645;\n  --line-strong: #6e6b82;\n  --ink: #e9e7ef;\n  --ink-2: #b3b0c0;\n  --ink-3: #8f8c9f;\n  --violet: #3b2475;\n  --violet-hover: #462b88;\n  --on-violet: #eeecf3;\n  --amber: #f2a93b;\n  --amber-hover: #f5b95e;\n  --on-amber: #2a1a04;\n  --amber-ink: #f2a93b;\n  --focus: var(--amber);\n  --success: #5fc9a8;\n  --danger: #f47c86;\n  color-scheme: dark;\n}\n[data-theme=\"light\"] {\n  --bg: #f4f3f8;\n  --surface: #fbfafd;\n  --surface-raised: #ffffff;\n  --line: #dcd8e6;\n  --line-strong: #8b889c;\n  --ink: #16121f;\n  --ink-2: #4a4757;\n  --ink-3: #67647a;\n  --violet: #3b2475;\n  --violet-hover: #2e1b5e;\n  --on-violet: #eeecf3;\n  --amber: #f2a93b;\n  --amber-hover: #e09524;\n  --on-amber: #2a1a04;\n  --amber-ink: #8a5200;\n  --focus: var(--amber-ink);\n  --success: #17735a;\n  --danger: #b3263a;\n  color-scheme: light;\n}\n:root {\n  --space-dense: 4px;\n  --space-1: 8px;\n  --space-2: 16px;\n  --space-3: 24px;\n  --space-4: 32px;\n  --space-6: 48px;\n  --space-8: 64px;\n  --space-12: 96px;\n  --radius: 2px;\n  --radius-round: 50%;\n  --stroke: 1px;\n  --focus-width: 2px;\n  --focus-offset: 2px;\n  --font-sans: \"IBM Plex Sans\", system-ui, sans-serif;\n  --font-mono: \"IBM Plex Mono\", ui-monospace, monospace;\n}\n.display { font-family: var(--font-sans); font-size: 76px; line-height: 80px; font-weight: 600; letter-spacing: -0.02em; }\n.title { font-family: var(--font-sans); font-size: 50px; line-height: 56px; font-weight: 600; letter-spacing: -0.015em; }\n.heading { font-family: var(--font-sans); font-size: 34px; line-height: 40px; font-weight: 600; letter-spacing: -0.01em; }\n.subheading { font-family: var(--font-sans); font-size: 22px; line-height: 32px; font-weight: 600; }\n.body { font-family: var(--font-sans); font-size: 15px; line-height: 24px; font-weight: 400; }\n.body-strong { font-family: var(--font-sans); font-size: 15px; line-height: 24px; font-weight: 600; }\n.meta { font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 400; }\n.code { font-family: var(--font-mono); font-size: 14px; line-height: 24px; font-weight: 400; }\n:root { --ease: cubic-bezier(0.215, 0.61, 0.355, 1); --dur: 120ms; }\n* { box-sizing: border-box; }\nhtml { background: var(--bg); -webkit-text-size-adjust: 100%; scroll-padding-top: var(--space-3); }\nbody { margin: 0; background: var(--bg); color: var(--ink); font: 400 15px/24px var(--font-sans); -webkit-font-smoothing: antialiased; transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease); }\nh1, h2, h3, p, ul, ol, figure, pre { margin: 0; }\na { color: inherit; }\n::selection { background: var(--violet); color: var(--on-violet); }\n:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }\n.ink-2 { color: var(--ink-2); }\n.meta { color: var(--ink-3); }\n\n.page { max-width: calc(864px + 2 * var(--space-3)); margin: 0 auto; padding: var(--space-4) var(--space-3) var(--space-8); }\n.grid { display: grid; grid-template-columns: 176px minmax(0, 640px); column-gap: var(--space-6); }\n.top { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); grid-column: 2; padding-bottom: var(--space-12); }\n.home { font-weight: 600; text-decoration: none; padding: var(--space-1) 0; }\n.themes { display: flex; gap: var(--space-3); }\n.themes button { font: inherit; background: none; border: 0; padding: var(--space-1) 0; color: var(--ink-2); cursor: pointer; transition: color var(--dur) var(--ease); }\n.themes button:hover { color: var(--ink); }\n.themes button[aria-pressed=\"true\"] { color: var(--ink); }\n\n.head { grid-column: 2; display: flex; flex-direction: column; gap: var(--space-2); padding-bottom: var(--space-8); }\n.lede { color: var(--ink-2); }\n\n.toc { grid-row: 3; grid-column: 1; }\n.toc nav { position: sticky; top: var(--space-3); display: flex; flex-direction: column; }\n.toc a { font: 400 12px/16px var(--font-mono); color: var(--ink-3); text-decoration: none; padding: var(--space-1) 0; transition: color var(--dur) var(--ease); }\n.toc a:hover, .toc a[aria-current] { color: var(--ink); }\n.content { grid-row: 3; grid-column: 2; }\n\n.sec { border-top: 1px solid var(--line); padding: var(--space-4) 0 var(--space-8); }\n.sec > h2 { margin-bottom: var(--space-4); }\n.prose { display: flex; flex-direction: column; gap: var(--space-2); }\n.prose ul, .prose ol { padding-left: var(--space-3); display: flex; flex-direction: column; gap: var(--space-1); }\n.prose li::marker { color: var(--ink-3); font-family: var(--font-mono); font-size: 12px; }\n.prose strong { font-weight: 600; }\n.prose code { font: 400 14px/24px var(--font-mono); background: var(--surface); padding: 0 4px; border-radius: var(--radius); white-space: nowrap; }\n.prose code.tok i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 2px; box-shadow: inset 0 0 0 1px var(--line-strong); vertical-align: 0; }\n.prose table { border-collapse: collapse; width: 100%; margin: var(--space-1) 0; }\n.prose th { font: 400 12px/16px var(--font-mono); color: var(--ink-3); text-align: left; padding: var(--space-1) var(--space-2) var(--space-1) 0; border-bottom: 1px solid var(--line-strong); }\n.prose td { padding: var(--space-1) var(--space-2) var(--space-1) 0; border-bottom: 1px solid var(--line); vertical-align: top; }\n.sub { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-4); }\n\n.spec { margin-top: var(--space-2); }\n.spec figcaption { margin-bottom: var(--space-1); }\n.spec-body { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); overflow-x: auto; }\n.row-x { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }\n\n.swatches { list-style: none; padding: 0 !important; display: flex; flex-direction: column; gap: 0 !important; }\n.sw { display: grid; grid-template-columns: 64px 1fr; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--line); }\n.sw:last-child { border-bottom: 0; }\n.sw-chip { width: 64px; height: 64px; border-radius: var(--radius); box-shadow: inset 0 0 0 1px var(--line-strong); }\n.sw-text { display: flex; flex-direction: column; gap: var(--space-dense); min-width: 0; }\n.sw-name { font: 400 14px/24px var(--font-mono); }\n.sw-use { color: var(--ink-2); }\n\n.ty { border-bottom: 1px solid var(--line); padding-bottom: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1); }\n.ty:last-child { border-bottom: 0; padding-bottom: 0; }\n.ty-sample { overflow-wrap: anywhere; }\n\n.sp { display: grid; grid-template-columns: 176px 1fr; align-items: center; gap: var(--space-2); }\n.sp-bar { height: 16px; background: var(--violet); border-radius: var(--radius); }\n\n.shape { width: 64px; height: 64px; background: var(--violet); }\n.shape.round { width: 16px; height: 16px; background: var(--amber-ink); }\n.lines { display: grid; grid-template-columns: 96px auto; align-items: center; gap: var(--space-1) var(--space-2); }\n.ln { display: block; border-top: 1px solid; }\n\n.depth .d0, .depth .d1, .depth .d2 { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2); display: flex; flex-direction: column; gap: var(--space-2); }\n.depth .d0 { background: var(--bg); } .depth .d1 { background: var(--surface); } .depth .d2 { background: var(--surface-raised); }\n\n.menu { background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2); opacity: 0; transform: translateY(-8px); transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease); }\n.menu.open { opacity: 1; transform: none; }\n\n.word { font: 600 50px/56px var(--font-sans); letter-spacing: -0.02em; }\n.marks { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); }\n.marks > div { display: flex; flex-direction: column; gap: var(--space-1); }\n.mk svg { display: block; width: 100%; height: auto; }\n\n.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 40px; padding: var(--space-1) var(--space-2); font: 600 15px/24px var(--font-sans); border-radius: var(--radius); border: 1px solid var(--line-strong); background: transparent; color: var(--ink); cursor: pointer; transition: background-color var(--dur) var(--ease), transform var(--dur) var(--ease); }\n.btn:hover, .btn.hov { background: var(--surface-raised); }\n.btn:active, .btn.press { transform: translateY(1px); }\n.btn.foc { outline: 2px solid var(--focus); outline-offset: 2px; }\n.btn.is-primary { background: var(--amber); color: var(--on-amber); border-color: var(--amber); }\n.btn.is-primary:hover, .btn.is-primary.hov { background: var(--amber-hover); border-color: var(--amber-hover); }\n.btn.is-second { background: var(--violet); color: var(--on-violet); border-color: var(--violet); }\n.btn.is-second:hover { background: var(--violet-hover); border-color: var(--violet-hover); }\n.act { font: inherit; color: var(--ink-3); background: none; border: 0; padding: var(--space-1) 0; cursor: pointer; text-decoration: underline; text-decoration-color: var(--line-strong); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color var(--dur) var(--ease), text-decoration-color var(--dur) var(--ease); }\n.act:hover { color: var(--ink); text-decoration-color: var(--amber-ink); }\n.act.is-danger { color: var(--danger); text-decoration-color: var(--danger); }\n.link { text-decoration: underline; text-decoration-color: var(--amber-ink); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color var(--dur) var(--ease); }\n.link:hover { color: var(--amber-ink); }\n.box { background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-1); }\n.box.inner { background: var(--surface); padding: var(--space-2); margin-top: var(--space-1); }\n.lst { list-style: none; padding: 0 !important; gap: 0 !important; }\n.lst li { display: grid; grid-template-columns: 96px 1fr; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--line); }\n.tag { background: var(--violet); color: var(--on-violet); padding: var(--space-dense) var(--space-1); border-radius: var(--radius); }\n.label { font-weight: 600; }\n.input { width: 100%; min-height: 40px; padding: var(--space-1) var(--space-2); font: 400 15px/24px var(--font-sans); color: var(--ink); background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--radius); }\n.input::placeholder { color: var(--ink-3); }\n.err { color: var(--danger); }\n.check { display: flex; align-items: center; gap: var(--space-1); cursor: pointer; }\n.check input { position: absolute; opacity: 0; pointer-events: none; }\n.box-ch { width: 16px; height: 16px; border: 1px solid var(--line-strong); border-radius: var(--radius); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: transparent; }\n.check input:checked + .box-ch { background: var(--violet); border-color: var(--violet); color: var(--on-violet); }\n.check input:focus-visible + .box-ch { outline: 2px solid var(--focus); outline-offset: 2px; }\n.nav-s { display: flex; gap: var(--space-3); }\n.nav-s a { color: var(--ink-2); text-decoration: none; }\n.nav-s a[aria-current] { color: var(--ink); }\n.chart line { stroke: var(--line); } .chart .b { fill: var(--ink-3); } .chart .z { fill: var(--line); } .chart .hi { fill: var(--amber-ink); }\n.axis { display: flex; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-1); }\n\n.code { font: 400 12px/20px var(--font-mono); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2); overflow: auto; max-height: 480px; color: var(--ink-2); }\n.foot { grid-column: 2; display: flex; justify-content: space-between; padding-top: var(--space-4); border-top: 1px solid var(--line); }\n\n@media (max-width: 760px) {\n  .grid { grid-template-columns: minmax(0, 1fr); }\n  .top, .head, .content, .foot { grid-column: 1; }\n  .toc { display: none; }\n  .top { padding-bottom: var(--space-8); }\n  .display { font-size: 50px; line-height: 56px; letter-spacing: -0.015em; }\n  .heading { font-size: 34px; }\n  .sp { grid-template-columns: 1fr; gap: var(--space-dense); }\n  .word { font-size: 34px; line-height: 40px; }\n}\n@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }\n@media print { .toc, .themes, #copy { display: none !important; } }\n</style>\n</head>\n<body>\n<div class=\"page grid\">\n  <header class=\"top\">\n    <a class=\"home\" href=\"/\">Wolframium</a>\n    <div class=\"themes\" role=\"group\" aria-label=\"Тема\">\n      <button type=\"button\" data-set=\"dark\" aria-pressed=\"true\">Ночь</button>\n      <button type=\"button\" data-set=\"light\" aria-pressed=\"false\">Бумага</button>\n    </div>\n  </header>\n  <div class=\"head\">\n    <h1 class=\"display\">Дизайн-система</h1>\n    <p class=\"lede\">Личная система Wolframium. Бренд — это человек: школьник, который любит математику, физику и программирование и, возможно, станет предпринимателем. Она должна давать ощущение «этот человек думает»: спокойствие, глубина, точность. Форма холодная, как чертёж. Внутри — живой человек.</p>\n    <p class=\"meta\">Wolframium · спокойно, глубоко, точно · версия 1</p>\n  </div>\n  <aside class=\"toc\"><nav aria-label=\"Разделы\"><a href=\"#principy\">Принципы</a><a href=\"#zakony\">Законы</a><a href=\"#golos\">Голос</a><a href=\"#nazvanie\">Название</a><a href=\"#cvet\">Цвет</a><a href=\"#tipografika\">Типографика</a><a href=\"#prostranstvo\">Пространство</a><a href=\"#forma\">Форма</a><a href=\"#glubina\">Глубина</a><a href=\"#dvizhenie\">Движение</a><a href=\"#slova\">Слова вместо иконок</a><a href=\"#vyvod\">Правила вывода</a><a href=\"#chertezhi\">Чертежи</a><a href=\"#tokeny\">Токены</a></nav></aside>\n  <main class=\"content\"><section class=\"sec\" id=\"principy\"><h2 class=\"heading\">Принципы</h2><div class=\"prose\"><p>Каждое решение проверяется этими четырьмя правилами. Если решение спорит хотя бы с одним из них, его меняют.</p>\n<ol>\n<li><strong>Меньше, но точнее.</strong> Если элемент можно убрать без потери смысла, его убирают. Каждый экран отвечает на один вопрос, подробности — на шаг глубже.</li>\n<li><strong>Структура видна.</strong> Сетка, выравнивание и порядок заметны с первого взгляда. Ничего не стоит «примерно».</li>\n<li><strong>Спокойствие по умолчанию.</strong> Всё сдержанное. Акцент один, и он означает «смотри сюда».</li>\n<li><strong>Внутри — человек.</strong> Форма холодная, голос живой.</li>\n</ol></div></section><section class=\"sec\" id=\"zakony\"><h2 class=\"heading\">Законы</h2><div class=\"prose\"><p>Эти правила не нарушаются ни при каких обстоятельствах.</p>\n<ul>\n<li>Глубокий фиолетовый (<code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code>) никогда не светлеет до лавандового. Ни ради контраста, ни ради заметности, ни в одной теме.</li>\n<li>Янтарная заливка (<code class=\"tok\"><i style=\"background:var(--amber)\"></i>amber</code>) — одна вещь на экране. Никогда не фон, не большие площади, не декор. Янтарь как линия — только подчёркивание ссылок, кольцо фокуса и одна выделенная кривая на чертеже.</li>\n<li>Название пишется только так: <strong>Wolframium</strong>. Не сокращается, не переводится, не меняется.</li>\n<li>Никакого чистого чёрного <code>#000</code> и чистого белого текста.</li>\n<li>Никакого неона, свечения, градиентов.</li>\n</ul></div></section><section class=\"sec\" id=\"golos\"><h2 class=\"heading\">Голос</h2><div class=\"prose\"><p>Коротко. Прямо. Точно. На «ты». Юмор сухой.</p>\n<ul>\n<li>Пиши так, будто объясняешь умному другу. Без «пожалуйста», без восклицательных знаков, без канцелярита.</li>\n<li>Шутка — это деталь в конце серьёзной фразы, а не отдельная фраза. Не больше одной на экран.</li>\n<li>Глагол первым на кнопках: «Открыть», «Скачать код». Без «Нажмите здесь».</li>\n</ul>\n<table>\n<thead>\n<tr>\n<th>Вместо</th>\n<th>Пиши</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Страница не найдена. Вернуться на главную.</td>\n<td>Этой страницы не существует. Проверил дважды.</td>\n</tr>\n<tr>\n<td>Школьник, увлекаюсь точными науками.</td>\n<td>Школьник. Разбираю, как устроены вещи — от маятников до компиляторов. Иногда успешно.</td>\n</tr>\n<tr>\n<td>Ваше сообщение успешно отправлено!</td>\n<td>Отправлено.</td>\n</tr>\n</tbody>\n</table></div></section><section class=\"sec\" id=\"nazvanie\"><h2 class=\"heading\">Название</h2><div class=\"prose\"><p><strong>Wolframium</strong> — латинское имя вольфрама, элемент 74. Самый тугоплавкий металл: твёрдый, плотный, не меняется. Нить из вольфрама светится тёплым янтарным светом — отсюда акцент системы.</p>\n<p>Главная подпись — само название, набранное IBM Plex Sans 600 с разрядкой −0.02em, цветом <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>. Никаких эффектов и обводок.</p>\n<p>Где слово не помещается (аватарка, иконка вкладки, угол слайда), ставится <strong>знак</strong> — ячейка таблицы Менделеева: квадрат <code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code> со скруглением <code>radius</code>, номер <code>74</code> начертанием <code>meta</code> в левом верхнем углу, крупная «W» в центре, всё цветом <code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code>. Знак не рисуется отдельно: это контейнер, метаданная и заголовок, сжатые до квадрата.</p>\n<ul>\n<li>Где помещается слово — слово. Где не помещается — знак. Никогда вместе.</li>\n<li>От 64px — полная ячейка с номером. Меньше 64px — только «W», номер становится нечитаемым.</li>\n<li>Файлы знака — ниже, в образце.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · слово и знак</figcaption><div class=\"spec-body\">\n<p class=\"word\">Wolframium</p>\n<div class=\"marks\">\n  <div><div class=\"mk\" style=\"width:96px\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" width=\"96\" height=\"96\"><title>Wolframium</title><rect width=\"96\" height=\"96\" rx=\"2\" fill=\"#3b2475\"/><path fill=\"#eeecf3\" d=\"M10.77 19.17 15.14 9.15H10.24V11.23H9.04V8H16.5V9.18L12.21 19.17Z M23.65 19.17V16.98H18.14V15.79L22.98 8H24.93V15.87H26.59V16.98H24.93V19.17ZM19.34 15.87H23.65V9.04H23.58Z\"/><path fill=\"#eeecf3\" d=\"M31.98 75.54 22.91 36.46H30.3L34.17 55.22L36.58 67.2H36.74L39.54 55.22L44.02 36.46H52.2L56.68 55.22L59.42 67.2H59.59L62.06 55.22L66.03 36.46H73.09L63.74 75.54H55.39L50.41 54.88L48 44.58H47.89L45.37 54.88L40.38 75.54Z\"/></svg></div><span class=\"meta\">96 · полная ячейка</span></div>\n  <div><div class=\"mk\" style=\"width:64px\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" width=\"96\" height=\"96\"><title>Wolframium</title><rect width=\"96\" height=\"96\" rx=\"2\" fill=\"#3b2475\"/><path fill=\"#eeecf3\" d=\"M10.77 19.17 15.14 9.15H10.24V11.23H9.04V8H16.5V9.18L12.21 19.17Z M23.65 19.17V16.98H18.14V15.79L22.98 8H24.93V15.87H26.59V16.98H24.93V19.17ZM19.34 15.87H23.65V9.04H23.58Z\"/><path fill=\"#eeecf3\" d=\"M31.98 75.54 22.91 36.46H30.3L34.17 55.22L36.58 67.2H36.74L39.54 55.22L44.02 36.46H52.2L56.68 55.22L59.42 67.2H59.59L62.06 55.22L66.03 36.46H73.09L63.74 75.54H55.39L50.41 54.88L48 44.58H47.89L45.37 54.88L40.38 75.54Z\"/></svg></div><span class=\"meta\">64</span></div>\n  <div><div class=\"mk\" style=\"width:32px\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\" width=\"32\" height=\"32\"><title>Wolframium</title><rect width=\"32\" height=\"32\" rx=\"1\" fill=\"#3b2475\"/><path fill=\"#eeecf3\" d=\"M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z\"/></svg></div><span class=\"meta\">32 · только W</span></div>\n  <div><div class=\"mk\" style=\"width:16px\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\" width=\"32\" height=\"32\"><title>Wolframium</title><rect width=\"32\" height=\"32\" rx=\"1\" fill=\"#3b2475\"/><path fill=\"#eeecf3\" d=\"M9.14 24.38 5.25 7.62H8.42L10.07 15.66L11.1 20.8H11.18L12.38 15.66L14.3 7.62H17.8L19.72 15.66L20.9 20.8H20.97L22.02 15.66L23.73 7.62H26.75L22.74 24.38H19.17L17.03 15.52L16 11.1H15.95L14.87 15.52L12.74 24.38Z\"/></svg></div><span class=\"meta\">16</span></div>\n</div></div></figure></div></section><section class=\"sec\" id=\"cvet\"><h2 class=\"heading\">Цвет</h2><div class=\"prose\"><p>Основная тема — <code>dark</code> («Ночь»). Светлая <code>light</code> («Бумага») — для печати, PDF и длинного чтения; она строится по правилам тёмной. На сайте «Бумага» включается при печати.</p>\n<p>Три слоя, и каждый отличается от других с первого взгляда:</p>\n<ol>\n<li><strong>Ночь</strong> — <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code>, <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code>, <code class=\"tok\"><i style=\"background:var(--surface-raised)\"></i>surface-raised</code>, <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>. Почти чёрный с глубоким фиолетовым оттенком, как небо через час после заката. Фиолетовый здесь тихий: он задаёт атмосферу, а не кричит.</li>\n<li><strong>Текст</strong> — <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code> для главного, <code class=\"tok\"><i style=\"background:var(--ink-2)\"></i>ink-2</code> для описаний, <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code> для метаданных (даты, номера, версии). Серые почти нейтральны: фиолетового в них едва-едва, чтобы ни один из них не читался как лавандовый.</li>\n<li><strong>Сигнал</strong> — <code class=\"tok\"><i style=\"background:var(--amber)\"></i>amber</code>. Свет раскалённой вольфрамовой нити (около 2700 К) в холодной ночи. Фиолетовый и янтарный — дополнительные цвета, поэтому янтарь виден мгновенно даже маленькой точкой.</li>\n</ol>\n<p>Правила:</p>\n<ul>\n<li>Глубокий фиолетовый живёт подложкой: <code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code> под текстом <code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code> — второстепенные кнопки, метки, выделенные блоки. В тёмной теме он никогда не цвет текста.</li>\n<li>Главная кнопка: заливка <code class=\"tok\"><i style=\"background:var(--amber)\"></i>amber</code>, текст <code class=\"tok\"><i style=\"background:var(--on-amber)\"></i>on-amber</code>. Одна на экран.</li>\n<li>Ссылка в тексте: цвет текста вокруг неё, подчёркивание 1px краской <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code>, отступ 3px. При наведении текст тоже становится <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code>.</li>\n<li>Фокус: кольцо <code class=\"tok\"><i style=\"background:var(--focus)\"></i>focus</code>, сплошное, 2px, с отступом 2px.</li>\n<li><code class=\"tok\"><i style=\"background:var(--success)\"></i>success</code> и <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code> всегда идут со словом или иконкой: цвет не единственный носитель смысла. <code class=\"tok\"><i style=\"background:var(--success)\"></i>success</code> сдвинут к бирюзовому, чтобы не путаться с <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code> при нарушениях цветовосприятия.</li>\n<li>Предупреждения отдельным цветом нет: янтарь уже занят сигналом. Предупреждение — это текст <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code> с иконкой.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · все цвета текущей темы</figcaption><div class=\"spec-body\"><ul class=\"swatches\"><li class=\"sw\" data-name=\"bg\">\n  <span class=\"sw-chip\" style=\"background:var(--bg)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">bg</span><span class=\"meta sw-val\" data-val=\"bg\"></span><span class=\"sw-use\">Фон страницы. Ночь с глубоким фиолетовым оттенком — никогда не чистый чёрный #000.</span><span class=\"meta sw-cr\" data-cr=\"bg\"></span></span>\n</li><li class=\"sw\" data-name=\"surface\">\n  <span class=\"sw-chip\" style=\"background:var(--surface)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">surface</span><span class=\"meta sw-val\" data-val=\"surface\"></span><span class=\"sw-use\">Карточки и блоки поверх bg.</span><span class=\"meta sw-cr\" data-cr=\"surface\"></span></span>\n</li><li class=\"sw\" data-name=\"surface-raised\">\n  <span class=\"sw-chip\" style=\"background:var(--surface-raised)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">surface-raised</span><span class=\"meta sw-val\" data-val=\"surface-raised\"></span><span class=\"sw-use\">То, что лежит поверх surface: меню, всплывающие панели.</span><span class=\"meta sw-cr\" data-cr=\"surface-raised\"></span></span>\n</li><li class=\"sw\" data-name=\"line\">\n  <span class=\"sw-chip\" style=\"background:var(--line)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">line</span><span class=\"meta sw-val\" data-val=\"line\"></span><span class=\"sw-use\">Тонкие линии сетки и разделители. Декоративные: смысл ими не передаётся.</span><span class=\"meta sw-cr\" data-cr=\"line\"></span></span>\n</li><li class=\"sw\" data-name=\"line-strong\">\n  <span class=\"sw-chip\" style=\"background:var(--line-strong)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">line-strong</span><span class=\"meta sw-val\" data-val=\"line-strong\"></span><span class=\"sw-use\">Границы полей ввода и элементов управления. Серо-стальной, как сам вольфрам: почти без фиолетового, чтобы не уходить в лаванду. Не ниже 3:1 на bg, surface и surface-raised в обеих темах.</span><span class=\"meta sw-cr\" data-cr=\"line-strong\"></span></span>\n</li><li class=\"sw\" data-name=\"ink\">\n  <span class=\"sw-chip\" style=\"background:var(--ink)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">ink</span><span class=\"meta sw-val\" data-val=\"ink\"></span><span class=\"sw-use\">Основной текст и заголовки на bg, surface, surface-raised. Приглушённый, не чистый белый.</span><span class=\"meta sw-cr\" data-cr=\"ink\"></span></span>\n</li><li class=\"sw\" data-name=\"ink-2\">\n  <span class=\"sw-chip\" style=\"background:var(--ink-2)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">ink-2</span><span class=\"meta sw-val\" data-val=\"ink-2\"></span><span class=\"sw-use\">Второстепенный текст: описания, подписи под заголовками. На bg, surface, surface-raised.</span><span class=\"meta sw-cr\" data-cr=\"ink-2\"></span></span>\n</li><li class=\"sw\" data-name=\"ink-3\">\n  <span class=\"sw-chip\" style=\"background:var(--ink-3)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">ink-3</span><span class=\"meta sw-val\" data-val=\"ink-3\"></span><span class=\"sw-use\">Метаданные: даты, номера, версии, подписи моноширинным. На bg, surface, surface-raised (≥4.5:1).</span><span class=\"meta sw-cr\" data-cr=\"ink-3\"></span></span>\n</li><li class=\"sw\" data-name=\"violet\">\n  <span class=\"sw-chip\" style=\"background:var(--violet)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">violet</span><span class=\"meta sw-val\" data-val=\"violet\"></span><span class=\"sw-use\">Глубокий фиолетовый — цвет личности. Одинаковый в обеих темах. Никогда не осветляется до лавандового. В тёмной теме — только подложка под on-violet; в светлой может быть и цветом текста.</span><span class=\"meta sw-cr\" data-cr=\"violet\"></span></span>\n</li><li class=\"sw\" data-name=\"violet-hover\">\n  <span class=\"sw-chip\" style=\"background:var(--violet-hover)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">violet-hover</span><span class=\"meta sw-val\" data-val=\"violet-hover\"></span><span class=\"sw-use\">Наведение на подложку violet. Остаётся глубоким: светлее #462b88 не бывает.</span><span class=\"meta sw-cr\" data-cr=\"violet-hover\"></span></span>\n</li><li class=\"sw\" data-name=\"on-violet\">\n  <span class=\"sw-chip\" style=\"background:var(--on-violet)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">on-violet</span><span class=\"meta sw-val\" data-val=\"on-violet\"></span><span class=\"sw-use\">Текст и иконки на violet и violet-hover (10:1).</span><span class=\"meta sw-cr\" data-cr=\"on-violet\"></span></span>\n</li><li class=\"sw\" data-name=\"amber\">\n  <span class=\"sw-chip\" style=\"background:var(--amber)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">amber</span><span class=\"meta sw-val\" data-val=\"amber\"></span><span class=\"sw-use\">Свет вольфрамовой нити — единственный сигнал «смотри сюда»: заливка главной кнопки. Одна заливка на экран, никогда большие площади.</span><span class=\"meta sw-cr\" data-cr=\"amber\"></span></span>\n</li><li class=\"sw\" data-name=\"amber-hover\">\n  <span class=\"sw-chip\" style=\"background:var(--amber-hover)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">amber-hover</span><span class=\"meta sw-val\" data-val=\"amber-hover\"></span><span class=\"sw-use\">Наведение на заливку amber.</span><span class=\"meta sw-cr\" data-cr=\"amber-hover\"></span></span>\n</li><li class=\"sw\" data-name=\"on-amber\">\n  <span class=\"sw-chip\" style=\"background:var(--on-amber)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">on-amber</span><span class=\"meta sw-val\" data-val=\"on-amber\"></span><span class=\"sw-use\">Текст на заливке amber (8.4:1). Никогда не белый.</span><span class=\"meta sw-cr\" data-cr=\"on-amber\"></span></span>\n</li><li class=\"sw\" data-name=\"amber-ink\">\n  <span class=\"sw-chip\" style=\"background:var(--amber-ink)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">amber-ink</span><span class=\"meta sw-val\" data-val=\"amber-ink\"></span><span class=\"sw-use\">Янтарь как линия: подчёркивание ссылок, текст ссылки при наведении. На bg, surface, surface-raised; в светлой теме темнее, чтобы читался (≥5.8:1).</span><span class=\"meta sw-cr\" data-cr=\"amber-ink\"></span></span>\n</li><li class=\"sw\" data-name=\"focus\">\n  <span class=\"sw-chip\" style=\"background:var(--focus)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">focus</span><span class=\"meta sw-val\" data-val=\"focus\"></span><span class=\"sw-use\">Кольцо фокуса клавиатуры: сплошное, 2px, отступ 2px. ≥3:1 на всех поверхностях.</span><span class=\"meta sw-cr\" data-cr=\"focus\"></span></span>\n</li><li class=\"sw\" data-name=\"success\">\n  <span class=\"sw-chip\" style=\"background:var(--success)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">success</span><span class=\"meta sw-val\" data-val=\"success\"></span><span class=\"sw-use\">Готово, работает. Текст и иконки на bg и surface. Всегда со словом или иконкой: не отличается от danger только цветом.</span><span class=\"meta sw-cr\" data-cr=\"success\"></span></span>\n</li><li class=\"sw\" data-name=\"danger\">\n  <span class=\"sw-chip\" style=\"background:var(--danger)\"></span>\n  <span class=\"sw-text\"><span class=\"sw-name\">danger</span><span class=\"meta sw-val\" data-val=\"danger\"></span><span class=\"sw-use\">Ошибка, необратимое действие. Текст и иконки на bg и surface. Всегда со словом или иконкой.</span><span class=\"meta sw-cr\" data-cr=\"danger\"></span></span>\n</li></ul></div></figure></div></section><section class=\"sec\" id=\"tipografika\"><h2 class=\"heading\">Типографика</h2><div class=\"prose\"><p>Два шрифта из одной семьи, и больше никаких: <strong>IBM Plex Sans</strong> для всего текста, <strong>IBM Plex Mono</strong> для метаданных, кода и формул (Google Fonts, отличная кириллица). Они нарисованы по одним правилам, поэтому текст и код выглядят частями одного чертежа. Третий шрифт не добавляется, даже «только для заголовка».</p>\n<p>Шкала контрастная, шаг ×1.5 от <code>body</code> 15px: <code>subheading</code> 22 → <code>heading</code> 34 → <code>title</code> 50 → <code>display</code> 76. Межстрочные интервалы кратны 8px.</p>\n<ul>\n<li><code>display</code> — один раз на экран. Это главный вопрос экрана. Если на экране есть <code>display</code>, <code>title</code> там не нужен.</li>\n<li>На узком экране (до 760px) <code>display</code> спускается на ступень — до размеров <code>title</code>. Остальная шкала не меняется.</li>\n<li>Внутри длинного текста подзаголовки ставь <code>body-strong</code>, а не крупные размеры. Статья не превращается в набор плакатов.</li>\n<li><code>meta</code> — моноширинный, без разрядки, цвет <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>. Номера через «/», даты через точку: <code>Проект / 003 · 12.10.2026</code>.</li>\n<li>Регистр везде как в обычном предложении: заглавная буква в начале каждой самостоятельной подписи, кнопки, действия и статуса, дальше строчные. После разделителя <code>·</code> фраза продолжается строчной: <code>08:46 · исправлено</code>.</li>\n<li>Текста ПРОПИСНЫМИ нет нигде: прописные — это крик, а система спокойная.</li>\n<li>Дата записи: <code>09.10.2026</code> и под ней <code>Пятница</code>; для двух последних дней вместо дня недели — <code>Сегодня</code> и <code>Вчера</code>. Время — <code>21:14</code>, правка отмечается словом: <code>21:14 · исправлено</code>.</li>\n<li><code>code</code> — для кода и формул, в строку и блоком. Блок кода: фон <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code> внутри <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> или <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> внутри <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code>, рамка <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>.</li>\n<li>Только два начертания: 400 и 600. Курсив — для терминов при первом упоминании.</li>\n</ul><figure class=\"spec wide\"><figcaption class=\"meta\">Образец · шкала ×1.5</figcaption><div class=\"spec-body\"><div class=\"ty\"><p class=\"meta\">display · 76px / 80px · 600 · -0.02em</p><p class=\"display ty-sample\">Симулятор орбит</p></div><div class=\"ty\"><p class=\"meta\">title · 50px / 56px · 600 · -0.015em</p><p class=\"title ty-sample\">Проекты</p></div><div class=\"ty\"><p class=\"meta\">heading · 34px / 40px · 600 · -0.01em</p><p class=\"heading ty-sample\">Почему маятник не зависит от массы</p></div><div class=\"ty\"><p class=\"meta\">subheading · 22px / 32px · 600</p><p class=\"subheading ty-sample\">Уравнение движения</p></div><div class=\"ty\"><p class=\"meta\">body · 15px / 24px · 400</p><p class=\"body ty-sample\">Масса входит в уравнение дважды и сокращается.</p></div><div class=\"ty\"><p class=\"meta\">body-strong · 15px / 24px · 600</p><p class=\"body-strong ty-sample\">Уравнение движения</p></div><div class=\"ty\"><p class=\"meta\">meta · 12px / 16px · 400</p><p class=\"meta ty-sample\">Проект / 003 · 12.10.2026</p></div><div class=\"ty\"><p class=\"meta\">code · 14px / 24px · 400</p><p class=\"code ty-sample\">x += v * dt + 0.5 * a * dt**2</p></div></div></figure></div></section><section class=\"sec\" id=\"prostranstvo\"><h2 class=\"heading\">Пространство</h2><div class=\"prose\"><p>Сетка 8px, и воздуха много. Спокойствие создаётся тем, что элементов мало, а не тем, что они маленькие.</p>\n<ul>\n<li>Внутри карточки <code>space-3</code>, между карточками <code>space-6</code>, между разделами <code>space-8</code>.</li>\n<li>Вокруг <code>display</code> не меньше <code>space-8</code> сверху и <code>space-4</code> снизу.</li>\n<li><code>space-dense</code> (4px) — только внутри плотного блока (таблица данных, длинный код). Вокруг такого блока воздух остаётся прежним.</li>\n<li>Выравнивание по левому краю. По центру — только если на экране одна вещь.</li>\n<li>Длина строки текста — не больше 68 знаков (около 640px для <code>body</code>). Длинные строки утомляют, короткие рвут мысль.</li>\n<li>Чертежи и код могут быть шире текстовой колонки, но не шире 960px.</li>\n<li>Страница с потоком записей — две колонки: метаданные 176px слева, текст до 640px справа, зазор <code>space-6</code>. На узком экране метаданные встают над текстом в одну строку.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · сетка 8px</figcaption><div class=\"spec-body\"><div class=\"sp\"><span class=\"meta sp-name\">space-dense · 4px</span><span class=\"sp-bar\" style=\"width:4px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-1 · 8px</span><span class=\"sp-bar\" style=\"width:8px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-2 · 16px</span><span class=\"sp-bar\" style=\"width:16px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-3 · 24px</span><span class=\"sp-bar\" style=\"width:24px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-4 · 32px</span><span class=\"sp-bar\" style=\"width:32px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-6 · 48px</span><span class=\"sp-bar\" style=\"width:48px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-8 · 64px</span><span class=\"sp-bar\" style=\"width:64px\"></span></div><div class=\"sp\"><span class=\"meta sp-name\">space-12 · 96px</span><span class=\"sp-bar\" style=\"width:96px\"></span></div></div></figure></div></section><section class=\"sec\" id=\"forma\"><h2 class=\"heading\">Форма</h2><div class=\"prose\"><ul>\n<li>Одно скругление на всю систему: <code>radius</code> (2px). Никаких «таблеток».</li>\n<li><code>radius-round</code> — только для кругов, которые что-то означают: точка на графике, индикатор статуса.</li>\n<li>Линии толщиной <code>stroke</code> (1px). Сетка и разделители — <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>, границы полей ввода и элементов управления — <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code>.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · скругление и линии</figcaption><div class=\"spec-body\">\n<div class=\"row-x\">\n  <div class=\"shape\" style=\"border-radius:var(--radius)\"></div>\n  <div class=\"shape round\" style=\"border-radius:var(--radius-round)\"></div>\n  <div class=\"lines\"><span class=\"ln\" style=\"border-color:var(--line)\"></span><span class=\"meta\">line</span><span class=\"ln\" style=\"border-color:var(--line-strong)\"></span><span class=\"meta\">line-strong</span></div>\n</div></div></figure></div></section><section class=\"sec\" id=\"glubina\"><h2 class=\"heading\">Глубина</h2><div class=\"prose\"><p>Теней нет. Глубину передают ступени поверхностей и линии, как на чертеже: <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code> → <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> → <code class=\"tok\"><i style=\"background:var(--surface-raised)\"></i>surface-raised</code>, каждая ступень с рамкой <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>. Чем выше слой, тем светлее поверхность (в тёмной теме).</p><figure class=\"spec \"><figcaption class=\"meta\">Образец · ступени поверхностей</figcaption><div class=\"spec-body\">\n<div class=\"depth\"><div class=\"d0\"><span class=\"meta\">bg</span><div class=\"d1\"><span class=\"meta\">surface</span><div class=\"d2\"><span class=\"meta\">surface-raised</span></div></div></div></div></div></figure></div></section><section class=\"sec\" id=\"dvizhenie\"><h2 class=\"heading\">Движение</h2><div class=\"prose\"><p>Физика остаётся физикой: она живёт в содержании, а не в декоре интерфейса.</p>\n<ul>\n<li>Длительность 120ms, кривая ease-out <code>cubic-bezier(0.215, 0.61, 0.355, 1)</code>.</li>\n<li>Анимируются только прозрачность и сдвиг не больше 8px. Без масштабирования, вращения, отскоков.</li>\n<li>Движение только объясняет, что изменилось: появление меню, смена состояния. Декоративных анимаций нет.</li>\n<li>При системной настройке «уменьшить движение» — без анимации вовсе.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · 120 мс, ease-out</figcaption><div class=\"spec-body\">\n<button class=\"btn\" type=\"button\" id=\"motion-btn\">Показать меню</button>\n<div class=\"menu\" id=\"motion-menu\" aria-hidden=\"true\"><p>Меню появилось. Сдвиг 8px и прозрачность — больше ничего.</p></div></div></figure></div></section><section class=\"sec\" id=\"slova\"><h2 class=\"heading\">Слова вместо иконок</h2><div class=\"prose\"><p>Набора иконок нет. Где обычно ставят значок, пиши слово: «Настройки», «Поиск», «Меню». Слово точнее значка, и в нём звучит голос.</p>\n<ul>\n<li>Без подписи разрешены только три символа самого шрифта Plex: <code>→</code> дальше, <code>↗</code> внешняя ссылка, <code>×</code> закрыть.</li>\n<li>Остальные символы шрифта (<code>←</code> <code>+</code> <code>−</code> <code>✓</code>) — только рядом со словом: «← Назад», «+ Добавить».</li>\n<li>На узком экране слово сокращают, а не заменяют значком.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\">\n<div class=\"row-x\"><a class=\"link\" href=\"#vyvod\">Дальше →</a><a class=\"link\" href=\"https://wolframium.vercel.app\">Сайт ↗</a><button class=\"act\" type=\"button\">× Закрыть</button><button class=\"act\" type=\"button\">← Назад</button></div></div></figure></div></section><section class=\"sec\" id=\"vyvod\"><h2 class=\"heading\">Правила вывода</h2><div class=\"prose\"><p>Готовых компонентов нет. Любой элемент выводится из токенов по этим формулам. Если элемент нельзя вывести однозначно, дополняется правило, а не рисуется образец.</p><section class=\"sub\"><h3 class=\"subheading\">Нажимаемое</h3><p>Подпись <code>body-strong</code>, глагол первым. Отступы <code>space-1</code> по вертикали и <code>space-2</code> по горизонтали, высота 40px. Скругление <code>radius</code>. Три веса, от главного к тихому:</p>\n<table>\n<thead>\n<tr>\n<th>Вес</th>\n<th>Заливка</th>\n<th>Текст</th>\n<th>Сколько</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>Главное</td>\n<td><code class=\"tok\"><i style=\"background:var(--amber)\"></i>amber</code></td>\n<td><code class=\"tok\"><i style=\"background:var(--on-amber)\"></i>on-amber</code></td>\n<td>одно на экран</td>\n</tr>\n<tr>\n<td>Второе</td>\n<td><code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code></td>\n<td><code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code></td>\n<td>сколько нужно</td>\n</tr>\n<tr>\n<td>Тихое</td>\n<td>нет, рамка <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code></td>\n<td><code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code></td>\n<td>сколько нужно</td>\n</tr>\n</tbody>\n</table><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><div class=\"row-x\"><button class=\"btn is-primary\" type=\"button\">Записать</button><button class=\"btn is-second\" type=\"button\">Сохранить</button><button class=\"btn\" type=\"button\">Отмена</button></div></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Состояния</h3><p>Одинаковые для всего, что реагирует на человека.</p>\n<ul>\n<li><strong>Наведение:</strong> заливка становится <code>*-hover</code> (<code class=\"tok\"><i style=\"background:var(--amber-hover)\"></i>amber-hover</code>, <code class=\"tok\"><i style=\"background:var(--violet-hover)\"></i>violet-hover</code>); у тихого появляется фон <code class=\"tok\"><i style=\"background:var(--surface-raised)\"></i>surface-raised</code>.</li>\n<li><strong>Нажатие:</strong> как наведение плюс сдвиг вниз на 1px.</li>\n<li><strong>Фокус с клавиатуры:</strong> кольцо <code class=\"tok\"><i style=\"background:var(--focus)\"></i>focus</code> толщиной <code>focus-width</code> с отступом <code>focus-offset</code>. Никогда не убирается.</li>\n<li><strong>Недоступно:</strong> избегай. Лучше оставить элемент активным и словами объяснить, почему действие сейчас не сработает. Если без этого нельзя: заливку снять, текст <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>, рядом причина словами.</li>\n<li>Переходы между состояниями — по правилам движения: 120ms ease-out.</li>\n<li>Пустой ввод не блокирует кнопку: нажатие оставляет фокус в поле и словами говорит, чего не хватает.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><div class=\"row-x\"><button class=\"btn is-primary\" type=\"button\">Обычное</button><button class=\"btn is-primary hov\" type=\"button\">Наведение</button><button class=\"btn is-primary hov press\" type=\"button\">Нажатие</button><button class=\"btn is-primary foc\" type=\"button\">Фокус</button></div><p class=\"meta\" style=\"margin-top:var(--space-2)\">Наведи и нажми — первая кнопка живая.</p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Действие в строке</h3><p>Мелкие действия рядом с метаданными («Исправить», «Вычеркнуть», «Войти» в подвале) — не кнопки, а слова: стиль окружающего текста (обычно <code>meta</code>), цвет <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>, подчёркивание 1px <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code> с отступом 3px. При наведении — текст <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>, подчёркивание <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code>. Зазор между такими действиями <code>space-2</code>.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><p class=\"meta row-x\"><span>18:46 · исправлено</span><button class=\"act\" type=\"button\">Исправить</button><button class=\"act\" type=\"button\">Вычеркнуть</button></p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Опасное действие</h3><p>Отдельной красной кнопки нет. Необратимое действие сначала спрашивает словами: «Точно?», затем «Да, вычеркнуть» — действие в строке цветом <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code> с подчёркиванием <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code> — и «Отмена». Фокус встаёт на «Отмена».</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><p class=\"meta row-x\"><span>Точно?</span><button class=\"act is-danger\" type=\"button\">Да, вычеркнуть</button><button class=\"act\" type=\"button\">Отмена</button></p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Ссылка</h3><p>Цвет окружающего текста, подчёркивание <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code> 1px с отступом 3px. Внешняя ссылка заканчивается <code>↗</code>. Текст ссылки называет, куда она ведёт: «Код на GitHub ↗», а не «здесь».</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><p>Код лежит <a class=\"link\" href=\"https://github.com/wolframium-main/wolframium\">на GitHub ↗</a>, а правила — <a class=\"link\" href=\"#principy\">в начале этой страницы</a>.</p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Контейнер</h3><p>Фон на ступень выше родителя (<code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code> → <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> → <code class=\"tok\"><i style=\"background:var(--surface-raised)\"></i>surface-raised</code>), рамка <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>, скругление <code>radius</code>, внутри <code>space-3</code>. Больше двух ступеней вложенности нет: третью заменяет линия-разделитель.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><div class=\"box\"><p class=\"meta\">Проект / 003</p><p class=\"subheading\">Симулятор орбит</p><p class=\"ink-2\">Метод Верле, три тела, никаких библиотек. Луна пока улетает.</p><div class=\"box inner\"><p class=\"meta\">Вторая ступень — последняя</p></div></div></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Список</h3><p>Строки разделены линией <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>, по вертикали <code>space-2</code>. Метаданные строки — <code>meta</code> над заголовком строки.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><ul class=\"lst\"><li><span class=\"meta\">003 · 2026</span><span>Симулятор орбит</span></li><li><span class=\"meta\">002 · 2026</span><span>Решатель судоку</span></li><li><span class=\"meta\">001 · 2025</span><span>Калькулятор матриц</span></li></ul></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Метка</h3><p>Текст <code>meta</code>, фон <code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code>, текст <code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code>, отступы <code>space-dense</code> по вертикали и <code>space-1</code> по горизонтали, скругление <code>radius</code>.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><div class=\"row-x\"><span class=\"tag meta\">Физика</span><span class=\"tag meta\">Код</span><span class=\"tag meta\">Геометрия</span></div></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Поле ввода</h3><ul>\n<li>Метка над полем: <code>body-strong</code>, <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>, зазор <code>space-1</code>.</li>\n<li>Поле: фон на ступень в сторону от родителя — на <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code> это <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code>, на <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> это <code class=\"tok\"><i style=\"background:var(--bg)\"></i>bg</code>. Рамка <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code>, текст <code>body</code> <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>, высота 40px, отступы как у нажимаемого. Многострочное поле — от 96px, растёт вместе с текстом.</li>\n<li>Подсказка внутри — настоящий пример, цвет <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>: «tungsten@example.com».</li>\n<li>Ошибка под полем или рядом с кнопкой: <code>body</code> цветом <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code>, не <code>meta</code>. Сначала что случилось, потом что делать: «Нет @. Проверь адрес».</li>\n<li>Подсказка клавиш (<code>Ctrl + Enter</code>) — <code>meta</code> <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code> рядом с кнопкой. На сенсорных экранах не показывается.</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><label class=\"label\" for=\"f1\">Почта</label><input class=\"input\" id=\"f1\" placeholder=\"tungsten@example.com\" value=\"tungsten.example.com\"><p class=\"err\">Нет @. Проверь адрес.</p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Выбор</h3><p>Квадрат 16px, рамка <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code>, скругление <code>radius</code>. Выбрано: заливка <code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code>, внутри <code>✓</code> цветом <code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code>. Подпись справа через <code>space-1</code>, <code>body</code>.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><label class=\"check\"><input type=\"checkbox\" checked><span class=\"box-ch\" aria-hidden=\"true\">✓</span><span>Показывать черновики</span></label><label class=\"check\"><input type=\"checkbox\"><span class=\"box-ch\" aria-hidden=\"true\">✓</span><span>Писать каждый день</span></label></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Статус</h3><p>Слово <code>meta</code> плюс короткое пояснение: <code>Готово</code> цветом <code class=\"tok\"><i style=\"background:var(--success)\"></i>success</code>, <code>Ошибка</code> цветом <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code>. Без цветных плашек и фонов.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><p class=\"row-x\"><span class=\"meta\" style=\"color:var(--success)\">Готово</span><span>Запись сохранена.</span></p><p class=\"row-x\"><span class=\"meta\" style=\"color:var(--danger)\">Ошибка</span><span>Не сохранилось. Текст на месте, попробуй ещё раз.</span></p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Выделение текста</h3><p>Выделенный мышью текст: фон <code class=\"tok\"><i style=\"background:var(--violet)\"></i>violet</code>, текст <code class=\"tok\"><i style=\"background:var(--on-violet)\"></i>on-violet</code>.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><p>Выдели мышью эту строку, чтобы увидеть, как выглядит выделение.</p></div></figure></section><section class=\"sub\"><h3 class=\"subheading\">Навигация</h3><p>Слова в строку, <code>body</code>, зазор <code>space-3</code>. Текущий раздел — <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>, остальные — <code class=\"tok\"><i style=\"background:var(--ink-2)\"></i>ink-2</code>. Без янтаря: он занят главным действием.</p><figure class=\"spec \"><figcaption class=\"meta\">Образец</figcaption><div class=\"spec-body\"><nav class=\"nav-s\"><a aria-current=\"page\" href=\"#vyvod\">Сейчас</a><a href=\"#vyvod\">Записи</a><a href=\"#vyvod\">Избранет</a></nav></div></figure></section></div></section><section class=\"sec\" id=\"chertezhi\"><h2 class=\"heading\">Чертежи</h2><div class=\"prose\"><p>Все изображения в системе — чертежи по её же правилам: графики, схемы, диаграммы, траектории. Фотографий нет. Лучшая картинка — сам разбор.</p>\n<ul>\n<li><strong>Скриншоты</strong> своих проектов разрешены как экспонаты: на <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code>, в рамке <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>, скругление <code>radius</code>, подпись <code>meta</code> под ним через <code>space-1</code>.</li>\n<li><strong>Оси и сетка</strong> тихие: линии <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code> толщиной <code>stroke</code>, только горизонтальная сетка и только если без неё не прочитать значение. Подписи осей и делений — <code>meta</code>, цвет <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>. Рамки вокруг графика нет.</li>\n<li><strong>Одна ось Y.</strong> Две величины разного масштаба — два графика рядом.</li>\n<li><strong>Линии данных</strong> толщиной 2px, точки 8px со скруглением <code>radius-round</code>, столбцы со скруглением <code>radius</code> и зазором 2px между ними.</li>\n<li><strong>Цвет данных:</strong></li>\n<li>главная серия — <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>;</li>\n<li>фон и сравнение — <code class=\"tok\"><i style=\"background:var(--ink-3)\"></i>ink-3</code>;</li>\n<li>одна выделенная кривая или точка — <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code> («смотри сюда»). Одна на чертёж.</li>\n<li><strong>Серии различаются подписью, а не цветом.</strong> Подпись — словом прямо у конца линии (<code>meta</code>, цвет <code class=\"tok\"><i style=\"background:var(--ink-2)\"></i>ink-2</code>), плюс рисунок линии: сплошная, пунктир 6/4, точки 2/4. Больше трёх серий — несколько маленьких графиков рядом с общей осью, а не радуга.</li>\n<li><strong>Величина на поле</strong> (тепловая карта): от <code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code> к <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code> через серые ступени. Важная ячейка обводится <code class=\"tok\"><i style=\"background:var(--amber-ink)\"></i>amber-ink</code>, а не заливается.</li>\n<li><strong>Схемы:</strong> блоки — контейнеры (<code class=\"tok\"><i style=\"background:var(--surface)\"></i>surface</code>, рамка <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>, <code>radius</code>), стрелки — <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code> 1px с наконечником <code>→</code>, подписи <code>body</code> или <code>meta</code>.</li>\n<li><strong>Формулы:</strong> в строке — <code>code</code>. Отдельная формула — на своей строке, <code>code</code>, по левому краю колонки; номер <code>(1)</code> — <code>meta</code> справа.</li>\n<li><strong>Наведение</strong> на график: вертикальная линия <code class=\"tok\"><i style=\"background:var(--line-strong)\"></i>line-strong</code> 1px и подсказка на <code class=\"tok\"><i style=\"background:var(--surface-raised)\"></i>surface-raised</code> с рамкой <code class=\"tok\"><i style=\"background:var(--line)\"></i>line</code>; значения в подсказке цветом <code class=\"tok\"><i style=\"background:var(--ink)\"></i>ink</code>.</li>\n<li><code class=\"tok\"><i style=\"background:var(--success)\"></i>success</code> и <code class=\"tok\"><i style=\"background:var(--danger)\"></i>danger</code> в чертежах не используются: это цвета статусов, а не данных.</li>\n<li>Подписи осей и выводы — обычным текстом страницы под рисунком, а не внутри SVG: при сжатии на телефоне рисунок уменьшается, а подписи остаются 12px. Рисунок не растягивается шире своего естественного размера.</li>\n<li>Вывод чертежа — одна строка <code>meta</code> словами: «Писал 7 дней из 9. Больше всего — 9 записей, 04.10.2026».</li>\n</ul><figure class=\"spec \"><figcaption class=\"meta\">Образец · ритм записей</figcaption><div class=\"spec-body\"><div style=\"width:180px;max-width:100%\"><svg viewBox=\"0 0 180 89\" width=\"180\" height=\"89\" class=\"chart\" role=\"img\" aria-label=\"Записи по дням\"><line x1=\"0\" y1=\"88.5\" x2=\"180\" y2=\"88.5\"/><rect class=\"b\" x=\"3\" y=\"61\" width=\"14\" height=\"27\" rx=\"2\"/><rect class=\"b\" x=\"23\" y=\"8\" width=\"14\" height=\"80\" rx=\"2\"/><rect class=\"b\" x=\"43\" y=\"35\" width=\"14\" height=\"53\" rx=\"2\"/><rect class=\"b\" x=\"63\" y=\"70\" width=\"14\" height=\"18\" rx=\"2\"/><rect class=\"b\" x=\"83\" y=\"44\" width=\"14\" height=\"44\" rx=\"2\"/><rect class=\"b\" x=\"103\" y=\"79\" width=\"14\" height=\"9\" rx=\"2\"/><rect class=\"hi\" x=\"123\" y=\"52\" width=\"14\" height=\"36\" rx=\"2\"/><rect class=\"z\" x=\"143\" y=\"86\" width=\"14\" height=\"2\"/><rect class=\"z\" x=\"163\" y=\"86\" width=\"14\" height=\"2\"/></svg><div class=\"axis meta\"><span>03.10.2026</span><span>Сегодня</span></div></div>\n<p class=\"meta\" style=\"margin-top:var(--space-2)\">Писал 7 дней из 9. Больше всего — 9 записей, 04.10.2026. Выделенный янтарём столбик — тот, на который нужно смотреть.</p></div></figure></div></section><section class=\"sec\" id=\"tokeny\"><h2 class=\"heading\">Токены</h2><div class=\"prose\">\n<p>Всё, что выше, сводится к этому файлу. Подключи его — и цвета, отступы, скругления и шрифтовые стили будут те же, что здесь. Тема по умолчанию — «Ночь»; «Бумага» включается атрибутом <code>data-theme=\"light\"</code>. Шрифты — IBM Plex Sans и IBM Plex Mono из Google Fonts.</p>\n<p class=\"row-x meta\"><button class=\"act\" type=\"button\" id=\"copy\">Скопировать tokens.css</button><span id=\"copy-say\" role=\"status\"></span></p>\n<pre class=\"code\" id=\"tokens-css\">/* Wolframium — generated from tokens.json */\n:root, [data-theme=&quot;dark&quot;] {\n  --bg: #100d18;\n  --surface: #171325;\n  --surface-raised: #1f1a31;\n  --line: #2c2645;\n  --line-strong: #6e6b82;\n  --ink: #e9e7ef;\n  --ink-2: #b3b0c0;\n  --ink-3: #8f8c9f;\n  --violet: #3b2475;\n  --violet-hover: #462b88;\n  --on-violet: #eeecf3;\n  --amber: #f2a93b;\n  --amber-hover: #f5b95e;\n  --on-amber: #2a1a04;\n  --amber-ink: #f2a93b;\n  --focus: var(--amber);\n  --success: #5fc9a8;\n  --danger: #f47c86;\n  color-scheme: dark;\n}\n[data-theme=&quot;light&quot;] {\n  --bg: #f4f3f8;\n  --surface: #fbfafd;\n  --surface-raised: #ffffff;\n  --line: #dcd8e6;\n  --line-strong: #8b889c;\n  --ink: #16121f;\n  --ink-2: #4a4757;\n  --ink-3: #67647a;\n  --violet: #3b2475;\n  --violet-hover: #2e1b5e;\n  --on-violet: #eeecf3;\n  --amber: #f2a93b;\n  --amber-hover: #e09524;\n  --on-amber: #2a1a04;\n  --amber-ink: #8a5200;\n  --focus: var(--amber-ink);\n  --success: #17735a;\n  --danger: #b3263a;\n  color-scheme: light;\n}\n:root {\n  --space-dense: 4px;\n  --space-1: 8px;\n  --space-2: 16px;\n  --space-3: 24px;\n  --space-4: 32px;\n  --space-6: 48px;\n  --space-8: 64px;\n  --space-12: 96px;\n  --radius: 2px;\n  --radius-round: 50%;\n  --stroke: 1px;\n  --focus-width: 2px;\n  --focus-offset: 2px;\n  --font-sans: &quot;IBM Plex Sans&quot;, system-ui, sans-serif;\n  --font-mono: &quot;IBM Plex Mono&quot;, ui-monospace, monospace;\n}\n.display { font-family: var(--font-sans); font-size: 76px; line-height: 80px; font-weight: 600; letter-spacing: -0.02em; }\n.title { font-family: var(--font-sans); font-size: 50px; line-height: 56px; font-weight: 600; letter-spacing: -0.015em; }\n.heading { font-family: var(--font-sans); font-size: 34px; line-height: 40px; font-weight: 600; letter-spacing: -0.01em; }\n.subheading { font-family: var(--font-sans); font-size: 22px; line-height: 32px; font-weight: 600; }\n.body { font-family: var(--font-sans); font-size: 15px; line-height: 24px; font-weight: 400; }\n.body-strong { font-family: var(--font-sans); font-size: 15px; line-height: 24px; font-weight: 600; }\n.meta { font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 400; }\n.code { font-family: var(--font-mono); font-size: 14px; line-height: 24px; font-weight: 400; }</pre>\n</div></section></main>\n  <footer class=\"foot meta\"><span>С 2026 · Wolframium</span><a class=\"act\" href=\"#principy\">Наверх</a></footer>\n</div>\n<script>\n(function () {\n  \"use strict\";\n  var root = document.documentElement;\n  var KEY = \"wolframium-ds-theme\";\n  function lum(rgb) {\n    var m = rgb.match(/\\d+(\\.\\d+)?/g); if (!m) return 0;\n    var c = m.slice(0, 3).map(function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });\n    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];\n  }\n  function ratio(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }\n  var probe = document.createElement(\"span\"); document.body.appendChild(probe);\n  function color(name) { probe.style.color = \"var(--\" + name + \")\"; return getComputedStyle(probe).color; }\n  function hex(rgb) { var m = rgb.match(/\\d+/g); return m ? \"#\" + m.slice(0, 3).map(function (v) { return (\"0\" + (+v).toString(16)).slice(-2); }).join(\"\") : rgb; }\n  var TEXT = { \"ink\": \"bg\", \"ink-2\": \"bg\", \"ink-3\": \"surface\", \"amber-ink\": \"bg\", \"success\": \"bg\", \"danger\": \"bg\", \"on-violet\": \"violet\", \"on-amber\": \"amber\", \"line-strong\": \"bg\" };\n  function refresh() {\n    Array.prototype.forEach.call(document.querySelectorAll(\"[data-val]\"), function (el) { el.textContent = hex(color(el.getAttribute(\"data-val\"))); });\n    Array.prototype.forEach.call(document.querySelectorAll(\"[data-cr]\"), function (el) {\n      var n = el.getAttribute(\"data-cr\"), g = TEXT[n];\n      el.textContent = g ? \"Контраст на \" + g + \": \" + ratio(color(n), color(g)).toFixed(1) + \":1\" : \"\";\n    });\n  }\n  function setTheme(t) {\n    root.setAttribute(\"data-theme\", t);\n    Array.prototype.forEach.call(document.querySelectorAll(\"[data-set]\"), function (b) { b.setAttribute(\"aria-pressed\", String(b.getAttribute(\"data-set\") === t)); });\n    try { localStorage.setItem(KEY, t); } catch (e) {}\n    requestAnimationFrame(refresh);\n  }\n  var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}\n  setTheme(saved === \"light\" ? \"light\" : \"dark\");\n  Array.prototype.forEach.call(document.querySelectorAll(\"[data-set]\"), function (b) { b.onclick = function () { setTheme(b.getAttribute(\"data-set\")); }; });\n\n  var mb = document.getElementById(\"motion-btn\"), mm = document.getElementById(\"motion-menu\");\n  if (mb) mb.onclick = function () { var open = mm.classList.toggle(\"open\"); mm.setAttribute(\"aria-hidden\", String(!open)); mb.textContent = open ? \"Скрыть меню\" : \"Показать меню\"; };\n\n  var copy = document.getElementById(\"copy\"), say = document.getElementById(\"copy-say\");\n  copy.onclick = function () {\n    var text = document.getElementById(\"tokens-css\").textContent;\n    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { say.textContent = \"Скопировано\"; say.style.color = \"var(--success)\"; }, function () { say.textContent = \"Не скопировалось. Выдели текст ниже вручную.\"; say.style.color = \"var(--danger)\"; });\n  };\n\n  var links = Array.prototype.slice.call(document.querySelectorAll(\".toc a\"));\n  var secs = links.map(function (a) { return document.querySelector(a.getAttribute(\"href\")); });\n  function spy() {\n    var y = window.scrollY + 120, cur = 0;\n    secs.forEach(function (s, i) { if (s && s.offsetTop <= y) cur = i; });\n    links.forEach(function (a, i) { if (i === cur) a.setAttribute(\"aria-current\", \"true\"); else a.removeAttribute(\"aria-current\"); });\n  }\n  window.addEventListener(\"scroll\", spy, { passive: true }); spy();\n})();\n</script>\n</body>\n</html>\n";

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
      <span>С 2026 · <a class="act" href="/sistema">Дизайн-система</a></span>
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
    if (p === "/sistema") return new Response(SISTEMA, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
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
