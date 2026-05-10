/**
 * Clone omnivoice.cpp at the pinned commit, strip its `ggml/` submodule,
 * and copy `src/` + `tools/` + selected `examples/` data into the
 * llama.cpp tree under `<llamaCppRoot>/omnivoice/`.
 *
 * Caller (build-llama-cpp-dflash.mjs):
 *   import { prepareOmnivoiceFusion } from
 *     "./omnivoice-fuse/prepare.mjs";
 *   const { commit, ggmlSubmoduleCommit, sourceCount } =
 *     prepareOmnivoiceFusion({
 *       cacheRoot: "...", // ~/.cache/eliza-dflash
 *       llamaCppRoot: "...", // path to milady-ai/llama.cpp checkout
 *       omnivoiceRef: "38f824023d…",
 *     });
 *
 * Failure modes are hard errors — see omnivoice-fuse/README.md. There
 * is no fallback path.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OMNIVOICE_REPO =
  process.env.MILADY_OMNIVOICE_REMOTE ||
  "https://github.com/ServeurpersoCom/omnivoice.cpp.git";

// Master HEAD as of 2026-05-10. Bump per the runbook in README.md.
export const OMNIVOICE_REF =
  process.env.MILADY_OMNIVOICE_REF || "38f824023d12b21a7c324651b18bd90f16d8bb86";

// The ServeurpersoCom ggml submodule pin we explicitly DO NOT include
// in the fused build. Recorded so verify-symbols.mjs can assert that no
// `omnivoice/ggml` directory is left dangling under the llama.cpp tree.
export const OMNIVOICE_GGML_REF =
  process.env.MILADY_OMNIVOICE_GGML_REF ||
  "0e3980ef205ea3639650f59e54cfeecd7d947700";

// Subdirectory inside the llama.cpp checkout where omnivoice sources
// land. Stable so the CMake graft and the symbol verifier agree.
export const OMNIVOICE_GRAFT_SUBDIR = "omnivoice";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = opts.capture
      ? `\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
      : "";
    throw new Error(
      `[omnivoice-fuse] ${cmd} ${args.join(" ")} failed with ${result.status}${detail}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      fs.copyFileSync(from, to);
    }
  }
}

// Ensure a clone of omnivoice.cpp at OMNIVOICE_REF lives under
// <cacheRoot>/omnivoice.cpp. Returns the resolved HEAD commit.
function ensureOmnivoiceCheckout(cacheRoot, ref) {
  const checkoutDir = path.join(cacheRoot, "omnivoice.cpp");
  if (fs.existsSync(path.join(checkoutDir, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: checkoutDir });
    run("git", ["checkout", "FETCH_HEAD"], { cwd: checkoutDir });
  } else {
    fs.mkdirSync(cacheRoot, { recursive: true });
    // Some refs (raw commit hashes) don't work with `--branch`. Try the
    // tag/branch path first, then fall back to a full clone + checkout
    // by hash. Either way, the commit pin must resolve.
    const looksLikeHash = /^[0-9a-f]{7,40}$/i.test(ref);
    if (looksLikeHash) {
      run("git", ["clone", OMNIVOICE_REPO, checkoutDir]);
      run("git", ["checkout", ref], { cwd: checkoutDir });
    } else {
      run("git", [
        "clone",
        "--depth=1",
        "--branch",
        ref,
        OMNIVOICE_REPO,
        checkoutDir,
      ]);
    }
  }
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: checkoutDir,
    capture: true,
  });
  return { checkoutDir, head };
}

// Read the omnivoice ggml submodule's recorded commit from the parent
// repo's index, without actually fetching the submodule contents. This
// is the value we explicitly DO NOT use in the fused build — we record
// it for the manifest and verifier.
function readOmnivoiceGgmlSubmoduleCommit(checkoutDir) {
  const result = spawnSync("git", ["ls-tree", "HEAD", "ggml"], {
    cwd: checkoutDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const match = /^160000\s+commit\s+([0-9a-f]{40})/.exec(
    result.stdout || "",
  );
  return match ? match[1] : null;
}

// Apply every `omnivoice-fuse/patches/*.patch` to the merged tree, in
// lexical order. Hard error on any failure — there is no fallback.
function applyPatches({ patchesDir, llamaCppRoot }) {
  if (!fs.existsSync(patchesDir)) return [];
  const patches = fs
    .readdirSync(patchesDir)
    .filter((name) => name.endsWith(".patch"))
    .sort();
  const applied = [];
  for (const name of patches) {
    const patchPath = path.join(patchesDir, name);
    const sentinel = path.join(
      llamaCppRoot,
      ".omnivoice-fuse-patch-applied",
      name,
    );
    if (fs.existsSync(sentinel)) {
      applied.push({ name, status: "already-applied" });
      continue;
    }
    run("git", ["apply", "--check", patchPath], { cwd: llamaCppRoot });
    run("git", ["apply", patchPath], { cwd: llamaCppRoot });
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, `${new Date().toISOString()}\n`);
    applied.push({ name, status: "applied" });
  }
  return applied;
}

/**
 * Main entry. Performs the full prepare phase. All errors propagate.
 */
export function prepareOmnivoiceFusion({
  cacheRoot,
  llamaCppRoot,
  omnivoiceRef = OMNIVOICE_REF,
}) {
  if (!cacheRoot) throw new Error("[omnivoice-fuse] cacheRoot is required");
  if (!llamaCppRoot)
    throw new Error("[omnivoice-fuse] llamaCppRoot is required");
  if (!fs.existsSync(path.join(llamaCppRoot, "CMakeLists.txt"))) {
    throw new Error(
      `[omnivoice-fuse] llamaCppRoot=${llamaCppRoot} missing CMakeLists.txt; clone the fork first`,
    );
  }
  if (!fs.existsSync(path.join(llamaCppRoot, "ggml", "CMakeLists.txt"))) {
    throw new Error(
      `[omnivoice-fuse] llamaCppRoot=${llamaCppRoot} missing ggml/CMakeLists.txt; the milady ggml is required for fusion`,
    );
  }

  const { checkoutDir, head } = ensureOmnivoiceCheckout(
    cacheRoot,
    omnivoiceRef,
  );
  const ggmlSubmoduleCommit = readOmnivoiceGgmlSubmoduleCommit(checkoutDir);

  // Validate the omnivoice checkout's surface. Missing pieces => hard
  // error. The runbook requires the operator to investigate, not the
  // build to silently degrade.
  const requiredDirs = ["src", "tools"];
  for (const dir of requiredDirs) {
    const full = path.join(checkoutDir, dir);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      throw new Error(
        `[omnivoice-fuse] omnivoice checkout at ${checkoutDir} missing required directory '${dir}' — pin ${head} is not usable`,
      );
    }
  }
  // The presence of an entry point we know exists in the pinned commit
  // (and is referenced by every fused build) — sanity check the pin.
  const sentinelHeader = path.join(checkoutDir, "src", "omnivoice.h");
  if (!fs.existsSync(sentinelHeader)) {
    throw new Error(
      `[omnivoice-fuse] omnivoice pin ${head} is missing src/omnivoice.h; refusing to graft an unknown layout`,
    );
  }

  // Stage the merged tree under <llamaCppRoot>/omnivoice/.
  const graftRoot = path.join(llamaCppRoot, OMNIVOICE_GRAFT_SUBDIR);
  // If a previous run left an aborted graft behind, blow it away. The
  // git checkout itself remains untouched — we only own the graft
  // subdirectory.
  fs.rmSync(graftRoot, { recursive: true, force: true });
  fs.mkdirSync(graftRoot, { recursive: true });

  for (const subdir of ["src", "tools"]) {
    copyDirRecursive(
      path.join(checkoutDir, subdir),
      path.join(graftRoot, subdir),
    );
  }

  // examples/ is data-only (audio prompts, sample text). Copy on a
  // best-effort basis — the build does not depend on these files. We
  // include them so a developer running llama-omnivoice-server locally
  // has the same demo asset paths the omnivoice CLI tools document.
  const examplesSrc = path.join(checkoutDir, "examples");
  if (fs.existsSync(examplesSrc)) {
    copyDirRecursive(examplesSrc, path.join(graftRoot, "examples"));
  }

  // Hard guarantee: we did NOT bring omnivoice's ggml/ along. The
  // README's "graft, not submodule swap" strategy depends on this.
  const strayGgml = path.join(graftRoot, "ggml");
  if (fs.existsSync(strayGgml)) {
    throw new Error(
      `[omnivoice-fuse] graft staging produced a stray ${strayGgml} — refusing to continue (would create two ggml trees)`,
    );
  }

  // Apply any reconciliation patches keyed to specific drifts.
  const patchesDir = new URL("./patches/", import.meta.url).pathname;
  const appliedPatches = applyPatches({ patchesDir, llamaCppRoot });

  // Count source files actually grafted, for the manifest.
  let sourceCount = 0;
  const stack = [graftRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(c|cc|cpp|cxx|h|hpp)$/.test(entry.name)) {
        sourceCount += 1;
      }
    }
  }

  return {
    commit: head,
    ref: omnivoiceRef,
    ggmlSubmoduleCommit,
    graftRoot,
    sourceCount,
    appliedPatches,
  };
}
