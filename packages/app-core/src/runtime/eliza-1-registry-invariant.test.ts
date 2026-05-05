/**
 * Cross-language drift guard for the eliza-1 size table.
 *
 * The Python training pipeline
 * (`eliza/packages/training/scripts/training/model_registry.py`) is the
 * source of truth for which Qwen base trains into which `elizaos/...` repo.
 * This file's sibling `local-model-resolver.ts` mirrors the load-bearing
 * fields (baseRepoId, ggufRepoId) at TypeScript runtime. If the two drift
 * the runtime will happily download a model that wasn't trained.
 *
 * This test spawns the Python registry (via `uv run python`), serializes it
 * as JSON, and asserts that every eliza-1 size present on both sides agrees
 * on:
 *   - baseRepoId  ==  eliza_repo_id
 *   - ggufRepoId  ==  gguf_repo_id  (= `${eliza_repo_id}-gguf`)
 *
 * Skips (does not fail) when `uv` or the dump script is missing, so dev
 * boxes without the training extras still pass CI.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ELIZA_ONE_SIZES,
  type ElizaOneSize,
  SIZE_SPECS,
} from "./local-model-resolver";

interface PythonEntry {
  eliza_short_name: string;
  eliza_repo_id: string;
  gguf_repo_id: string;
  base_hf_id: string;
  tier: string;
  inference_max_context: number;
}

const ELIZA_ROOT = resolve(__dirname, "../../../..");
const TRAINING_DIR = resolve(ELIZA_ROOT, "packages/training");
const DUMP_SCRIPT = resolve(TRAINING_DIR, "scripts/dump_registry_json.py");

function findUv(): string | null {
  // PATH lookup — `uv` is normally on PATH when installed via the official
  // installer (~/.local/bin) or homebrew (/opt/homebrew/bin). We use `which`
  // / `where` so we don't have to hardcode a list of install prefixes.
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(cmd, ["uv"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0];
    return found || null;
  } catch {
    return null;
  }
}

const uvPath = findUv();
const dumpExists = existsSync(DUMP_SCRIPT);

const describeOrSkip = uvPath && dumpExists ? describe : describe.skip;

describeOrSkip("eliza-1 registry invariant (Python ↔ TypeScript)", () => {
  const stdout = execFileSync(
    uvPath!,
    ["run", "--quiet", "python", DUMP_SCRIPT],
    { cwd: TRAINING_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const pythonRegistry = JSON.parse(stdout) as Record<string, PythonEntry>;

  it("Python registry exposes the same three sizes as TypeScript", () => {
    const pythonSizes = Object.keys(pythonRegistry).sort();
    const tsSizes = [...ELIZA_ONE_SIZES].sort();
    expect(pythonSizes).toEqual(tsSizes);
  });

  for (const size of ELIZA_ONE_SIZES) {
    describe(size, () => {
      const tsSpec = SIZE_SPECS[size];
      const pyEntry = pythonRegistry[size];

      it("Python entry exists for this size", () => {
        expect(pyEntry, `missing Python entry for ${size}`).toBeTruthy();
      });

      it("baseRepoId matches eliza_repo_id", () => {
        expect(tsSpec.baseRepoId).toBe(pyEntry?.eliza_repo_id);
      });

      it("ggufRepoId matches gguf_repo_id (= `${eliza_repo_id}-gguf`)", () => {
        expect(tsSpec.ggufRepoId).toBe(pyEntry?.gguf_repo_id);
      });

      it("ggufFile starts with the size short name", () => {
        // Sanity check — the GGUF filename embeds the size and should match
        // the published artifact under ggufRepoId. Keeps the Q4_K_M filename
        // from drifting away from the size name.
        expect(tsSpec.ggufFile.startsWith(`${size}-`)).toBe(true);
      });
    });
  }
});

// Always-on smoke test so the file shows up in test output even when uv is
// missing — gives reviewers a clear "skipped why" signal.
describe("eliza-1 registry invariant: environment", () => {
  it("reports whether uv + dump script were available", () => {
    expect(typeof uvPath === "string" || uvPath === null).toBe(true);
    expect(typeof dumpExists).toBe("boolean");
  });
});
