// White Cloud 2 website + inventory admin. Zero dependencies (Node 18+).
//
// Environment variables (set these in Railway → Variables):
//   ADMIN_PASSWORD   required to log in at /admin
//   SESSION_SECRET   optional, any long random string (keeps logins valid across restarts)
//   DATA_DIR         where inventory.json and uploaded photos live. On Railway, attach a
//                    Volume mounted at /data and set DATA_DIR=/data so data survives redeploys.

const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "inventory.json");
const SEED_FILE = path.join(__dirname, "seed", "inventory.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("wc2:" + ADMIN_PASSWORD).digest("hex");
const SESSION_HOURS = 12;
const MAX_BODY = 9 * 1024 * 1024;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml"
};

/* ---------------- data store ---------------- */
let db = null;
let writing = Promise.resolve();

async function loadDb() {
  await fsp.mkdir(UPLOADS, { recursive: true });
  try {
    db = JSON.parse(await fsp.readFile(DB_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      // Corrupt file: try the backup before falling back to seed
      try { db = JSON.parse(await fsp.readFile(DB_FILE + ".bak", "utf8")); console.warn("Loaded backup inventory"); }
      catch { db = null; }
    }
    if (!db) {
      db = JSON.parse(await fsp.readFile(SEED_FILE, "utf8"));
      console.log("Seeded inventory from seed/inventory.json");
    }
    await saveDb();
  }
}
function saveDb() {
  db.updated = new Date().toISOString();
  const data = JSON.stringify(db, null, 2);
  writing = writing.then(async () => {
    try { await fsp.copyFile(DB_FILE, DB_FILE + ".bak"); } catch {}
    const tmp = DB_FILE + ".tmp";
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, DB_FILE);
  });
  return writing;
}

function status(p) {
  if (p.qty === null || p.qty === undefined || p.qty === "") return "untracked";
  if (p.qty <= 0) return "out";
  if (p.qty <= (p.low ?? 3)) return "low";
  return "in";
}
function publicCatalog() {
  const cats = [...db.categories].sort((a, b) => a.order - b.order);
  return {
    updated: db.updated,
    categories: cats.map(c => ({
      id: c.id, name: c.name, desc: c.desc, glow: c.glow, law: c.law || "", defaultType: c.defaultType,
      items: db.products.filter(p => p.cat === c.id && p.visible !== false)
        .sort((a, b) => a.order - b.order)
        .map(p => ({ id: p.id, name: p.name, desc: p.desc, specs: p.specs || [], price: p.price, status: status(p), img: p.img || "", type: p.type, c: p.c }))
    }))
  };
}

/* ---------------- validation ---------------- */
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function cleanProduct(input, existing) {
  const p = existing ? { ...existing } : {};
  if ("name" in input) p.name = str(input.name, 120);
  if ("desc" in input) p.desc = str(input.desc, 500);
  if ("cat" in input) p.cat = str(input.cat, 40);
  if ("specs" in input) {
    const arr = Array.isArray(input.specs) ? input.specs : String(input.specs || "").split(",");
    p.specs = arr.map(s => str(String(s), 40)).filter(Boolean).slice(0, 6);
  }
  if ("price" in input) {
    const n = input.price === "" || input.price === null ? null : Number(input.price);
    p.price = n === null || !isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100;
  }
  if ("qty" in input) {
    const n = input.qty === "" || input.qty === null ? null : Math.floor(Number(input.qty));
    p.qty = n === null || !isFinite(n) ? null : Math.max(0, Math.min(n, 99999));
  }
  if ("low" in input) { const n = Math.floor(Number(input.low)); p.low = isFinite(n) && n >= 0 ? Math.min(n, 9999) : 3; }
  if ("visible" in input) p.visible = !!input.visible;
  if ("img" in input) {
    const u = str(input.img, 600);
    p.img = /^(https:\/\/|\/uploads\/|photos\/|\/photos\/)/.test(u) ? u : "";
  }
  if (!p.name) throw new Error("Give the product a name.");
  if (!db.categories.some(c => c.id === p.cat)) throw new Error("Pick a category.");
  if (!p.type) p.type = db.categories.find(c => c.id === p.cat).defaultType || "pouch";
  if (!p.c) { const g = db.categories.find(c => c.id === p.cat).glow || "#4E36C9"; p.c = { a: g, b: "#2E2A3A" }; }
  if (p.low === undefined) p.low = 3;
  if (p.visible === undefined) p.visible = true;
  if (!p.specs) p.specs = [];
  if (p.price === undefined) p.price = null;
  if (p.qty === undefined) p.qty = null;
  p.updated = new Date().toISOString();
  return p;
}

/* ---------------- sessions ---------------- */
const b64 = s => Buffer.from(s).toString("base64url");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeToken() { const body = b64(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600e3 })); return body + "." + sign(body); }
function validToken(t) {
  if (!t || !t.includes(".")) return false;
  const [body, sig] = t.split(".");
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(c => { const i = c.indexOf("="); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
const isAuthed = req => validToken(cookies(req).wc2_admin);
const secureFlag = req => (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

const fails = new Map(); // ip -> {n, until}
function ipOf(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress; }
function passwordOk(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return ADMIN_PASSWORD.length > 0 && crypto.timingSafeEqual(a, b);
}

/* ---------------- helpers ---------------- */
function send(res, code, obj, extra = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers["content-type"] || "").includes("application/json")) return reject(Object.assign(new Error("Expected JSON"), { code: 415 }));
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error("That file is too large. Use a photo under 8 MB."), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error("Bad JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}
function serveFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": cache || (ext === ".html" ? "no-cache" : "public, max-age=604800"),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    });
    res.end(data);
  });
}
function notFound(res) {
  fs.readFile(path.join(ROOT, "index.html"), (e, home) => { res.writeHead(e ? 500 : 404, { "Content-Type": TYPES[".html"] }); res.end(home || "Not found"); });
}
const safeJoin = (base, p) => { const f = path.normalize(path.join(base, p)); return f.startsWith(base) ? f : null; };

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const m = req.method;
  const parts = url.split("/").filter(Boolean); // ["api", ...]

  if (url === "/api/catalog" && m === "GET") return send(res, 200, publicCatalog(), { "Cache-Control": "no-cache" });

  if (url === "/api/admin/login" && m === "POST") {
    if (!ADMIN_PASSWORD) return send(res, 503, { error: "Admin is turned off. Set ADMIN_PASSWORD in Railway Variables, then redeploy." });
    const ip = ipOf(req), f = fails.get(ip);
    if (f && f.until > Date.now()) return send(res, 429, { error: "Too many tries. Wait 15 minutes and try again." });
    const body = await readJson(req);
    if (!passwordOk(body.password)) {
      const n = (f && f.until > Date.now() - 15 * 60e3 ? f.n : 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 });
      return send(res, 401, { error: "That password is not right." });
    }
    fails.delete(ip);
    return send(res, 200, { ok: true }, { "Set-Cookie": `wc2_admin=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secureFlag(req)}` });
  }
  if (url === "/api/admin/logout" && m === "POST") return send(res, 200, { ok: true }, { "Set-Cookie": `wc2_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(req)}` });
  if (url === "/api/admin/me" && m === "GET") return send(res, 200, { authed: isAuthed(req), enabled: !!ADMIN_PASSWORD });

  if (parts[1] !== "admin") return send(res, 404, { error: "Not found" });
  if (!isAuthed(req)) return send(res, 401, { error: "Please log in again." });

  if (url === "/api/admin/inventory" && m === "GET") return send(res, 200, db);

  if (url === "/api/admin/export" && m === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="white-cloud-2-inventory-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db, null, 2));
  }

  if (url === "/api/admin/products" && m === "POST") {
    const p = cleanProduct(await readJson(req));
    p.id = (p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item") + "-" + crypto.randomBytes(3).toString("hex");
    p.order = Math.max(-1, ...db.products.filter(x => x.cat === p.cat).map(x => x.order)) + 1;
    db.products.push(p); await saveDb();
    return send(res, 201, p);
  }

  if (parts[2] === "products" && parts[3]) {
    const idx = db.products.findIndex(p => p.id === parts[3]);
    if (idx < 0) return send(res, 404, { error: "That product no longer exists. Refresh the page." });
    if (parts[4] === "move" && m === "POST") {
      const { dir } = await readJson(req);
      const p = db.products[idx];
      const sib = db.products.filter(x => x.cat === p.cat).sort((a, b) => a.order - b.order);
      const i = sib.indexOf(p), j = i + (dir < 0 ? -1 : 1);
      if (j >= 0 && j < sib.length) { [sib[i], sib[j]] = [sib[j], sib[i]]; sib.forEach((x, k) => (x.order = k)); await saveDb(); }
      return send(res, 200, { ok: true });
    }
    if (m === "PUT") {
      const before = db.products[idx];
      const p = cleanProduct(await readJson(req), before);
      if (p.cat !== before.cat) p.order = Math.max(-1, ...db.products.filter(x => x.cat === p.cat).map(x => x.order)) + 1;
      db.products[idx] = p; await saveDb();
      return send(res, 200, p);
    }
    if (m === "DELETE") {
      const [gone] = db.products.splice(idx, 1); await saveDb();
      if (gone.img && gone.img.startsWith("/uploads/")) fsp.unlink(path.join(UPLOADS, path.basename(gone.img))).catch(() => {});
      return send(res, 200, { ok: true });
    }
  }

  if (parts[2] === "categories" && parts[3] && m === "PUT") {
    const c = db.categories.find(x => x.id === parts[3]);
    if (!c) return send(res, 404, { error: "Category not found" });
    const body = await readJson(req);
    if ("name" in body) c.name = str(body.name, 60) || c.name;
    if ("desc" in body) c.desc = str(body.desc, 300);
    if ("law" in body) c.law = str(body.law, 300);
    await saveDb();
    return send(res, 200, c);
  }

  if (url === "/api/admin/upload" && m === "POST") {
    const { dataUrl } = await readJson(req);
    const mm = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || "");
    if (!mm) return send(res, 400, { error: "Upload a JPG, PNG or WebP photo." });
    const ext = mm[1] === "jpeg" ? "jpg" : mm[1];
    const name = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex") + "." + ext;
    await fsp.writeFile(path.join(UPLOADS, name), Buffer.from(mm[2], "base64"));
    return send(res, 201, { url: "/uploads/" + name });
  }

  return send(res, 404, { error: "Not found" });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url === "/health") { res.writeHead(200); return res.end("ok"); }
    if (url.startsWith("/api/")) return await api(req, res, url);
    if (url.startsWith("/uploads/")) { const f = safeJoin(UPLOADS, url.slice(9)); return f ? serveFile(res, f, "public, max-age=31536000, immutable") : notFound(res); }
    if (url === "/admin" || url === "/admin/") return serveFile(res, path.join(ROOT, "admin.html"), "no-store");
    const f = safeJoin(ROOT, url.endsWith("/") ? url + "index.html" : url);
    return f ? serveFile(res, f) : notFound(res);
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : e.message && !e.code ? 400 : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) send(res, code, { error: code === 500 ? "Something went wrong on the server. Try again." : e.message });
  }
});

loadDb().then(() => server.listen(PORT, "0.0.0.0", () => {
  console.log(`White Cloud 2 running on port ${PORT} · data in ${DATA_DIR}${ADMIN_PASSWORD ? "" : " · admin disabled (no ADMIN_PASSWORD)"}`);
})).catch(e => { console.error("Could not load inventory", e); process.exit(1); });
