/**
 * PFP Gallery — Dev Tool
 *
 * Generates a static HTML gallery for reviewing all profile pictures:
 * - NPC/Actor PFPs (with pfpDescription and real-name anchor)
 * - Organization logos
 * - User preset PFP prompt list (no API call — shows what will be generated)
 *
 * Usage:
 *   bun run scripts/pfp-gallery.ts
 *   bun run scripts/pfp-gallery.ts --open   # open in browser after generating
 *
 * Output: ./output/pfp-gallery/index.html
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Config ─────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "..");
const OUTPUT_DIR = join(ROOT, "output", "pfp-gallery");
const ACTORS_DIR = join(ROOT, "packages/engine/src/data/actors");
const ORGS_DIR = join(ROOT, "packages/engine/src/data/organizations");
const PUBLIC_ACTORS = join(ROOT, "apps/web/public/images/actors");
const PUBLIC_ACTOR_BANNERS = join(ROOT, "apps/web/public/images/actor-banners");
const PUBLIC_ORGS = join(ROOT, "apps/web/public/images/organizations");
const PUBLIC_ORG_BANNERS = join(ROOT, "apps/web/public/images/org-banners");

const openAfter = process.argv.includes("--open");

// ─── User PFP constants (inlined — do NOT import generate-user-pfps.ts) ─────
// These mirror the arrays in scripts/generate-user-pfps.ts. Keep in sync.

const SUBJECTS = [
  "a cat",
  "a wolf",
  "a fox",
  "an owl",
  "a bear",
  "a raven",
  "a koi fish",
  "a stag",
  "a tiger",
  "a hawk",
  "a panther",
  "a lion",
  "a dolphin",
  "a snow leopard",
  "an eagle",
  "a red panda",
  "a dragon",
  "a phoenix",
  "a griffin",
  "a sphinx",
  "a valkyrie",
  "a celestial kirin",
  "a sea serpent",
  "a nine-tailed fox",
  "a robot head",
  "an astronaut helmet",
  "a samurai helmet",
  "a chess king piece",
  "a knight in armor",
  "a space explorer",
  "a scholar with books",
  "a captain at the helm",
  "a diamond",
  "a crown",
  "an hourglass",
  "a crystal ball",
  "a compass rose",
  "a crescent moon",
  "a lightning bolt",
  "a glowing lantern",
  "a golden coin",
  "a key",
  "a fractal flower",
  "a DNA helix",
  "a geometric eye",
  "a spiral galaxy",
  "a lotus flower",
];

const BACKGROUNDS = [
  "a soft geometric gradient",
  "concentric circles in muted tones",
  "a mandala pattern",
  "liquid marble in deep blue and gold",
  "a topographic map in sepia",
  "a clean studio gradient",
  "a deep midnight blue",
  "a rich forest green",
  "a warm amber and gold gradient",
  "a dark charcoal with soft glow",
  "a pastel watercolor wash",
  "a muted earth tone palette",
  "an iridescent sheen",
  "a stark white minimalist backdrop",
  "a deep navy with stars",
  "a dense jungle canopy",
  "an underwater coral reef",
  "a mountain range at dusk",
  "a snowy mountain peak",
  "a desert with dunes",
  "outer space with nebulae",
  "an ancient temple interior",
  "a field of wildflowers",
  "a serene lake at dawn",
  "a bamboo forest in mist",
];

const THEMES = [
  "elegant and regal",
  "ethereal and dreamlike",
  "serene and zen",
  "bold and powerful",
  "ancient and mystical",
  "minimalist and clean",
  "cosmic and celestial",
  "warm and inviting",
  "cool and focused",
  "vibrant and energetic",
  "mysterious and atmospheric",
  "crisp and modern",
  "rich and luxurious",
  "playful and whimsical",
  "sharp and cinematic",
  "soft and peaceful",
  "heroic and epic",
  "enchanted fairy tale",
  "lo-fi chill",
  "sophisticated and refined",
];

const STYLES = [
  "3D Pixar render",
  "hand-drawn ink illustration",
  "digital concept art",
  "anime illustration",
  "oil painting",
  "watercolor painting",
  "low poly 3D",
  "comic book illustration",
  "woodblock print",
  "stained glass illustration",
  "ukiyo-e Japanese art",
  "art nouveau poster",
  "claymation style",
  "pencil graphite sketch",
  "vector flat design",
  "impressionist painting",
  "cel-shaded cartoon",
  "matte painting",
  "studio photography",
  "linocut print",
  "bold graphic design",
  "fantasy concept art",
  "character design sheet",
  "luminous digital painting",
  "soft pastel illustration",
];

function buildPrompt(
  subject: string,
  background: string,
  theme: string,
  style: string,
): string {
  return `A polished profile picture avatar: ${subject}, ${theme} mood, rendered in ${style} style. Background: ${background}. Centered composition, close-up portrait framing, square crop. High quality, clean edges, no text, no watermarks, no logos.`;
}

// ─── Data types ──────────────────────────────────────────────────────────────

interface ActorEntry {
  id: string;
  name: string;
  realName?: string;
  pfpDescription?: string;
  hasPfp: boolean;
  hasBanner: boolean;
  pfpPath?: string;
  bannerPath?: string;
}

interface OrgEntry {
  id: string;
  name: string;
  pfpDescription?: string;
  bannerDescription?: string;
  hasLogo: boolean;
  hasBanner: boolean;
  logoPath?: string;
  bannerPath?: string;
}

interface UserPreset {
  index: number;
  subject: string;
  background: string;
  theme: string;
  style: string;
  prompt: string;
}

// ─── Data extraction (regex-based — no TS compile needed) ────────────────────

function extractFieldRobust(source: string, field: string): string | undefined {
  const fieldRe = new RegExp(`\\b${field}:\\s*`, "g");
  const match = fieldRe.exec(source);
  if (!match) return undefined;

  const startPos = match.index + match[0].length;
  const segment = source.slice(startPos, startPos + 3000);

  const parts: string[] = [];
  let i = 0;
  let firstQuoteFound = false;

  while (i < segment.length) {
    const ch = segment[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      firstQuoteFound = true;
      const quote = ch;
      i++;
      let str = "";
      while (i < segment.length && segment[i] !== quote) {
        if (segment[i] === "\\") {
          i++;
          const esc = segment[i];
          if (esc === "n") str += "\n";
          else if (esc === "t") str += "\t";
          else str += esc;
        } else {
          str += segment[i];
        }
        i++;
      }
      parts.push(str);
      i++;
    } else if (firstQuoteFound && /[\s+]/.test(ch)) {
      i++;
    } else if (firstQuoteFound) {
      break;
    } else {
      i++;
    }
  }

  return parts.length > 0 ? parts.join("") : undefined;
}

async function loadActors(): Promise<ActorEntry[]> {
  const files = await readdir(ACTORS_DIR);
  const actors: ActorEntry[] = [];

  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const id = file.replace(".ts", "");
    const source = await readFile(join(ACTORS_DIR, file), "utf-8");

    const pfpPath = join(PUBLIC_ACTORS, `${id}.jpg`);
    const bannerPath = join(PUBLIC_ACTOR_BANNERS, `${id}.jpg`);
    const hasPfp = existsSync(pfpPath);
    const hasBanner = existsSync(bannerPath);

    actors.push({
      id,
      name: extractFieldRobust(source, "name") ?? id,
      realName: extractFieldRobust(source, "realName"),
      pfpDescription: extractFieldRobust(source, "pfpDescription"),
      hasPfp,
      hasBanner,
      pfpPath: hasPfp ? pfpPath : undefined,
      bannerPath: hasBanner ? bannerPath : undefined,
    });
  }

  return actors.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadOrgs(): Promise<OrgEntry[]> {
  const files = await readdir(ORGS_DIR);
  const orgs: OrgEntry[] = [];

  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const id = file.replace(".ts", "");
    const source = await readFile(join(ORGS_DIR, file), "utf-8");

    const logoPath = join(PUBLIC_ORGS, `${id}.jpg`);
    const bannerPath = join(PUBLIC_ORG_BANNERS, `${id}.jpg`);
    const hasLogo = existsSync(logoPath);
    const hasBanner = existsSync(bannerPath);

    orgs.push({
      id,
      name: extractFieldRobust(source, "name") ?? id,
      pfpDescription: extractFieldRobust(source, "pfpDescription"),
      bannerDescription: extractFieldRobust(source, "bannerDescription"),
      hasLogo,
      hasBanner,
      logoPath: hasLogo ? logoPath : undefined,
      bannerPath: hasBanner ? bannerPath : undefined,
    });
  }

  return orgs.sort((a, b) => a.id.localeCompare(b.id));
}

// ─── User preset generation ──────────────────────────────────────────────────

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getUserPresets(count = 40): UserPreset[] {
  const rand = seededRandom(777);
  const subjects = shuffle(SUBJECTS, rand);
  const backgrounds = shuffle(BACKGROUNDS, rand);
  const themes = shuffle(THEMES, rand);
  const styles = shuffle(STYLES, rand);

  const presets: UserPreset[] = [];
  let si = 0,
    bi = 0,
    ti = 0,
    sti = 0;

  while (presets.length < count) {
    presets.push({
      index: presets.length,
      subject: subjects[si % subjects.length]!,
      background: backgrounds[bi % backgrounds.length]!,
      theme: themes[ti % themes.length]!,
      style: styles[sti % styles.length]!,
      prompt: buildPrompt(
        subjects[si % subjects.length]!,
        backgrounds[bi % backgrounds.length]!,
        themes[ti % themes.length]!,
        styles[sti % styles.length]!,
      ),
    });
    si++;
    bi += 3;
    ti += 7;
    sti += 11;
  }
  return presets;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Images are served via relative paths (symlinked into output/pfp-gallery/images/)
function imgSrc(imagePath: string | undefined): string | undefined {
  if (!imagePath) return undefined;
  // e.g. /root/.../apps/web/public/images/actors/ailon-musk.jpg
  // → images/actors/ailon-musk.jpg
  const parts = imagePath.split("/images/");
  return parts.length > 1 ? `images/${parts[parts.length - 1]}` : undefined;
}

function imgTag(imagePath: string | undefined, alt: string, cls = ""): string {
  const src = imgSrc(imagePath);
  if (!src) {
    return `<div class="missing-img ${cls}">NO IMAGE</div>`;
  }
  return `<img src="${src}" alt="${escHtml(alt)}" class="${cls}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="missing-img ${cls}" style="display:none">LOAD ERR</div>`;
}

function badge(ok: boolean, label: string): string {
  return `<span class="badge ${ok ? "ok" : "missing"}">${label}</span>`;
}

function actorCard(a: ActorEntry): string {
  const isMissing = !a.hasPfp || !a.hasBanner;
  return `
<div class="card${isMissing ? " card-warning" : ""}" id="actor-${a.id}">
  <div class="card-images">
    ${imgTag(a.pfpPath, a.name, "pfp-img")}
    ${imgTag(a.bannerPath, `${a.name} banner`, "banner-img")}
  </div>
  <div class="card-meta">
    <div class="card-title">${escHtml(a.name)}</div>
    <div class="card-subtitle">${a.realName ? `Real: ${escHtml(a.realName)}` : '<em class="muted">No realName</em>'}</div>
    <div class="card-id" title="Click to copy">${escHtml(a.id)}</div>
    <div class="badges">${badge(a.hasPfp, "PFP")} ${badge(a.hasBanner, "BANNER")}</div>
    ${
      a.pfpDescription
        ? `<div class="description"><strong>pfpDescription:</strong><br>${escHtml(a.pfpDescription)}</div>`
        : `<div class="description missing-desc">⚠ No pfpDescription — image will be generic</div>`
    }
  </div>
</div>`;
}

function orgCard(o: OrgEntry): string {
  const isMissing = !o.hasLogo || !o.hasBanner;
  return `
<div class="card${isMissing ? " card-warning" : ""}" id="org-${o.id}">
  <div class="card-images">
    ${imgTag(o.logoPath, o.name, "pfp-img")}
    ${imgTag(o.bannerPath, `${o.name} banner`, "banner-img")}
  </div>
  <div class="card-meta">
    <div class="card-title">${escHtml(o.name)}</div>
    <div class="card-id" title="Click to copy">${escHtml(o.id)}</div>
    <div class="badges">${badge(o.hasLogo, "LOGO")} ${badge(o.hasBanner, "BANNER")}</div>
    ${
      o.pfpDescription
        ? `<div class="description"><strong>pfpDescription:</strong><br>${escHtml(o.pfpDescription)}</div>`
        : `<div class="description missing-desc">⚠ No pfpDescription</div>`
    }
  </div>
</div>`;
}

function userPresetCard(p: UserPreset): string {
  return `
<div class="preset-card">
  <div class="preset-num">#${p.index + 1}</div>
  <div class="preset-row"><strong>Subject:</strong> ${escHtml(p.subject)}</div>
  <div class="preset-row"><strong>Theme:</strong> ${escHtml(p.theme)}</div>
  <div class="preset-row"><strong>Style:</strong> ${escHtml(p.style)}</div>
  <div class="preset-row"><strong>Background:</strong> ${escHtml(p.background)}</div>
  <div class="preset-prompt">"${escHtml(p.prompt)}"</div>
</div>`;
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHtml(
  actors: ActorEntry[],
  orgs: OrgEntry[],
  presets: UserPreset[],
): string {
  const actorsMissing = actors.filter((a) => !a.hasPfp);
  const orgsMissing = orgs.filter((o) => !o.hasLogo);
  const actorsNoPfpDesc = actors.filter((a) => !a.pfpDescription);
  const generatedAt = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Feed PFP Gallery</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f13; color: #e2e2e8; }

header { background: #1a1a24; border-bottom: 1px solid #2e2e42; padding: 16px 28px; position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
header h1 { font-size: 1.25rem; font-weight: 700; color: #a78bfa; white-space: nowrap; }
.meta { font-size: 0.72rem; color: #555; }
nav { display: flex; gap: 8px; flex-wrap: wrap; }
nav a { color: #818cf8; text-decoration: none; font-size: 0.8rem; padding: 4px 10px; border: 1px solid #2e2e42; border-radius: 6px; }
nav a:hover { background: #1e1e2e; }

.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; padding: 20px 28px; background: #12121a; border-bottom: 1px solid #1e1e2e; }
.stat { background: #1a1a24; border-radius: 10px; padding: 14px 16px; }
.stat-value { font-size: 1.8rem; font-weight: 700; }
.stat-label { font-size: 0.72rem; color: #888; margin-top: 2px; }
.ok .stat-value { color: #34d399; }
.warn .stat-value { color: #f59e0b; }
.err .stat-value { color: #f87171; }

.section { padding: 28px; border-bottom: 1px solid #1e1e2e; }
.section-title { font-size: 1.1rem; font-weight: 700; color: #a78bfa; margin-bottom: 6px; }
.section-sub { font-size: 0.78rem; color: #666; margin-bottom: 18px; }
.section-sub code { background: #1a1a24; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; }

.filter-bar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
.filter-bar input { background: #1a1a24; border: 1px solid #2e2e42; color: #e2e2e8; padding: 6px 12px; border-radius: 6px; font-size: 0.82rem; width: 260px; outline: none; }
.filter-bar input:focus { border-color: #6366f1; }
.filter-bar button { background: #252535; border: 1px solid #2e2e42; color: #ccc; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 0.78rem; }
.filter-bar button:hover { background: #2e2e42; }
.filter-bar button.active { background: #4f46e5; border-color: #6366f1; color: #fff; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
.card { background: #1a1a24; border-radius: 10px; overflow: hidden; border: 1px solid #2e2e42; transition: border-color 0.15s; }
.card:hover { border-color: #6366f1; }
.card-warning { border-color: #78350f; }
.card-images { display: flex; }
.pfp-img { width: 110px; height: 110px; object-fit: cover; flex-shrink: 0; }
.banner-img { flex: 1; height: 110px; object-fit: cover; min-width: 0; }
.missing-img { background: #12121a; border: 1px dashed #2e2e42; display: flex; align-items: center; justify-content: center; font-size: 0.6rem; color: #444; font-weight: 700; letter-spacing: 0.06em; }
.missing-img.pfp-img { width: 110px; height: 110px; flex-shrink: 0; }
.missing-img.banner-img { flex: 1; height: 110px; }
.card-meta { padding: 10px 12px; }
.card-title { font-size: 0.9rem; font-weight: 700; }
.card-subtitle { font-size: 0.72rem; color: #888; margin-bottom: 2px; }
.card-id { font-size: 0.68rem; color: #555; font-family: monospace; margin-bottom: 8px; cursor: pointer; }
.card-id:hover { color: #818cf8; }
.muted { color: #555; font-style: italic; }
.badges { display: flex; gap: 5px; margin-bottom: 7px; }
.badge { font-size: 0.62rem; padding: 2px 7px; border-radius: 4px; font-weight: 700; letter-spacing: 0.04em; }
.badge.ok { background: #064e3b; color: #6ee7b7; }
.badge.missing { background: #7f1d1d; color: #fca5a5; }
.description { font-size: 0.7rem; color: #aaa; line-height: 1.5; max-height: 72px; overflow-y: auto; background: #12121a; padding: 5px 8px; border-radius: 5px; }
.missing-desc { color: #f59e0b; background: #1c1200; }

.missing-list { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.missing-tag { background: #7f1d1d; color: #fca5a5; padding: 3px 9px; border-radius: 5px; font-size: 0.72rem; font-family: monospace; cursor: pointer; }
.missing-tag:hover { background: #991b1b; }

.presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.preset-card { background: #1a1a24; border: 1px solid #2e2e42; border-radius: 9px; padding: 12px; }
.preset-num { font-size: 0.65rem; color: #6366f1; font-weight: 700; margin-bottom: 7px; }
.preset-row { font-size: 0.73rem; margin-bottom: 3px; color: #bbb; }
.preset-row strong { color: #e2e2e8; }
.preset-prompt { margin-top: 8px; font-size: 0.68rem; color: #666; font-style: italic; background: #12121a; padding: 6px 8px; border-radius: 5px; line-height: 1.55; border-left: 3px solid #2e2e42; }

#toast { position: fixed; bottom: 20px; right: 20px; background: #4f46e5; color: #fff; padding: 9px 16px; border-radius: 8px; font-size: 0.82rem; display: none; z-index: 999; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
</style>
</head>
<body>

<header>
  <h1>🎨 Feed PFP Gallery</h1>
  <nav>
    <a href="#actors">Actors (${actors.length})</a>
    <a href="#orgs">Orgs (${orgs.length})</a>
    <a href="#user-presets">User Presets</a>
    <a href="#missing">⚠ Missing (${actorsMissing.length + orgsMissing.length})</a>
  </nav>
  <div class="meta">Generated ${generatedAt}</div>
</header>

<div class="summary">
  <div class="stat ${actors.filter((a) => a.hasPfp).length === actors.length ? "ok" : "warn"}">
    <div class="stat-value">${actors.filter((a) => a.hasPfp).length}/${actors.length}</div>
    <div class="stat-label">Actor PFPs generated</div>
  </div>
  <div class="stat ${actorsMissing.length === 0 ? "ok" : "err"}">
    <div class="stat-value">${actorsMissing.length}</div>
    <div class="stat-label">Actors missing PFP</div>
  </div>
  <div class="stat ${actors.filter((a) => a.hasBanner).length === actors.length ? "ok" : "warn"}">
    <div class="stat-value">${actors.filter((a) => a.hasBanner).length}/${actors.length}</div>
    <div class="stat-label">Actor banners generated</div>
  </div>
  <div class="stat ${orgsMissing.length === 0 ? "ok" : "warn"}">
    <div class="stat-value">${orgs.filter((o) => o.hasLogo).length}/${orgs.length}</div>
    <div class="stat-label">Org logos generated</div>
  </div>
  <div class="stat ${actorsNoPfpDesc.length === 0 ? "ok" : "warn"}">
    <div class="stat-value">${actorsNoPfpDesc.length}</div>
    <div class="stat-label">Actors missing pfpDescription</div>
  </div>
</div>

<!-- MISSING ── -->
<div class="section" id="missing">
  <div class="section-title">⚠ Missing Images</div>
  <div class="section-sub">
    Generate all: <code>bun run --cwd apps/cli images</code><br>
    Single actor: <code>bun run --cwd apps/cli images --actor &lt;id&gt;</code><br>
    Single org: <code>bun run --cwd apps/cli images --org &lt;id&gt;</code><br>
    Force regen: <code>bun run --cwd apps/cli images --force</code>
  </div>
  ${
    actorsMissing.length > 0
      ? `<strong style="font-size:0.8rem;color:#f59e0b">Actors missing PFP (${actorsMissing.length}):</strong>
  <div class="missing-list">
    ${actorsMissing.map((a) => `<span class="missing-tag" title="${escHtml(a.name)}" onclick="navigator.clipboard.writeText('${escHtml(a.id)}')">${escHtml(a.id)}</span>`).join("")}
  </div>`
      : '<p style="color:#34d399;font-size:0.85rem">✓ All actors have PFPs</p>'
  }

  <br>

  ${
    orgsMissing.length > 0
      ? `<strong style="font-size:0.8rem;color:#f59e0b">Orgs missing logo (${orgsMissing.length}):</strong>
  <div class="missing-list">
    ${orgsMissing.map((o) => `<span class="missing-tag" title="${escHtml(o.name)}" onclick="navigator.clipboard.writeText('${escHtml(o.id)}')">${escHtml(o.id)}</span>`).join("")}
  </div>`
      : '<p style="color:#34d399;font-size:0.85rem">✓ All orgs have logos</p>'
  }

  ${
    actorsNoPfpDesc.length > 0
      ? `<br>
  <strong style="font-size:0.8rem;color:#f59e0b">Actors without pfpDescription (${actorsNoPfpDesc.length}):</strong>
  <div class="missing-list">
    ${actorsNoPfpDesc.map((a) => `<span class="missing-tag" title="${escHtml(a.name)}">${escHtml(a.id)}</span>`).join("")}
  </div>`
      : ""
  }
</div>

<!-- ACTORS ── -->
<div class="section" id="actors">
  <div class="section-title">🎭 NPC Actors (${actors.length})</div>
  <div class="section-sub">Left square = PFP portrait. Right = banner. Check race, skin tone, hairline, and physique match the <em>pfpDescription</em>. Click an ID to copy it.</div>
  <div class="filter-bar">
    <input type="text" id="actor-filter" placeholder="Filter by name, id, realName…" oninput="filterCards('actors-grid', this.value)">
    <button id="btn-missing-actors" onclick="toggleMissing('actors-grid', this)">Show missing only</button>
    <button onclick="clearFilter('actors-grid', 'actor-filter', 'btn-missing-actors')">Clear</button>
  </div>
  <div class="cards" id="actors-grid">
    ${actors.map(actorCard).join("\n")}
  </div>
</div>

<!-- ORGS ── -->
<div class="section" id="orgs">
  <div class="section-title">🏢 Organizations (${orgs.length})</div>
  <div class="section-sub">Left square = org logo. Right = banner. Most orgs are missing images — use the CLI commands above to generate them.</div>
  <div class="filter-bar">
    <input type="text" id="org-filter" placeholder="Filter by name or id…" oninput="filterCards('orgs-grid', this.value)">
    <button id="btn-missing-orgs" onclick="toggleMissing('orgs-grid', this)">Show missing only</button>
    <button onclick="clearFilter('orgs-grid', 'org-filter', 'btn-missing-orgs')">Clear</button>
  </div>
  <div class="cards" id="orgs-grid">
    ${orgs.map(orgCard).join("\n")}
  </div>
</div>

<!-- USER PRESETS ── -->
<div class="section" id="user-presets">
  <div class="section-title">👤 User PFP Presets (${presets.length} sample prompts)</div>
  <div class="section-sub">
    These prompt combos are generated deterministically (seed 777) from the arrays in <code>scripts/generate-user-pfps.ts</code>.
    150 unique combos are used in total. Run <code>bun run pfp:user</code> (needs <code>FAL_KEY</code> env var) to generate actual images.
  </div>
  <div class="presets">
    ${presets.map(userPresetCard).join("\n")}
  </div>
</div>

<div id="toast">Copied!</div>

<script>
function filterCards(gridId, q) {
  q = q.toLowerCase().trim();
  document.getElementById(gridId).querySelectorAll('.card').forEach(c => {
    c.style.display = !q || c.innerText.toLowerCase().includes(q) ? '' : 'none';
  });
}

function toggleMissing(gridId, btn) {
  btn.classList.toggle('active');
  const show = btn.classList.contains('active');
  document.getElementById(gridId).querySelectorAll('.card').forEach(c => {
    c.style.display = show ? (c.classList.contains('card-warning') ? '' : 'none') : '';
  });
}

function clearFilter(gridId, inputId, btnId) {
  document.getElementById(inputId).value = '';
  const btn = document.getElementById(btnId);
  btn?.classList.remove('active');
  document.getElementById(gridId).querySelectorAll('.card').forEach(c => c.style.display = '');
}

document.querySelectorAll('.card-id').forEach(el => {
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(el.textContent.trim()).then(() => {
      const t = document.getElementById('toast');
      t.style.display = 'block';
      clearTimeout(t._tid);
      t._tid = setTimeout(() => t.style.display = 'none', 1500);
    });
  });
});
</script>
</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Loading actor data…");
  const actors = await loadActors();

  console.log("Loading organization data…");
  const orgs = await loadOrgs();

  console.log("Building user PFP preset list…");
  const presets = getUserPresets(40);

  // Summary to stdout
  const actorsMissing = actors.filter((a) => !a.hasPfp);
  const orgsMissing = orgs.filter((o) => !o.hasLogo);
  const actorsNoPfpDesc = actors.filter((a) => !a.pfpDescription);

  console.log(
    `\nActors: ${actors.length} total | ${actors.filter((a) => a.hasPfp).length} with PFP | ${actors.filter((a) => a.hasBanner).length} with banner`,
  );
  console.log(
    `Orgs:   ${orgs.length} total | ${orgs.filter((o) => o.hasLogo).length} with logo | ${orgs.filter((o) => o.hasBanner).length} with banner`,
  );

  if (actorsMissing.length > 0) {
    console.log(`\n⚠  Actors missing PFP (${actorsMissing.length}):`);
    for (const a of actorsMissing) console.log(`   - ${a.id} (${a.name})`);
  }
  if (orgsMissing.length > 0) {
    console.log(`\n⚠  Orgs missing logo (${orgsMissing.length}):`);
    for (const o of orgsMissing) console.log(`   - ${o.id} (${o.name})`);
  }
  if (actorsNoPfpDesc.length > 0) {
    console.log(
      `\n⚠  Actors without pfpDescription (${actorsNoPfpDesc.length}):`,
    );
    for (const a of actorsNoPfpDesc) console.log(`   - ${a.id} (${a.name})`);
  }

  console.log("\nGenerating HTML gallery…");
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Symlink image directories so they're served correctly over HTTP
  const imageLinks: Array<[string, string]> = [
    ["actors", PUBLIC_ACTORS],
    ["actor-banners", PUBLIC_ACTOR_BANNERS],
    ["organizations", PUBLIC_ORGS],
    ["org-banners", PUBLIC_ORG_BANNERS],
  ];
  for (const [name, target] of imageLinks) {
    const linkPath = join(OUTPUT_DIR, "images", name);
    if (!existsSync(linkPath)) {
      await mkdir(join(OUTPUT_DIR, "images"), { recursive: true });
      await symlink(target, linkPath).catch(() => {
        /* already exists */
      });
    }
  }

  const html = buildHtml(actors, orgs, presets);
  const outPath = join(OUTPUT_DIR, "index.html");
  await writeFile(outPath, html, "utf-8");

  console.log(`\n✅ Gallery: ${outPath}`);
  console.log(
    `   Serve:   bun run pfp:serve  (then SSH tunnel: ssh -L 8899:localhost:8899 user@server)`,
  );

  if (openAfter) {
    try {
      execSync(
        `xdg-open "${outPath}" 2>/dev/null || open "${outPath}" 2>/dev/null`,
      );
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
