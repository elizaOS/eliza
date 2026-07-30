#!/usr/bin/env node
/**
 * Probes the evidence-capture toolchain and emits human or normalized JSON
 * findings. Required capabilities are shared with the installer and validated
 * by loading packaged OCR, resolving executable media binaries, and launching
 * the repository-pinned Playwright Chromium rather than trusting cache paths.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertSupportedPlatform,
  EVIDENCE_REQUIREMENTS,
  resolveMediaRequirements,
} from "./evidence-install-tools.mjs";

const execFileAsync = promisify(execFile);
const OCR_FIXTURE_TEXT = "ELIZA";
const OCR_GLYPHS = Object.freeze({
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
});

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function buildOcrFixtureBmp() {
  const scale = 8;
  const margin = 2;
  const glyphWidth = 5;
  const glyphHeight = 7;
  const spacing = 2;
  const widthUnits =
    margin * 2 +
    OCR_FIXTURE_TEXT.length * glyphWidth +
    (OCR_FIXTURE_TEXT.length - 1) * spacing;
  const heightUnits = margin * 2 + glyphHeight;
  const width = widthUnits * scale;
  const height = heightUnits * scale;
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bitmap = Buffer.alloc(54 + pixelBytes);
  bitmap.write("BM", 0, "ascii");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(pixelBytes, 34);
  bitmap.writeInt32LE(2835, 38);
  bitmap.writeInt32LE(2835, 42);
  bitmap.fill(255, 54);

  for (const [characterIndex, character] of [...OCR_FIXTURE_TEXT].entries()) {
    const glyph = OCR_GLYPHS[character];
    const originX = margin + characterIndex * (glyphWidth + spacing);
    for (const [row, pattern] of glyph.entries()) {
      for (const [column, pixel] of [...pattern].entries()) {
        if (pixel !== "1") continue;
        for (let scaleY = 0; scaleY < scale; scaleY += 1) {
          for (let scaleX = 0; scaleX < scale; scaleX += 1) {
            const x = (originX + column) * scale + scaleX;
            const y = (margin + row) * scale + scaleY;
            const bmpRow = height - y - 1;
            const offset = 54 + bmpRow * rowStride + x * 3;
            bitmap[offset] = 0;
            bitmap[offset + 1] = 0;
            bitmap[offset + 2] = 0;
          }
        }
      }
    }
  }
  return bitmap;
}

async function probeCommand(bin, args, timeoutMs = 10_000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    return `${stdout}${stderr}`.trim();
  } catch {
    // error-policy:J4 an unavailable executable is an explicit probe result.
    return null;
  }
}

function firstLine(text) {
  return (text ?? "").split(/\r?\n/u)[0]?.trim() ?? "";
}

function gpuVisionServeStatePath(env, homeDir) {
  const override = env.ELIZA_GPU_VISION_CACHE?.trim();
  const root = override
    ? path.resolve(override)
    : path.join(homeDir, ".cache", "eliza", "gpu-vision");
  return path.join(root, "serve.json");
}

function platformFixes(platform) {
  if (platform === "win32") {
    return {
      systemTesseract:
        "optional system OCR: winget install --id UB-Mannheim.TesseractOCR --exact",
      systemFfmpeg:
        "optional system media tools: winget install --id Gyan.FFmpeg --exact",
      github:
        "winget install --id GitHub.cli --exact --accept-package-agreements --accept-source-agreements",
    };
  }
  if (platform === "darwin") {
    return {
      systemTesseract: "optional system OCR: brew install tesseract",
      systemFfmpeg: "optional system media tools: brew install ffmpeg",
      github: "brew install gh",
    };
  }
  return {
    systemTesseract:
      "optional system OCR: install tesseract-ocr with apt, dnf, yum, apk, pacman, or zypper",
    systemFfmpeg:
      "optional system media tools: install ffmpeg with apt, dnf, yum, apk, pacman, or zypper",
    github: "install `gh` with apt, dnf, yum, apk, pacman, or zypper",
  };
}

export async function probePackagedOcr({
  loadTesseract = () => import(EVIDENCE_REQUIREMENTS.ocr.packageName),
  tempRoot = os.tmpdir(),
  timeoutMs = 60_000,
} = {}) {
  const directory = await mkdtemp(path.join(tempRoot, "eliza-ocr-doctor-"));
  let workerPromise;
  let worker;
  let result;
  try {
    const tesseract = await loadTesseract();
    if (typeof tesseract.createWorker !== "function") {
      return {
        ok: false,
        detail: `${EVIDENCE_REQUIREMENTS.ocr.packageName} lacks createWorker`,
      };
    }
    workerPromise = Promise.resolve(
      tesseract.createWorker("eng", 1, { cachePath: directory }),
    );
    worker = await withTimeout(
      workerPromise,
      timeoutMs,
      "packaged OCR worker initialization",
    );
    if (
      tesseract.PSM?.SINGLE_LINE &&
      typeof worker.setParameters === "function"
    ) {
      await withTimeout(
        worker.setParameters({
          tessedit_pageseg_mode: tesseract.PSM.SINGLE_LINE,
        }),
        timeoutMs,
        "packaged OCR fixture configuration",
      );
    }
    const recognition = await withTimeout(
      worker.recognize(buildOcrFixtureBmp()),
      timeoutMs,
      "packaged OCR fixture recognition",
    );
    const transcript = String(recognition?.data?.text ?? "")
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]/gu, "");
    result = transcript.includes(OCR_FIXTURE_TEXT)
      ? {
          ok: true,
          detail: `${EVIDENCE_REQUIREMENTS.ocr.packageName} recognized the bundled ${OCR_FIXTURE_TEXT} fixture`,
        }
      : {
          ok: false,
          detail: `${EVIDENCE_REQUIREMENTS.ocr.packageName} did not recognize the bundled fixture`,
        };
  } catch {
    // error-policy:J4 package load, worker, or recognition failure is missing.
    result = {
      ok: false,
      detail: `${EVIDENCE_REQUIREMENTS.ocr.packageName} could not recognize the bundled fixture`,
    };
  } finally {
    try {
      if (worker) {
        try {
          await withTimeout(
            worker.terminate(),
            timeoutMs,
            "packaged OCR worker teardown",
          );
        } catch {
          // error-policy:J6 teardown is best-effort; a hung terminate must not
          // replace the probe result or crash the doctor.
        }
      } else if (workerPromise) {
        // error-policy:J5 a createWorker call that outlived its deadline can
        // still resolve later; its threads would keep the process alive, so
        // terminate the late worker here — the timeout above already reported
        // the failure, making this fire-and-forget teardown the only observer.
        workerPromise
          .then((lateWorker) => lateWorker?.terminate?.())
          .catch(() => {});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return result;
}

/**
 * Behavioral probe for a system tesseract binary: it must recognize the
 * generated ELIZA fixture, mirroring the evidence OCR engine's CLI shape
 * (`tesseract <img> - --psm <n>`, see packages/evidence/src/analyzers/ocr/
 * engines.ts). The probe uses `--psm 8` (single word) because the fixture is
 * one word — the engine's screenshot default `--psm 6` segments the blocky
 * glyph grid unreliably. A binary that answers --version but cannot read the
 * fixture is not a working OCR capability and must not be reported as one.
 */
export async function probeSystemTesseract({
  bin = "tesseract",
  run = execFileAsync,
  tempRoot = os.tmpdir(),
  timeoutMs = 60_000,
} = {}) {
  const directory = await mkdtemp(
    path.join(tempRoot, "eliza-ocr-doctor-system-"),
  );
  const fixturePath = path.join(directory, "fixture.bmp");
  try {
    await writeFile(fixturePath, buildOcrFixtureBmp());
    const { stdout } = await run(bin, [fixturePath, "-", "--psm", "8"], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    const transcript = String(stdout ?? "")
      .toUpperCase()
      .replaceAll(/[^A-Z0-9]/gu, "");
    return transcript.includes(OCR_FIXTURE_TEXT)
      ? {
          ok: true,
          detail: `system tesseract at ${bin} recognized the bundled ${OCR_FIXTURE_TEXT} fixture`,
        }
      : {
          ok: false,
          detail: `system tesseract at ${bin} did not recognize the bundled fixture`,
        };
  } catch {
    // error-policy:J4 a missing or failing binary is an explicit probe result.
    return {
      ok: false,
      detail: `system tesseract at ${bin} is unavailable or failed on the bundled fixture`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function probeMediaPipeline(
  resolutions,
  { run = execFileAsync, tempRoot = os.tmpdir(), timeoutMs = 30_000 } = {},
) {
  if (!resolutions.ffmpeg.available || !resolutions.ffprobe.available) {
    return {
      ok: false,
      detail: "ffmpeg and ffprobe must both resolve before media validation",
    };
  }
  const directory = await mkdtemp(
    path.join(tempRoot, "eliza-evidence-doctor-"),
  );
  const encodedPath = path.join(directory, "fixture.mp4");
  const decodedPath = path.join(directory, "fixture.rgb");
  try {
    await run(
      resolutions.ffmpeg.bin,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x32:d=0.1",
        "-frames:v",
        "1",
        "-c:v",
        "mpeg4",
        "-pix_fmt",
        "yuv420p",
        encodedPath,
      ],
      { timeout: timeoutMs, windowsHide: true },
    );
    const probe = await run(
      resolutions.ffprobe.bin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        encodedPath,
      ],
      { timeout: timeoutMs, windowsHide: true },
    );
    const metadata = JSON.parse(String(probe.stdout ?? ""));
    const stream = metadata.streams?.[0];
    if (
      stream?.codec_type !== "video" ||
      stream.width !== 32 ||
      stream.height !== 32
    ) {
      throw new Error("ffprobe returned unexpected fixture metadata");
    }
    await run(
      resolutions.ffmpeg.bin,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        encodedPath,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        decodedPath,
      ],
      { timeout: timeoutMs, windowsHide: true },
    );
    const decoded = await stat(decodedPath);
    if (decoded.size !== 32 * 32 * 3) {
      throw new Error("decoded fixture has an unexpected byte length");
    }
    return {
      ok: true,
      detail: "ffmpeg encode, ffprobe metadata, and ffmpeg decode passed",
    };
  } catch {
    // error-policy:J4 a failed real media round trip is unavailable.
    return {
      ok: false,
      detail: "ffmpeg encode, ffprobe metadata, or ffmpeg decode failed",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probePlaywrightChromium() {
  try {
    const playwright = await import(
      EVIDENCE_REQUIREMENTS.playwright.packageName
    );
    const executablePath = playwright.chromium.executablePath();
    if (!existsSync(executablePath)) {
      return {
        ok: false,
        detail: "Playwright Chromium executable is not installed",
      };
    }
    const browser = await playwright.chromium.launch({
      headless: true,
      timeout: 30_000,
    });
    const version = browser.version();
    await browser.close();
    return {
      ok: true,
      detail: `Playwright Chromium ${version} launched successfully`,
    };
  } catch {
    // error-policy:J4 a package, executable, or launch failure is unavailable.
    return {
      ok: false,
      detail: "Playwright Chromium is not installed or could not launch",
    };
  }
}

export async function runProbes(
  env,
  {
    platform = process.platform,
    homeDir = os.homedir(),
    commandProbe = probeCommand,
    mediaResolver = resolveMediaRequirements,
    mediaPipelineProbe = probeMediaPipeline,
    ocrProbe = probePackagedOcr,
    systemOcrProbe = probeSystemTesseract,
    playwrightProbe = probePlaywrightChromium,
    pathExists = existsSync,
  } = {},
) {
  assertSupportedPlatform(platform);
  const probes = [];
  const fixes = platformFixes(platform);

  const packagedOcr = await ocrProbe();
  // The fallback is behavioral like the packaged probe: the system binary must
  // recognize the same fixture, never merely answer --version.
  const systemOcr = packagedOcr.ok
    ? null
    : await systemOcrProbe({ bin: env.ELIZA_TESSERACT_BIN || "tesseract" });
  probes.push({
    id: EVIDENCE_REQUIREMENTS.ocr.id,
    required: EVIDENCE_REQUIREMENTS.ocr.requiredByDefault,
    ok: packagedOcr.ok || systemOcr?.ok === true,
    detail: packagedOcr.ok
      ? packagedOcr.detail
      : systemOcr?.ok
        ? `${systemOcr.detail} (system fallback)`
        : `${packagedOcr.detail}; ${systemOcr.detail}`,
    fix: `bun run evidence:install-tools · ${fixes.systemTesseract}`,
  });

  const media = await mediaResolver();
  const mediaPipeline = await mediaPipelineProbe(media);
  for (const key of ["ffmpeg", "ffprobe"]) {
    const requirement = EVIDENCE_REQUIREMENTS[key];
    const resolution = media[key];
    probes.push({
      id: requirement.id,
      required: requirement.requiredByDefault,
      ok: resolution.available && mediaPipeline.ok,
      detail:
        resolution.available && mediaPipeline.ok
          ? `${requirement.id} ${resolution.source} binary passed the encode/probe/decode fixture`
          : resolution.available
            ? mediaPipeline.detail
            : `${requirement.id} has no invocable configured, system, or packaged binary`,
      fix: `bun run evidence:install-tools · ${fixes.systemFfmpeg}`,
    });
  }

  const playwright = await playwrightProbe();
  probes.push({
    id: EVIDENCE_REQUIREMENTS.playwright.id,
    required: EVIDENCE_REQUIREMENTS.playwright.requiredByDefault,
    ok: playwright.ok,
    detail: playwright.detail,
    fix: "bun run evidence:install-tools (installs the pinned Chromium build and Linux OS dependencies when passwordless sudo is available)",
  });

  const ghVersion = await commandProbe(
    EVIDENCE_REQUIREMENTS.githubCli.systemCommand,
    ["--version"],
  );
  probes.push({
    id: EVIDENCE_REQUIREMENTS.githubCli.id,
    required: EVIDENCE_REQUIREMENTS.githubCli.requiredByDefault,
    ok: ghVersion !== null,
    detail: ghVersion ? firstLine(ghVersion) : "GitHub CLI is not installed",
    fix: `bun run evidence:install-tools -- --github · ${fixes.github}`,
  });

  const gpuServe = gpuVisionServeStatePath(env, homeDir);
  const gpuUrl = env.ELIZA_GPU_VISION_URL?.trim();
  probes.push({
    id: "gpu-vision-ocr",
    required: false,
    ok: Boolean(gpuUrl) || pathExists(gpuServe),
    detail: gpuUrl
      ? "ELIZA_GPU_VISION_URL is configured (value hidden)"
      : pathExists(gpuServe)
        ? `serve.json present at ${gpuServe}`
        : "GPU/Baidu Unlimited-OCR server not running (falls back to tesseract)",
    fix: "node scripts/gpu-vision/setup.mjs && node scripts/gpu-vision/serve.mjs  (GPU host; sets ELIZA_GPU_VISION_URL / serve.json)",
  });

  const appleVision =
    platform === "darwin" ? await commandProbe("swift", ["--version"]) : null;
  probes.push({
    id: "apple-vision-ocr",
    required: false,
    ok: appleVision !== null,
    detail:
      platform !== "darwin"
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
    fix: "configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or ELIZA_VISION_QA_BASE_URL through the environment or secret store",
  });

  const claudeCli = await commandProbe("claude", ["--version"]);
  const codexCli = await commandProbe("codex", ["--version"]);
  probes.push({
    id: "coding-agent-cli",
    required: false,
    ok: claudeCli !== null || codexCli !== null,
    detail:
      [
        claudeCli ? `claude ${firstLine(claudeCli)}` : null,
        codexCli ? `codex ${firstLine(codexCli)}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "neither claude nor codex CLI is on PATH",
    fix: "install the Claude Code CLI or the Codex CLI to let vision-qa review screenshots through an already-authenticated coding agent",
  });

  return probes;
}

export function summarize(probes) {
  const requiredMissing = probes.filter((probe) => probe.required && !probe.ok);
  const optionalMissing = probes.filter(
    (probe) => !probe.required && !probe.ok,
  );
  return { requiredMissing, optionalMissing, ok: requiredMissing.length === 0 };
}

export function createDoctorReport(
  probes,
  {
    platform = process.platform,
    architecture = process.arch,
    nodeVersion = process.version,
  } = {},
) {
  const summary = summarize(probes);
  return {
    schemaVersion: 1,
    platform: {
      os: platform,
      architecture,
      nodeVersion,
    },
    ok: summary.ok,
    requiredMissing: summary.requiredMissing.map(({ id }) => id),
    optionalMissing: summary.optionalMissing.map(({ id }) => id),
    probes,
  };
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
      `Required tools present. ${optionalMissing.length} optional capability(ies) unavailable.`,
    );
  } else {
    console.log(
      `${requiredMissing.length} REQUIRED tool(s) missing: ${requiredMissing
        .map(({ id }) => id)
        .join(", ")}. Install them before capturing evidence.`,
    );
  }
}

export function parseDoctorArgs(args) {
  const supported = new Set(["--help", "-h", "--json", "--strict"]);
  for (const arg of args) {
    if (!supported.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    strict: args.includes("--strict"),
  };
}

async function main() {
  const options = parseDoctorArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/evidence-doctor.mjs [--json] [--strict]\n\n" +
        "  --json            Print a normalized platform report as JSON.\n" +
        "  --strict          Exit non-zero when a REQUIRED tool is missing.\n",
    );
    return;
  }
  const probes = await runProbes(process.env);
  const report = createDoctorReport(probes);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(probes);
  }
  if (options.strict && !report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    // error-policy:J1 invalid invocations become one bounded CLI failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`evidence-doctor: ${message}`);
    process.exitCode = 1;
  }
}
