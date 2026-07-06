/**
 * Generates the view/tile icon assets via the FAL image API (needs FAL_KEY).
 * Build-time tooling, not shipped in the bundle.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.FAL_KEY;
if (!KEY) {
  console.error(
    "FAL_KEY env var required (fal.ai API key) to regenerate view icons.",
  );
  process.exit(1);
}
const OUT = "/tmp/view-icons";
const RAW = "/tmp/svg-raw";
mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });

// id -> concrete subject. Style is appended uniformly for a cohesive launcher.
const SUBJECTS = {
  activity: "a heart-rate pulse line going up",
  arcade: "a video game controller gamepad",
  calendar: "a calendar page",
  chat: "a single rounded speech bubble",
  companion: "a friendly cute robot head",
  contacts: "a single person silhouette in a circle",
  feed: "an RSS feed symbol: a dot with two quarter-circle radiating arcs",
  focus: "a target bullseye",
  glasses: "a pair of smart glasses",
  health: "a heart with a small medical cross",
  inbox: "an inbox tray",
  keys: "a single key",
  models: "a microchip processor with pins on its sides",
  network: "three connected dots forming a network",
  orchestrator: "connected flow nodes with arrows",
  phone: "a phone handset",
  screenshare: "a computer monitor with a share arrow",
  settings: "a single gear cog",
  shop: "a shopping bag",
  trade: "a candlestick trading chart",
  training: "a dumbbell",
  trajectory: "a curved dotted flight path with an arrow",
  vectors: "three arrows pointing from a single origin",
  views: "a window divided into four equal square panes",
  wallet: "a wallet",
  default: "a four-pointed sparkle star",
  messages: "two overlapping speech bubbles",
  camera: "a camera",
  tasks: "a checklist with a checkmark",
  browser: "a globe",
  stream: "broadcasting radio waves",
  apps: "a grid of nine app dots",
  character: "a simple friendly smiling robot head, front view",
  "character-select": "two person head avatars side by side inside circles",
  automations: "a lightning bolt over gears",
  triggers: "a lightning bolt",
  inventory: "stacked storage boxes",
  documents:
    "a single sheet of white paper with a folded corner and a few horizontal lines",
  files: "a closed folder",
  plugins: "a power plug",
  skills: "three sparkle stars",
  advanced: "a brain made of circuit lines",
  "fine-tuning": "horizontal slider controls",
  trajectories: "several curved dotted paths",
  transcripts: "a document with an audio waveform",
  relationships: "connected people forming a network",
  memories: "a simple rounded cartoon brain",
  rolodex: "a stack of contact cards",
  voice: "a handheld microphone",
  runtime: "a terminal command prompt",
  database: "a database cylinder stack",
  desktop: "a desktop monitor",
  logs: "a scroll with list lines",
  background: "a framed landscape picture",
  facewear: "a face silhouette wearing a pair of smart glasses",
  polymarket: "a bar chart comparing two outcomes with an up arrow",
};

const STYLE =
  ", flat minimalist vector pictogram of a single isolated symbol, bold simple geometric shapes, two or three solid flat colors, thick clean strokes, centered with generous empty margin around it; the symbol itself must NOT be placed inside any square, rounded rectangle, circle frame, tile, plate, badge, or container; no border, no outline frame, no text, no letters; plain solid white background";

function strip(file) {
  let svg = readFileSync(file, "utf8");
  const vb = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const W = vb ? vb[1] : "2048",
    H = vb ? vb[2] : "2048";
  const re = new RegExp(
    `<path[^>]*\\bd="M\\s*0\\s+0\\s+L\\s*${W}\\s+0\\s+L\\s*${W}\\s+${H}\\s+L\\s*0\\s+${H}[^"]*"[^>]*>\\s*</path>`,
    "g",
  );
  const n = (svg.match(/<path/g) || []).length;
  svg = svg.replace(re, "");
  svg = svg.replace(/<text[\s\S]*?<\/text>/g, "");
  const after = (svg.match(/<path/g) || []).length;
  const out = file.replace(/\.svg$/, ".clean.svg");
  writeFileSync(out, svg);
  return { stripped: n - after, remain: after, out };
}

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(SUBJECTS);
const results = [];
for (const id of ids) {
  const subject = SUBJECTS[id];
  if (!subject) {
    console.log(`SKIP ${id} (no subject)`);
    continue;
  }
  try {
    const res = await fetch(
      "https://fal.run/fal-ai/recraft/v4.1/text-to-vector",
      {
        method: "POST",
        headers: {
          Authorization: `Key ${KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: subject + STYLE,
          style: "vector_illustration",
        }),
      },
    );
    const j = await res.json();
    const url = j?.images?.[0]?.url;
    if (!url) {
      console.log(`FAIL ${id}: ${JSON.stringify(j).slice(0, 120)}`);
      results.push([id, "FAIL"]);
      continue;
    }
    const svgBuf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const rawFile = `${RAW}/${id}.svg`;
    writeFileSync(rawFile, svgBuf);
    const { stripped, remain, out } = strip(rawFile);
    execFileSync("rsvg-convert", [
      "-w",
      "512",
      "-h",
      "512",
      "-b",
      "none",
      out,
      "-o",
      `${OUT}/${id}.png`,
    ]);
    console.log(
      `OK ${id}: stripped ${stripped} bg, ${remain} paths -> ${id}.png`,
    );
    results.push([id, "OK"]);
  } catch (e) {
    console.log(`ERR ${id}: ${String(e).slice(0, 120)}`);
    results.push([id, "ERR"]);
  }
}
console.log(
  "\nSUMMARY:",
  results.filter((r) => r[1] === "OK").length,
  "ok /",
  results.length,
  "total",
);
const bad = results.filter((r) => r[1] !== "OK");
if (bad.length) console.log("NOT OK:", bad.map((r) => r[0]).join(" "));
