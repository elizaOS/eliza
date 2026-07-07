#!/usr/bin/env node
/**
 * Preflight health check for the evidence-capture toolchain. An agent runs this
 * before capturing PR evidence to learn which tools are present and — for each
 * missing one — the exact command to install or start it, so a missing binary
 * turns into a fixable instruction instead of a silent `skipped` record deep in
 * a capture run.
 *
 * Every probe reports `ok` / `missing` / `optional-missing` with a concrete
 * `fix` string; nothing here fabricates availability. Default exit is 0 (a
 * report, never a blocker); `--strict` exits non-zero when a REQUIRED tool is
 * missing so CI or a capture wrapper can gate on it. `--json` prints the same
 * findings machine-readably for the evidence harness to fold into a bundle.
 *
 * The required set is the floor every environment needs for the baseline
 * screenshot + OCR + video evidence the PR gate demands (playwright browsers,
 * ffmpeg, tesseract). The optional set unlocks richer verification (GPU/Baidu
 * OCR, Apple Vision, API- or CLI-driven VLM review) and degrades to an honest
 * skip when absent — so it is reported, never failed on.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Run `bin args…`; resolve the trimmed stdout, or null when the probe fails. */
async function probeCommand(bin, args, timeoutMs = 10_000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
    });
    return `${stdout}${stderr}`.trim();
  } catch {
    return null;
  }
}

function firstLine(text) {
  return (text ?? "").split("\n")[0]?.trim() ?? "";
}

/** Where `scripts/gpu-vision/serve.mjs` records a ready OCR server. */
function gpuVisionServeStatePath() {
  const override = process.env.ELIZA_GPU_VISION_CACHE?.trim();
  const root = override
    ? path.resolve(override)
    : path.join(os.homedir(), ".cache", "eliza", "gpu-vision");
  return path.join(root, "serve.json");
}

/**
 * One probe result. `required` findings that are `missing` fail `--strict`;
 * optional ones only inform. `fix` is the literal command a reader can paste.
 */
export async function runProbes(env) {
  const probes = [];

  // ---- Required: the baseline screenshot + OCR + video evidence floor. ----

  const tesseract = await probeCommand(
    env.ELIZA_TESSERACT_BIN || "tesseract",
    ["--version"],
  );
  probes.push({
    id: "tesseract",
    required: true,
    ok: tesseract !== null,
    detail: tesseract ? firstLine(tesseract) : "tesseract not on PATH",
    fix: "macOS: brew install tesseract · Debian/Ubuntu: sudo apt-get install -y tesseract-ocr · (the packaged tesseract.js fallback needs no system binary: ELIZA_MVP_OCR_ENGINE=packaged)",
  });

  const ffmpeg = await probeCommand("ffmpeg", ["-version"]);
  probes.push({
    id: "ffmpeg",
    required: true,
    ok: ffmpeg !== null,
    detail: ffmpeg
      ? firstLine(ffmpeg)
      : "ffmpeg not on PATH (ffmpeg-static ships with @elizaos/evidence for keyframe/walkthrough work)",
    fix: "macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt-get install -y ffmpeg · or rely on the bundled ffmpeg-static in packages/evidence",
  });

  const playwrightChromium = existsSyncPlaywrightBrowsers();
  probes.push({
    id: "playwright-browsers",
    required: true,
    ok: playwrightChromium,
    detail: playwrightChromium
      ? "Playwright browser cache present"
      : "no Playwright browser cache found",
    fix: "bunx playwright install chromium  (add --with-deps on Linux CI)",
  });

  // ---- Optional: richer verification; each degrades to an honest skip. ----

  const gpuServe = gpuVisionServeStatePath();
  const gpuUrl = env.ELIZA_GPU_VISION_URL?.trim();
  probes.push({
    id: "gpu-vision-ocr",
    required: false,
    ok: Boolean(gpuUrl) || existsSync(gpuServe),
    detail: gpuUrl
      ? `ELIZA_GPU_VISION_URL=${gpuUrl}`
      : existsSync(gpuServe)
        ? `serve.json present at ${gpuServe}`
        : "GPU/Baidu Unlimited-OCR server not running (falls back to tesseract)",
    fix: "node scripts/gpu-vision/setup.mjs && node scripts/gpu-vision/serve.mjs  (GPU host; sets ELIZA_GPU_VISION_URL / serve.json)",
  });

  const appleVision =
    process.platform === "darwin"
      ? await probeCommand("swift", ["--version"])
      : null;
  probes.push({
    id: "apple-vision-ocr",
    required: false,
    ok: appleVision !== null,
    detail:
      process.platform !== "darwin"
        ? "apple-vision OCR is macOS-only"
        : appleVision
          ? firstLine(appleVision)
          : "swift toolchain not installed",
    fix: "macOS only: xcode-select --install  (enables the on-device Vision OCR helper)",
  });

  const visionApi =
    Boolean(env.ANTHROPIC_API_KEY?.trim()) ||
    Boolean(env.OPENAI_API_KEY?.trim()) ||
    Boolean(env.ELIZA_VISION_QA_BASE_URL?.trim());
  probes.push({
    id: "vlm-vision-qa-api",
    required: false,
    ok: visionApi,
    detail: visionApi
      ? "an API/base-url backend is configured for vision-qa"
      : "no ANTHROPIC_API_KEY / OPENAI_API_KEY / ELIZA_VISION_QA_BASE_URL set",
    fix: "export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, or ELIZA_VISION_QA_BASE_URL for a local llama-server)",
  });

  const claudeCli = await probeCommand("claude", ["--version"]);
  const codexCli = await probeCommand("codex", ["--version"]);
  probes.push({
    id: "coding-agent-cli",
    required: false,
    ok: claudeCli !== null || codexCli !== null,
    detail: [
      claudeCli ? `claude ${firstLine(claudeCli)}` : null,
      codexCli ? `codex ${firstLine(codexCli)}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "neither claude nor codex CLI on PATH",
    fix: "install the Claude Code CLI or the Codex CLI to let vision-qa review screenshots via an already-authed coding agent (ELIZA_VISION_QA_BACKEND=cli)",
  });

  return probes;
}

/** True when a Playwright browser cache exists in any of the usual locations. */
function existsSyncPlaywrightBrowsers() {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const candidates = [
    override,
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(
      process.env.LOCALAPPDATA || os.homedir(),
      "ms-playwright",
    ),
  ].filter(Boolean);
  return candidates.some((dir) => existsSync(dir));
}

export function summarize(probes) {
  const requiredMissing = probes.filter((p) => p.required && !p.ok);
  const optionalMissing = probes.filter((p) => !p.required && !p.ok);
  return { requiredMissing, optionalMissing, ok: requiredMissing.length === 0 };
}

function printHuman(probes) {
  console.log("Evidence toolchain doctor\n");
  for (const probe of probes) {
    const tag = probe.ok ? "ok  " : probe.required ? "MISS" : "opt ";
    console.log(`  [${tag}] ${probe.id}: ${probe.detail}`);
    if (!probe.ok) console.log(`         fix: ${probe.fix}`);
  }
  const { requiredMissing, optionalMissing, ok } = summarize(probes);
  console.log("");
  if (ok) {
    console.log(
      `Required tools present. ${optionalMissing.length} optional capability(ies) unavailable (evidence degrades to honest skips).`,
    );
  } else {
    console.log(
      `${requiredMissing.length} REQUIRED tool(s) missing: ${requiredMissing
        .map((p) => p.id)
        .join(", ")}. Install them before capturing evidence (see fix lines above).`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/evidence-doctor.mjs [--json] [--strict]\n\n" +
        "  --json    Print findings as JSON.\n" +
        "  --strict  Exit non-zero when a REQUIRED tool is missing.\n",
    );
    return;
  }
  const probes = await runProbes(process.env);
  const { ok } = summarize(probes);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok, probes }, null, 2));
  } else {
    printHuman(probes);
  }
  if (args.includes("--strict") && !ok) process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
