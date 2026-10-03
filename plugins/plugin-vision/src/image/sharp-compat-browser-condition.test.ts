/**
 * Pins the browser/JSC capability boundary of the pure-JS image fallback with
 * the real module resolver. Under Bun's `browser` condition jimp publishes an
 * intentionally empty module, so `createJimpShim` must reject with the explicit
 * unsupported-capability error instead of offering a backend that cannot decode
 * or encode; under default conditions the same module must round-trip a real
 * PNG through the installed jimp. Both cases run in a pinned-Bun subprocess
 * because module resolution conditions cannot change in-process.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Resolve the pinned Bun the test lane runs under: `bun run` supplies it
 * through npm_execpath even when its directory is absent from PATH, with a PATH
 * fallback for direct callers.
 */
function resolveBunExecutable(): string | null {
  const configured = process.env.npm_execpath ?? "";
  if (configured && path.basename(configured).toLowerCase() === "bun") {
    return configured;
  }
  const executable = process.platform === "win32" ? "bun.exe" : "bun";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sharpCompatPath = path.join(here, "sharp-compat.ts");

const fixtureDir = mkdtempSync(path.join(tmpdir(), "eliza-jimp-boundary-"));
const driverPath = path.join(fixtureDir, "driver.mjs");

writeFileSync(
  driverPath,
  `const [modulePath] = process.argv.slice(2);
const { createJimpShim } = await import(modulePath);
const outcome = {};
try {
  const factory = createJimpShim();
  // Round-trip an encoded PNG through the jimp-backed fallback so the
  // default-condition case proves real decoding, not just construction.
  const encoded = await factory(Buffer.from([10, 20, 30, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  const meta = await factory(encoded).metadata();
  outcome.png_signature =
    encoded.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  outcome.decoded = meta.width === 1 && meta.height === 1;
} catch (error) {
  outcome.error = error instanceof Error ? error.message : String(error);
}
console.log("JIMP_BOUNDARY " + JSON.stringify(outcome));
`,
);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function runDriver(leadingArgs: string[]): Record<string, unknown> {
  const bunExecutable = resolveBunExecutable();
  expect(bunExecutable, "Bun executable must be resolvable").not.toBeNull();
  if (!bunExecutable) throw new Error("unreachable");
  const result = spawnSync(
    bunExecutable,
    [...leadingArgs, driverPath, sharpCompatPath],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const marker = "JIMP_BOUNDARY ";
  const line = result.stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(marker));
  if (!line) {
    throw new Error(`missing ${marker.trim()} output in: ${result.stdout}`);
  }
  return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
}

describe("pure-JS image fallback boundary", () => {
  it("decodes a real PNG through the installed jimp under default conditions", () => {
    const outcome = runDriver([]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.png_signature).toBe(true);
    expect(outcome.decoded).toBe(true);
  });

  it("rejects with the explicit unsupported-capability error under the browser condition", () => {
    const outcome = runDriver(["--conditions=browser"]);
    expect(outcome.error).toContain("no image backend is available");
  });
});
