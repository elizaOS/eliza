/**
 * Unit tests for the Verify Chunk Safety app shell contract and coverage
 * guardrail.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The gate script reads `${cwd}/dist/assets/*.js` and exits non-zero when the
// bn.js crypto marker (`toArrayLike`) lands in a chunk that is NOT one of the
// lazy `vendor-(crypto|solana|wallet)-` chunks. We exercise it as a subprocess
// against synthetic `dist/assets` fixtures so the regression guard is itself
// tested — the #9150 fold (crypto graph folded into the eager date-fns `en_US`
// locale chunk) MUST fail the gate, and a clean lazy layout MUST pass.

const GATE_SCRIPT = join(
  import.meta.dirname,
  "..",
  "scripts",
  "verify-chunk-safety.mjs",
);

const CRYPTO_MARKER = "toArrayLike";

let workDir: string;

function writeChunk(name: string, contents: string): void {
  writeFileSync(join(workDir, "dist", "assets", name), contents, "utf8");
}

function runGate(): { status: number; output: string } {
  try {
    const stdout = execFileSync("node", [GATE_SCRIPT], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "chunk-safety-"));
  mkdirSync(join(workDir, "dist", "assets"), { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("verify-chunk-safety gate", () => {
  it("FAILS when the bn.js crypto graph leaks into an eager locale chunk (#9150)", () => {
    // Reproduces the real regression: the crypto marker folded into the eager
    // date-fns `en_US` i18n locale chunk instead of a lazy vendor chunk.
    writeChunk(
      "en_US-SK3WV2N3-B4WdXTLq.js",
      `function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeChunk("index-BEExhTUo.js", "export const ok = 1;");

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("FAIL");
    expect(output).toContain("en_US-SK3WV2N3-B4WdXTLq.js");
  });

  it("FAILS when the crypto graph leaks into the eager entry chunk", () => {
    writeChunk("index-BEExhTUo.js", `function bn(){return ${CRYPTO_MARKER}}`);

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("index-BEExhTUo.js");
  });

  it("PASSES when the crypto graph is confined to a lazy vendor-crypto chunk", () => {
    writeChunk(
      "vendor-crypto-DRnRpPYP.js",
      `function bn(){return ${CRYPTO_MARKER}}`,
    );
    writeChunk("en_US-SK3WV2N3-g943u0fV.js", "export const locale = {};");
    writeChunk("index-D9yqvBmw.js", "export const app = 1;");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("OK");
  });

  it("PASSES when the crypto marker is absent entirely", () => {
    writeChunk("index-D9yqvBmw.js", "export const app = 1;");

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("OK");
  });
});
