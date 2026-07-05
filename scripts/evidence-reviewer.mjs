#!/usr/bin/env node
/**
 * Unified local evidence reviewer for PR and issue artifacts. The scanner keeps
 * artifacts in their existing silos, enriches screenshots and videos with
 * required OCR/media analysis, and writes one local HTML dashboard for manual
 * review before a PR is marked ready.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "evidence");
const DEFAULT_SOURCES = [
  { id: "issue-evidence", dir: ".github/issue-evidence" },
  { id: "e2e-recordings", dir: "e2e-recordings" },
  { id: "app-audit", dir: "packages/app/aesthetic-audit-output" },
  { id: "app-test-results", dir: "packages/app/test-results" },
  { id: "app-walkthrough", dir: "packages/app/reports/walkthrough" },
  { id: "ios-boot-capture", dir: "packages/app/ios/build/boot-capture" },
  { id: "app-device-e2e", dir: "packages/app/device-e2e-output" },
  { id: "device-e2e", dir: "device-e2e-output" },
  { id: "scenario-reports", dir: "packages/scenario-runner/reports" },
  { id: "live-test-runs", dir: "reports/live-test-runs" },
];
const TYPE_BY_EXT = new Map([
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".webp", "image"],
  [".gif", "image"],
  [".mp4", "video"],
  [".webm", "video"],
  [".mov", "video"],
  [".m4v", "video"],
  [".mp3", "audio"],
  [".wav", "audio"],
  [".m4a", "audio"],
  [".json", "json"],
  [".jsonl", "trajectory"],
  [".log", "log"],
  [".txt", "log"],
  [".md", "markdown"],
  [".html", "html"],
]);
const SUMMARY_LIMIT = 280;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    outDir: DEFAULT_OUTPUT_DIR,
    open: process.env.CI !== "true",
    sources: DEFAULT_SOURCES,
    maxArtifacts: 2500,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-open") {
      args.open = false;
      continue;
    }
    if (arg === "--open") {
      args.open = true;
      continue;
    }
    if (arg === "--self-test") {
      args.selfTest = true;
      args.open = false;
      continue;
    }
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--out requires a directory.");
      args.outDir = path.resolve(REPO_ROOT, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      args.outDir = path.resolve(REPO_ROOT, arg.slice("--out=".length));
      continue;
    }
    if (arg === "--source") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--source requires an id=path value.");
      args.sources = [...args.sources, parseSource(value)];
      index += 1;
      continue;
    }
    if (arg.startsWith("--source=")) {
      args.sources = [
        ...args.sources,
        parseSource(arg.slice("--source=".length)),
      ];
      continue;
    }
    if (arg === "--max-artifacts") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error("--max-artifacts requires a number.");
      args.maxArtifacts = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-artifacts=")) {
      args.maxArtifacts = Number.parseInt(
        arg.slice("--max-artifacts=".length),
        10,
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function parseSource(value) {
  const [id, ...rest] = value.split("=");
  const dir = rest.join("=");
  if (!id || !dir)
    throw new Error(`Invalid source "${value}". Expected id=path.`);
  return { id, dir };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim().split(/\s+/)[0] : null;
}

function runTool(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function resolveAnalysisTools() {
  return {
    tesseract: commandExists("tesseract"),
    ffprobe: commandExists("ffprobe"),
    magick: commandExists("magick"),
    identify: commandExists("identify"),
  };
}

function missingAnalysisTools(tools) {
  const missing = [];
  if (!tools.tesseract) missing.push("tesseract");
  if (!tools.ffprobe) missing.push("ffprobe");
  if (!tools.magick && !tools.identify)
    missing.push("ImageMagick (magick or identify)");
  return missing;
}

function classifyFile(filePath) {
  return TYPE_BY_EXT.get(path.extname(filePath).toLowerCase()) ?? "other";
}

function shouldIndex(filePath) {
  return TYPE_BY_EXT.has(path.extname(filePath).toLowerCase());
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && shouldIndex(full)) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

function summarizeJsonArtifact(parsed) {
  if (parsed?.summary && typeof parsed.summary === "object")
    return JSON.stringify(parsed.summary, null, 2);
  if (Array.isArray(parsed)) return `array(${parsed.length})`;
  if (parsed?.artifacts && typeof parsed.artifacts === "object") {
    return JSON.stringify(
      {
        platform: parsed.platform,
        artifacts: Object.keys(parsed.artifacts).filter(
          (key) => parsed.artifacts[key],
        ),
      },
      null,
      2,
    );
  }
  if (parsed?.status || parsed?.generatedAt || parsed?.platform) {
    return JSON.stringify(
      {
        status: parsed.status,
        generatedAt: parsed.generatedAt,
        platform: parsed.platform,
      },
      null,
      2,
    );
  }
  return null;
}

function readSummary(filePath, type) {
  if (!["json", "trajectory", "log", "markdown"].includes(type)) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8").trim();
    if (type === "json" && text.length < 500_000) {
      const summary = summarizeJsonArtifact(JSON.parse(text));
      if (summary) return summary;
    }
    return text.length > SUMMARY_LIMIT
      ? `${text.slice(0, SUMMARY_LIMIT).trimEnd()}...`
      : text;
  } catch {
    return "";
  }
}

function analyzeImage(filePath, tools) {
  const command = tools.magick ?? tools.identify;
  if (!command) return { skipped: "ImageMagick not available" };
  const args = tools.magick
    ? [filePath, "-resize", "1x1!", "-format", "%w %h %[pixel:p{0,0}]", "info:"]
    : ["-format", "%w %h %[pixel:p{0,0}]", filePath];
  const result = runTool(command, args);
  if (result.status !== 0)
    return {
      error: (result.stderr || result.stdout || "image analysis failed").trim(),
    };
  const match = result.stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return { raw: result.stdout.trim() };
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    averageColor: match[3],
  };
}

function ocrImage(filePath, tools) {
  if (!tools.tesseract) return { skipped: "tesseract not available" };
  const result = runTool(tools.tesseract, [filePath, "stdout", "--psm", "6"]);
  if (result.status !== 0)
    return { error: (result.stderr || result.stdout || "OCR failed").trim() };
  return { text: result.stdout.replace(/\s+/g, " ").trim() };
}

function analyzeVideo(filePath, tools) {
  if (!tools.ffprobe) return { skipped: "ffprobe not available" };
  const result = runTool(tools.ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,duration",
    "-of",
    "json",
    filePath,
  ]);
  if (result.status !== 0)
    return {
      error: (result.stderr || result.stdout || "video analysis failed").trim(),
    };
  try {
    const stream = JSON.parse(result.stdout).streams?.[0] ?? {};
    return {
      width: stream.width ?? null,
      height: stream.height ?? null,
      durationSeconds: stream.duration ? Number(stream.duration) : null,
    };
  } catch {
    return { raw: result.stdout.trim() };
  }
}

function enrichArtifact(filePath, type, tools) {
  if (type === "image")
    return {
      image: analyzeImage(filePath, tools),
      ocr: ocrImage(filePath, tools),
    };
  if (type === "video") return { video: analyzeVideo(filePath, tools) };
  return {};
}

function loadKnownManifest(sourceId, sourceRoot) {
  if (sourceId !== "e2e-recordings") return null;
  const manifestPath = path.join(sourceRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const tests = [];
    for (const [packageName, group] of Object.entries(
      manifest.packages ?? {},
    )) {
      for (const test of group.tests ?? [])
        tests.push({
          package: packageName,
          name: test.name,
          frameCount: test.frameCount ?? 0,
          video: test.video ?? null,
        });
    }
    return {
      kind: "e2e-recordings",
      generated: manifest.generated ?? null,
      tests,
    };
  } catch {
    return null;
  }
}

function scanEvidenceSources({
  repoRoot = REPO_ROOT,
  sources = DEFAULT_SOURCES,
  maxArtifacts = 2500,
  tools = resolveAnalysisTools(),
} = {}) {
  const artifacts = [];
  const sourceSummaries = [];
  let truncated = false;
  for (const source of sources) {
    const sourceRoot = path.resolve(repoRoot, source.dir);
    if (!fs.existsSync(sourceRoot)) {
      sourceSummaries.push({
        id: source.id,
        dir: source.dir,
        present: false,
        count: 0,
        knownManifest: null,
      });
      continue;
    }
    const files = walkFiles(sourceRoot);
    for (const filePath of files) {
      if (artifacts.length >= maxArtifacts) {
        truncated = true;
        break;
      }
      const stat = fs.statSync(filePath);
      const type = classifyFile(filePath);
      const repoRelativePath = path.relative(repoRoot, filePath);
      artifacts.push({
        id: repoRelativePath,
        source: source.id,
        type,
        path: repoRelativePath,
        name: path.basename(filePath),
        sizeBytes: stat.size,
        modifiedMs: Math.round(stat.mtimeMs),
        summary: readSummary(filePath, type),
        ...enrichArtifact(filePath, type, tools),
      });
    }
    sourceSummaries.push({
      id: source.id,
      dir: source.dir,
      present: true,
      count: files.length,
      knownManifest: loadKnownManifest(source.id, sourceRoot),
    });
  }
  artifacts.sort(
    (a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path),
  );
  return {
    generated: new Date().toISOString(),
    repoRoot,
    tools,
    missingTools: missingAnalysisTools(tools),
    sources: sourceSummaries,
    artifacts,
    totals: artifacts.reduce(
      (totals, artifact) => {
        totals.all += 1;
        totals[artifact.type] = (totals[artifact.type] ?? 0) + 1;
        return totals;
      },
      { all: 0 },
    ),
    truncated,
    maxArtifacts,
  };
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function relFromOutput(repoRoot, outputDir, repoRelativePath) {
  return path.relative(outputDir, path.join(repoRoot, repoRelativePath));
}

function buildHtml(manifest, outputDir) {
  const repoRoot = manifest.repoRoot ?? REPO_ROOT;
  const artifacts = manifest.artifacts.map((artifact) => ({
    ...artifact,
    href: relFromOutput(repoRoot, outputDir, artifact.path),
  }));
  const sourceRows = manifest.sources
    .map(
      (source) =>
        `<tr><td>${esc(source.id)}</td><td><code>${esc(source.dir)}</code></td><td>${source.present ? "present" : "missing"}</td><td>${source.count}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Evidence Review</title><style>
  :root{color-scheme:dark;--bg:#101010;--panel:#181818;--line:#303030;--text:#eee;--muted:#a0a0a0;--accent:#f97316}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
  header{padding:24px 28px 16px;border-bottom:1px solid var(--line)} h1{margin:0 0 6px;font-size:22px}.meta{color:var(--muted);font-size:12px}
  .toolbar{position:sticky;top:0;z-index:2;display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:12px 28px;background:#151515;border-bottom:1px solid var(--line)}
  input,select{background:#202020;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px 10px}input{min-width:260px;flex:1}
  main{padding:20px 28px 36px}table{width:100%;border-collapse:collapse;margin:0 0 20px;background:var(--panel);border:1px solid var(--line)}
  th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}.preview{display:flex;align-items:center;justify-content:center;min-height:154px;background:#090909;border-bottom:1px solid var(--line)}
  .preview img,.preview video{max-width:100%;max-height:260px;display:block}.preview pre,.body pre{white-space:pre-wrap;overflow:auto;margin:0;padding:12px;color:#ddd;font-size:12px;width:100%}
  .body{padding:10px 12px 12px}.body pre{max-height:120px;margin:8px 0 0;background:#111;border:1px solid var(--line);border-radius:6px}.badge{display:inline-block;color:#111;background:var(--accent);border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;margin-right:6px}
  .path{overflow-wrap:anywhere;color:#ddd;margin-top:6px}a{color:#ffb06b;text-decoration:none}.empty{color:var(--muted);padding:32px 0}
</style></head><body><header><h1>Evidence Review</h1><div class="meta">Generated ${esc(manifest.generated)} · ${manifest.totals.all} artifacts${manifest.truncated ? ` · truncated at ${manifest.maxArtifacts}` : ""} · open the artifacts and record what you verified before marking work done.</div></header>
<div class="toolbar"><input id="search" type="search" placeholder="Search path, source, type, OCR, or text preview"><select id="type"><option value="">All artifact types</option></select><select id="source"><option value="">All sources</option></select><span class="meta" id="count"></span></div>
<main><table><thead><tr><th>Source</th><th>Directory</th><th>Status</th><th>Artifacts</th></tr></thead><tbody>${sourceRows}</tbody></table><div class="grid" id="grid"></div></main>
<script>
const ARTIFACTS=${jsonForHtml(artifacts)};const types=[...new Set(ARTIFACTS.map((a)=>a.type))].sort();const sources=[...new Set(ARTIFACTS.map((a)=>a.source))].sort();const grid=document.getElementById("grid");const search=document.getElementById("search");const typeSelect=document.getElementById("type");const sourceSelect=document.getElementById("source");const count=document.getElementById("count");
function esc(value){return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}for(const type of types)typeSelect.insertAdjacentHTML("beforeend",'<option value="'+esc(type)+'">'+esc(type)+"</option>");for(const source of sources)sourceSelect.insertAdjacentHTML("beforeend",'<option value="'+esc(source)+'">'+esc(source)+"</option>");
function preview(a){if(a.type==="image")return '<img loading="lazy" src="'+esc(a.href)+'" alt="">';if(a.type==="video")return '<video controls src="'+esc(a.href)+'"></video>';if(a.summary)return "<pre>"+esc(a.summary)+"</pre>";return '<span class="meta">'+esc(a.type)+"</span>"}
function details(a){const d=[];if(a.image)d.push("image "+[a.image.width,a.image.height].filter(Boolean).join("x")+" "+(a.image.averageColor||a.image.error||""));if(a.ocr?.text)d.push("OCR: "+a.ocr.text);if(a.ocr?.error)d.push("OCR error: "+a.ocr.error);if(a.video)d.push("video "+[a.video.width,a.video.height].filter(Boolean).join("x")+" "+(a.video.durationSeconds??"")+"s");return d.join("\\n")}
function matches(a){const q=search.value.trim().toLowerCase();if(typeSelect.value&&a.type!==typeSelect.value)return false;if(sourceSelect.value&&a.source!==sourceSelect.value)return false;if(!q)return true;return [a.path,a.source,a.type,a.summary,a.ocr?.text,a.image?.averageColor].join("\\n").toLowerCase().includes(q)}
function render(){const shown=ARTIFACTS.filter(matches);count.textContent=shown.length+" shown";if(shown.length===0){grid.innerHTML='<div class="empty">No artifacts match the current filters.</div>';return}grid.innerHTML=shown.map((a)=>'<article class="card"><a class="preview" href="'+esc(a.href)+'" target="_blank" rel="noreferrer">'+preview(a)+'</a><div class="body"><span class="badge">'+esc(a.type)+'</span><span class="meta">'+esc(a.source)+'</span><div class="path"><a href="'+esc(a.href)+'" target="_blank" rel="noreferrer">'+esc(a.path)+'</a></div><div class="meta">'+Math.ceil(a.sizeBytes/1024)+" KB · "+new Date(a.modifiedMs).toLocaleString()+"</div>"+(details(a)?"<pre>"+esc(details(a))+"</pre>":"")+"</div></article>").join("")}
search.addEventListener("input",render);typeSelect.addEventListener("change",render);sourceSelect.addEventListener("change",render);render();
</script></body></html>`;
}

function writeReviewer({ manifest, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(htmlPath, buildHtml(manifest, outDir));
  return { manifestPath, htmlPath };
}

function openInBrowser(filePath) {
  const url = pathToFileURL(filePath).href;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function runSelfTest() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-review-"));
  const binDir = path.join(tempRoot, "bin");
  const fixtureDir = path.join(tempRoot, "fixtures");
  const outDir = path.join(tempRoot, "review");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "screen.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  fs.writeFileSync(path.join(fixtureDir, "run.log"), "[Fixture] path fired\n");
  fs.writeFileSync(
    path.join(fixtureDir, "trajectory.jsonl"),
    '{"turn":1,"output":"[FORM]"}\n',
  );
  fs.writeFileSync(
    path.join(binDir, "tesseract"),
    "#!/bin/sh\necho Fixture OCR text\n",
  );
  fs.writeFileSync(
    path.join(binDir, "magick"),
    "#!/bin/sh\necho '1 1 srgb(10,20,30)'\n",
  );
  fs.writeFileSync(
    path.join(binDir, "ffprobe"),
    '#!/bin/sh\necho \'{"streams":[{"width":320,"height":180,"duration":"1.5"}]}\'\n',
  );
  for (const tool of ["tesseract", "magick", "ffprobe"])
    fs.chmodSync(path.join(binDir, tool), 0o755);
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  const tools = resolveAnalysisTools();
  const manifest = scanEvidenceSources({
    sources: [{ id: "fixture", dir: path.relative(REPO_ROOT, fixtureDir) }],
    tools,
  });
  const { htmlPath } = writeReviewer({ manifest, outDir });
  const image = manifest.artifacts.find(
    (artifact) => artifact.type === "image",
  );
  if (manifest.totals.all !== 3)
    throw new Error(
      `self-test expected 3 artifacts, got ${manifest.totals.all}`,
    );
  if (!image?.ocr?.text?.includes("Fixture OCR"))
    throw new Error("self-test did not capture OCR text");
  if (image?.image?.averageColor !== "srgb(10,20,30)")
    throw new Error("self-test did not capture ImageMagick color analysis");
  console.log(`Evidence reviewer self-test passed: ${htmlPath}`);
}

function main() {
  const args = parseArgs();
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  const tools = resolveAnalysisTools();
  const manifest = scanEvidenceSources({
    sources: args.sources,
    maxArtifacts: args.maxArtifacts,
    tools,
  });
  const { manifestPath, htmlPath } = writeReviewer({
    manifest,
    outDir: args.outDir,
  });
  console.log(
    `Evidence manifest written: ${path.relative(REPO_ROOT, manifestPath)}`,
  );
  console.log(
    `Evidence reviewer written: ${path.relative(REPO_ROOT, htmlPath)}`,
  );
  console.log(`Indexed ${manifest.totals.all} artifact(s).`);
  if (args.open && os.platform()) openInBrowser(htmlPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  buildHtml,
  DEFAULT_SOURCES,
  parseArgs,
  scanEvidenceSources,
  writeReviewer,
};
