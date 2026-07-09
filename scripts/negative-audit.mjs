/**
 * NEGATIVE FEATURE AUDIT (founder ask 07/09): crawl the marketing site + app and hunt
 * for what should NOT be there — broken links, error pages, unexpected redirects,
 * dead placeholders, retired-brand leftovers, banned phrases, leaked comments.
 * KIT COPY - canonical source lives in rb-app/scripts/negative-audit.mjs (same-week port rule).
 * Site CI runs: node scripts/negative-audit.mjs --site-only --skip-external
 * Read-only; no writes anywhere.
 */

const SITE = process.env.SITE_URL ?? "http://localhost:4321";
const APP = process.env.APP_URL ?? "http://localhost:5173";
const ARGS = new Set(process.argv.slice(2));
const RUN_SITE = !ARGS.has("--app-only");
const RUN_APP = !ARGS.has("--site-only");
const CHECK_EXTERNAL = !ARGS.has("--skip-external");

const APP_ROUTES = ["/", "/login", "/checkout", "/llms.txt", "/?demo", "/?demo=military", "/?demo=hvac", "/?start=base", "/files", "/settings", "/mfa", "/app.html"];
// Paths that are SUPPOSED to reject anonymous requests — never findings:
// /admin is stealth-404 BY DESIGN (smoke-tested); /api/* are auth-gated endpoints
// that appear in JS strings, not navigable pages. /checkout is stealth-404 when
// Stripe/dev-checkout aren't configured (the CI case).
const APP_EXPECTED_DENIALS = (path, status) =>
  path.startsWith("/admin") || path.startsWith("/api/") ||
  (path === "/checkout" && status === 404);
// The real domain isn't deployed until validation passes (locked rule) — canonical/
// sitemap links to it 404 today by design.
const EXPECTED_404_HOSTS = ["www.adaptiveresume.com", "adaptiveresume.com"];

// ---- patterns that should never (ERROR) or probably shouldn't (WARN) appear in a rendered page ----
const TEXT_RULES = [
  { sev: "ERROR", name: "retired brand", re: /resume\s?value/i },
  { sev: "ERROR", name: "placeholder domain", re: /resumevalue\.example|example\.com\/(?!$)/i },
  { sev: "ERROR", name: "unfilled placeholder bracket", re: /\[(LEGAL ENTITY|TBD|TODO|placeholder|your (name|domain))/i },
  { sev: "ERROR", name: "lorem ipsum", re: /lorem ipsum/i },
  { sev: "ERROR", name: "template leak", re: /\{\{[^}]{1,60}\}\}|\$\{[a-zA-Z_][^}]{0,40}\}/ },
  { sev: "ERROR", name: "accented resume (banned spelling)", re: /r[eé]sum[eé]s?/, only: (t) => /résumé|resumé|résume/i.test(t) },
  { sev: "WARN", name: "banned jargon: the engine", re: /\bthe engine\b/i },
  { sev: "WARN", name: "banned jargon: reverse-inference", re: /reverse[- ]inference/i },
  { sev: "WARN", name: "banned jargon: scrape", re: /\bscrap(e|ing|ed)\b/i },
  { sev: "WARN", name: "banned tone: last resort", re: /\blast resort\b/i },
  { sev: "WARN", name: "outcome promise", re: /\b(get (you )?hired|land (the|your|a) (job|interview|offer)|guaranteed? (a )?(job|interview|offer)|dream job)\b/i },
  { sev: "WARN", name: "guarantee wording (review context)", re: /\bguarantee[ds]?\b/i },
  { sev: "WARN", name: "coming soon", re: /\bcoming soon\b/i },
  { sev: "WARN", name: "tool-speak: fabricat*", re: /fabricat(e|ion|ed)/i },
  // true emoji/clipart only — typographic marks (checks/stars/arrows) are design elements
  { sev: "WARN", name: "emoji in copy", re: /[\u{1F300}-\u{1FAFF}]/u },
  { sev: "WARN", name: "old price point", re: /\$(39|99)(?![\d.])/ },
];
// comments that leak internal/legal chatter into page source
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const COMMENT_FLAG = /attorney|TODO|FIXME|HACK|internal|do not ship|swap|entity name|filing/i;

const findings = []; // {sev, surface, page, name, detail}
const add = (sev, surface, page, name, detail) => findings.push({ sev, surface, page, name, detail });

const fetchManual = async (url) => {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    return r;
  } catch (e) { return { status: 0, error: String(e?.message ?? e), headers: new Map() }; }
};

const stripTags = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");

function extractLinks(html) {
  const out = [];
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"'#][^"']*)["']/gi)) out.push(m[1]);
  for (const m of html.matchAll(/href\s*=\s*["'](#[^"']*)["']/gi)) out.push(m[1]); // pure fragments
  return out;
}
const idsIn = (html) => new Set([...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));

async function auditSurface(name, base, seeds, crawl) {
  const seen = new Set();
  const queue = [...seeds];
  const external = new Set();
  const pages = new Map(); // path -> {html, ids}

  while (queue.length) {
    const path = queue.shift();
    const clean = path.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    const r = await fetchManual(base + clean);
    if (r.status === 0) { add("ERROR", name, clean, "fetch failed", r.error); continue; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") ?? "";
      add("INFO", name, clean, "redirect", `${r.status} -> ${loc}`);
      const follow = await fetchManual(loc.startsWith("http") ? loc : base + loc);
      if (follow.status >= 400 || follow.status === 0) add("ERROR", name, clean, "redirect lands on error", `${loc} -> ${follow.status || follow.error}`);
      continue;
    }
    if (r.status >= 400) {
      if (name === "app" && APP_EXPECTED_DENIALS(clean, r.status)) continue; // by-design rejections
      add("ERROR", name, clean, `HTTP ${r.status}`, "linked/seeded page returns an error");
      continue;
    }
    const ct = r.headers.get("content-type") ?? "";
    const body = await r.text();
    if (!ct.includes("html")) { pages.set(clean, { html: body, ids: new Set() }); continue; }
    pages.set(clean, { html: body, ids: idsIn(body) });

    // text rules on visible text; brand/domain rules also on raw (meta/href)
    const visible = stripTags(body);
    for (const rule of TEXT_RULES) {
      const hay = ["retired brand", "placeholder domain", "old price point"].includes(rule.name) ? body : visible;
      if (rule.only && !rule.only(hay)) continue;
      const m = hay.match(rule.re);
      if (m) add(rule.sev, name, clean, rule.name, `"...${hay.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, " ").trim()}..."`);
    }
    for (const cm of body.matchAll(COMMENT_RE)) {
      if (COMMENT_FLAG.test(cm[1])) add("ERROR", name, clean, "leaked comment in page source", cm[1].replace(/\s+/g, " ").trim().slice(0, 140));
    }

    // links
    for (const link of extractLinks(body)) {
      if (/^(mailto:|tel:|data:|javascript:)/i.test(link)) {
        if (/^mailto:\s*(#|$)/i.test(link)) add("ERROR", name, clean, "dead mailto", link);
        continue;
      }
      if (link === "#" || link.startsWith("#!")) { add("ERROR", name, clean, "dead # link", "href=\"#\" placeholder"); continue; }
      if (link.startsWith("#")) {
        // same-page anchor: validated after crawl
        pages.get(clean).anchors ??= [];
        pages.get(clean).anchors.push(link.slice(1));
        continue;
      }
      if (/^https?:\/\//i.test(link)) {
        if (link.startsWith(base)) { const p = link.slice(base.length) || "/"; if (crawl && !seen.has(p.split("#")[0])) queue.push(p); }
        else if (link.startsWith("http://localhost")) add("WARN", name, clean, "cross-localhost link", `${link} (verify env swap at deploy)`);
        else external.add(link);
        continue;
      }
      const abs = link.startsWith("/") ? link : "/" + link;
      const frag = abs.split("#")[1];
      const target = abs.split("#")[0];
      if (crawl && !seen.has(target)) queue.push(target);
      if (!crawl && !seen.has(target)) queue.push(target); // app: still verify linked paths resolve
      if (frag) { pages.get(clean).crossAnchors ??= []; pages.get(clean).crossAnchors.push({ target, frag }); }
    }
  }

  // anchor validation
  for (const [path, p] of pages) {
    for (const a of p.anchors ?? []) if (!p.ids.has(a)) add("ERROR", name, path, "broken same-page anchor", `#${a} has no matching id`);
    for (const { target, frag } of p.crossAnchors ?? []) {
      const t = pages.get(target);
      if (t && !t.ids.has(frag)) add("ERROR", name, path, "broken cross-page anchor", `${target}#${frag} has no matching id`);
    }
  }

  return { external, pageCount: pages.size };
}

const site = RUN_SITE ? await auditSurface("site", SITE, ["/"], true) : { external: new Set(), pageCount: 0 };
const app = RUN_APP ? await auditSurface("app", APP, APP_ROUTES, false) : { external: new Set(), pageCount: 0 };

// external links: existence check, gentle (GET, timeout, each once). Bare origins
// (preconnect hosts like fonts.googleapis.com) are not pages — skip them.
const externals = new Set(
  [...site.external, ...app.external].filter((u) => { try { return new URL(u).pathname !== "/" || new URL(u).search; } catch { return false; } }),
);
if (CHECK_EXTERNAL) {
  for (const url of externals) {
    const host = new URL(url).hostname;
    const r = await fetchManual(url);
    if (r.status === 0 || r.status >= 400) {
      if (EXPECTED_404_HOSTS.includes(host)) add("INFO", "external", url, "canonical-domain link (expected 404 until deploy)", String(r.status || r.error));
      else add("WARN", "external", url, `external link ${r.status || "unreachable"}`, r.error ?? "");
    }
  }
}

// ---- report ----
const order = { ERROR: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.surface.localeCompare(b.surface) || a.page.localeCompare(b.page));
let e = 0, w = 0;
for (const f of findings) {
  if (f.sev === "ERROR") e++; if (f.sev === "WARN") w++;
  console.log(`${f.sev.padEnd(5)} [${f.surface}] ${f.page}  ${f.name}: ${f.detail}`);
}
console.log(`\nnegative-audit: ${site.pageCount} site pages + ${app.pageCount} app pages + ${externals.size} external links checked`);
console.log(`RESULT: ${e} error(s), ${w} warning(s)`);
process.exit(e ? 1 : 0);
