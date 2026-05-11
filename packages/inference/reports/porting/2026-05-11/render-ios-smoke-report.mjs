#!/usr/bin/env node
// Render the iOS physical-device runtime-smoke Markdown report from the JSON
// emitted by packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs.
//
// The JSON is the single source of truth; the .md is a human-readable view of it.
// Re-run after a fresh smoke:
//   node packages/inference/reports/porting/2026-05-11/render-ios-smoke-report.mjs
//
// Optional args:
//   --json <path>   input JSON (default: ./ios-physical-device-smoke-latest.json next to this script)
//   --out  <path>   output Markdown (default: ./ios-physical-device-smoke.md next to this script)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { json: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else throw new Error(`unexpected arg: ${argv[i]}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const jsonPath = path.resolve(args.json ?? path.join(here, "ios-physical-device-smoke-latest.json"));
const outPath = path.resolve(args.out ?? path.join(here, "ios-physical-device-smoke.md"));

const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

// Parse the XCTest summary out of xcodebuild stdoutTail. We only assert what the
// log literally says — no inferring extra cases.
function extractXcTestSummary(stdoutTail) {
  const text = String(stdoutTail ?? "");
  const cases = [];
  // xcodebuild prints e.g.
  //   Test Case '-[ElizaIosRuntimeSmokeTests.ElizaIosRuntimeSmokeTests testFoo]' passed (0.001 seconds).
  const re = /Test Case '-\[[^\] ]+ ([A-Za-z0-9_]+)\]' (passed|failed) \(([0-9.]+) seconds\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    cases.push({ name: m[1], result: m[2], seconds: Number(m[3]) });
  }
  const totalMatch = text.match(/Executed (\d+) tests?, with (\d+) failures \((\d+) unexpected\)/);
  const succeeded = /\*\* TEST SUCCEEDED \*\*/.test(text);
  return {
    cases,
    executed: totalMatch ? Number(totalMatch[1]) : cases.length,
    failures: totalMatch ? Number(totalMatch[2]) : null,
    succeeded,
  };
}

const summary = extractXcTestSummary(data?.xcodebuild?.stdoutTail);

function fmtDate(iso) {
  return iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "n/a";
}
function durationSeconds(a, b) {
  if (!a || !b) return null;
  return ((Date.parse(b) - Date.parse(a)) / 1000).toFixed(0);
}

const dev = data.device ?? {};
const model = dev.model ?? "unknown device";
const iosVersion = dev.version ?? dev.matchedFromOfflineDevice?.version ?? "unknown";
const xcodeVer = (data?.toolchain?.xcodebuild?.stdout ?? "").trim().replace(/\n/g, " / ") || "unknown";
const dur = durationSeconds(data.startedAt, data.finishedAt);
const slice = data.xcframeworkDeviceSlice?.library ?? {};

const requiredSymbols = data.requiredSymbols ?? {};
const symbolGroups = Object.entries(requiredSymbols)
  .map(([group, list]) => `- \`${group}\`: ${(list ?? []).map((s) => `\`${s}\``).join(", ")}`)
  .join("\n");

const lines = [];
lines.push("# iOS Physical-Device Runtime Smoke - 2026-05-11");
lines.push("");
lines.push(
  "> This file is generated from `ios-physical-device-smoke-latest.json` by",
);
lines.push("> `render-ios-smoke-report.mjs` (same directory). Do not hand-edit; re-run the");
lines.push("> generator after a fresh smoke.");
lines.push("");
lines.push("## Status");
lines.push("");
if (data.status === "passed" && summary.succeeded) {
  lines.push(
    `**PASS** — on-device XCTest succeeded on ${model}, iOS ${iosVersion}.`,
  );
  lines.push("");
  lines.push(
    `Executed ${summary.executed} XCTest case(s), ${summary.failures ?? 0} failure(s):`,
  );
  for (const c of summary.cases) {
    lines.push(`- \`${c.name}\` — ${c.result} (${c.seconds.toFixed(3)}s)`);
  }
} else {
  lines.push(`**${(data.status ?? "unknown").toUpperCase()}** — see \`blocker\` below.`);
  if (data.blocker) lines.push("", `Blocker: ${JSON.stringify(data.blocker)}`);
}
lines.push("");
lines.push("## Run Metadata");
lines.push("");
lines.push(`- Device: ${model} — id \`${dev.id ?? "n/a"}\`, state \`${dev.state ?? "n/a"}\``);
lines.push(`- iOS: ${iosVersion}`);
lines.push(`- Xcode / xctrace: ${xcodeVer}; xctrace ${(data?.toolchain?.xctrace?.stdout ?? "").trim() || "unknown"}`);
lines.push(`- Started: ${fmtDate(data.startedAt)} · Finished: ${fmtDate(data.finishedAt)}${dur ? ` · ${dur}s wall (most of it waiting for the device to be unlocked)` : ""}`);
lines.push(
  `- xcframework device slice: \`${slice.LibraryIdentifier ?? "n/a"}\` (${(slice.SupportedArchitectures ?? []).join(", ")}), \`${slice.LibraryPath ?? "n/a"}\``,
);
lines.push(`- xcodebuild exit status: ${data?.xcodebuild?.status ?? "n/a"}`);
lines.push("");
lines.push("## Runnable Entrypoint");
lines.push("");
lines.push("```sh");
lines.push("ELIZA_IOS_DEVELOPMENT_TEAM=<Apple Team ID> \\");
lines.push("  node packages/app-core/scripts/ios-xcframework/run-physical-device-smoke.mjs \\");
lines.push("    --build-if-missing \\");
lines.push("    --report packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke-latest.json");
lines.push("```");
lines.push("");
lines.push("It is physical-device only: it rejects simulators and exits non-zero when no");
lines.push("connected, unlocked, trusted iPhone/iPad is available. Fail-closed flags in this run:");
for (const [k, v] of Object.entries(data.failClosed ?? {})) {
  lines.push(`- \`${k}\`: ${v}`);
}
lines.push("");
lines.push("## What This Smoke Actually Verified");
lines.push("");
lines.push("On the physical device, the XCTest runner asserted that:");
lines.push("");
lines.push(
  "- `MTLCreateSystemDefaultDevice()` returns a non-nil Metal device with a non-empty name (`testMetalDeviceIsAvailableOnPhysicalIos`).",
);
lines.push(
  "- Every required Eliza-1 runtime symbol resolves via `dlsym(RTLD_DEFAULT, …)` at runtime (`testLlamaKernelAndVoiceSymbolsResolve`) — the LlamaCpp bridge symbols, the QJL / PolarQuant kernel symbols, and the `libelizainference` ABI v1 voice symbols.",
);
lines.push(
  "- The same `LlamaCpp.xcframework` consumed by `llama-cpp-capacitor` (`ios-arm64` slice) links into the hosted XCTest runner and survives code-signing + on-device launch.",
);
lines.push("");
lines.push("Required-symbol manifest used by the run:");
lines.push("");
lines.push(symbolGroups);
lines.push("");
lines.push("## What It Does NOT Claim");
lines.push("");
lines.push("This is a **symbol-resolution + xcframework-structure + Metal-availability** check on");
lines.push("device. It is not a numerical model-generation pass:");
lines.push("");
lines.push("- No Eliza-1 weights are staged into the temporary XCTest package.");
lines.push("- No tokens are generated; no TTS/ASR audio is produced.");
lines.push("- No latency, RSS, or thermal numbers are measured.");
lines.push("");
lines.push("A release-quality iOS pass still requires the follow-up weight-backed Capacitor");
lines.push("bundle smoke that loads the exact release artifact and records: first token latency,");
lines.push("first audio latency, peak RSS, thermal state, a minimal text response, a minimal");
lines.push("TTS/voice response, and voice-off mode proving the TTS/ASR mmap regions stay unmapped.");
lines.push("That bundle smoke is tracked in `needs-hardware-ledger.md`.");
lines.push("");

fs.writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`[render-ios-smoke-report] wrote ${path.relative(process.cwd(), outPath)} from ${path.relative(process.cwd(), jsonPath)} (status=${data.status}, xctest=${summary.executed}/${summary.executed - (summary.failures ?? 0)})`);
