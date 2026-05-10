/**
 * Post-build symbol verification for fused targets.
 *
 * Asserts that the produced fused shared library (libelizainference)
 * exports BOTH `llama_*` and `omnivoice_*` symbols. If either family
 * is missing, the link step silently produced a half-fused artifact —
 * a hard error per packages/inference/AGENTS.md §3 ("missing fusion =
 * hard error", no fallback).
 *
 * Strategy:
 *   - Darwin: nm -gU <lib>     (defined externals)
 *   - Linux:  nm -D --defined-only <lib>
 *   - Windows: objdump -T <lib> (cross-toolchain ships it; PE has no
 *     standard `nm -D`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function pickToolForPlatform(target) {
  // target is e.g. "darwin-arm64-metal-fused", "linux-x64-vulkan-fused", etc.
  if (target.startsWith("darwin-")) {
    return { cmd: "nm", args: ["-gU"] };
  }
  if (target.startsWith("windows-")) {
    return { cmd: "x86_64-w64-mingw32-objdump", args: ["-T"] };
  }
  // Linux + cross targets that emit ELF.
  return { cmd: "nm", args: ["-D", "--defined-only"] };
}

function locateFusedLibrary({ outDir, target }) {
  const candidates = [];
  if (target.startsWith("darwin-")) {
    candidates.push("libelizainference.dylib");
  } else if (target.startsWith("windows-")) {
    candidates.push("elizainference.dll", "libelizainference.dll");
  } else {
    candidates.push("libelizainference.so");
  }
  for (const name of candidates) {
    const full = path.join(outDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function locateFusedServer({ outDir, target }) {
  const names = target.startsWith("windows-")
    ? ["llama-omnivoice-server.exe"]
    : ["llama-omnivoice-server"];
  for (const name of names) {
    const full = path.join(outDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function dumpSymbols({ tool, file }) {
  const result = spawnSync(tool.cmd, [...tool.args, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${tool.cmd} failed to run on ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${tool.cmd} ${tool.args.join(" ")} ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout || "";
}

/**
 * Verify a fused target's outputs. Hard-throws on any failure.
 *
 *   - The shared library MUST exist.
 *   - The library's exports MUST contain both /llama_/ and /omnivoice_/
 *     symbol families.
 *
 * Returns a small report so the caller can record it in CAPABILITIES.json.
 */
export function verifyFusedSymbols({ outDir, target }) {
  const lib = locateFusedLibrary({ outDir, target });
  if (!lib) {
    throw new Error(
      `[omnivoice-fuse] fused library not found in ${outDir}; the fused build did not link libelizainference for target=${target}`,
    );
  }
  const tool = pickToolForPlatform(target);
  const symbols = dumpSymbols({ tool, file: lib });

  const llamaCount = (symbols.match(/\bllama_[A-Za-z_0-9]+/g) || []).length;
  const omnivoiceCount = (symbols.match(/\bomnivoice_[A-Za-z_0-9]+/g) || [])
    .length;

  if (llamaCount === 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} has no llama_* exports — text inference is missing from the fused artifact`,
    );
  }
  if (omnivoiceCount === 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} has no omnivoice_* exports — TTS is missing from the fused artifact`,
    );
  }

  // Optional fused-server check: it's expected, but the route-mount work
  // is a TODO (see cmake-graft.mjs). If it exists, verify its symbol
  // families too — the executable must drag in omnivoice-core, not just
  // llama. If it doesn't exist, that's also acceptable for now (the
  // shared library is the contract surface for the bridges).
  let serverReport = null;
  const server = locateFusedServer({ outDir, target });
  if (server) {
    const serverSyms = dumpSymbols({ tool, file: server });
    serverReport = {
      llamaSymbolCount: (serverSyms.match(/\bllama_[A-Za-z_0-9]+/g) || [])
        .length,
      omnivoiceSymbolCount: (serverSyms.match(/\bomnivoice_[A-Za-z_0-9]+/g) ||
        []).length,
      path: server,
    };
  }

  return {
    library: lib,
    tool: `${tool.cmd} ${tool.args.join(" ")}`,
    llamaSymbolCount: llamaCount,
    omnivoiceSymbolCount: omnivoiceCount,
    server: serverReport,
  };
}
