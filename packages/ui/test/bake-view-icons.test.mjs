/**
 * Contract tests for scripts/bake-view-icons.mjs: the bake must refuse to run
 * when its source icon directory is missing or empty, because it deletes the
 * committed icon assets before writing the new set. Real harness: each case
 * copies the actual script into a temp package mirror and executes it as a
 * subprocess, so path resolution and the destructive rewrite are exercised for
 * real — against sandboxed assets, never the repository copies. Deterministic;
 * no network. The harness removes PATH from the subprocess environment so the
 * script's best-effort Biome pass fails immediately and is not under test.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const realScript = join(here, "..", "scripts", "bake-view-icons.mjs");

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop(), { force: true, recursive: true });
  }
});

/** Build a temp mirror of the package layout the script resolves against. */
function makeMirror() {
  const root = mkdtempSync(join(tmpdir(), "bake-view-icons-"));
  cleanups.push(root);
  const scriptsDir = join(root, "pkg", "scripts");
  const viewsDir = join(root, "pkg", "src", "components", "views");
  const assetDir = join(viewsDir, "view-icons");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(assetDir, { recursive: true });
  cpSync(realScript, join(scriptsDir, "bake-view-icons.mjs"));
  // Committed-state stand-ins the script must not destroy on refusal.
  writeFileSync(join(assetDir, "chat.png"), "png-bytes-chat");
  writeFileSync(join(assetDir, "default.png"), "png-bytes-default");
  writeFileSync(
    join(viewsDir, "view-icons.generated.ts"),
    "export const VIEW_ICONS = { committed: true };\n",
  );
  return {
    script: join(scriptsDir, "bake-view-icons.mjs"),
    assetDir,
    generated: join(viewsDir, "view-icons.generated.ts"),
  };
}

function runBake(script, args) {
  // The production script formats its output through a best-effort `bunx`
  // subprocess. Keep this contract test offline and independent of the host's
  // global tools/cache: process.execPath is absolute, while an empty PATH makes
  // the optional formatter fail immediately on every platform.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  env.PATH = "";
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // error-policy:J3 — subprocess failure is the observable contract under
    // test; capture its exit status and stderr as an explicit result.
    return {
      status: error.status ?? -1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

describe("bake-view-icons fail-closed contract", () => {
  it("refuses when the source directory does not exist and leaves committed assets untouched", () => {
    const mirror = makeMirror();
    const missing = join(dirname(mirror.assetDir), "no-such-source-dir");
    const result = runBake(mirror.script, [missing]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not exist");
    expect(result.stderr).toContain("gen-view-icons.mjs");
    expect(readdirSync(mirror.assetDir).sort()).toEqual([
      "chat.png",
      "default.png",
    ]);
    expect(readFileSync(mirror.generated, "utf8")).toContain("committed: true");
  });

  it("refuses when the source directory exists but holds no .png files", () => {
    const mirror = makeMirror();
    const empty = join(dirname(mirror.assetDir), "empty-source");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, "notes.txt"), "not an icon");
    const result = runBake(mirror.script, [empty]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no .png files");
    expect(readdirSync(mirror.assetDir).sort()).toEqual([
      "chat.png",
      "default.png",
    ]);
    expect(readFileSync(mirror.generated, "utf8")).toContain("committed: true");
  });

  it("bakes a populated source directory, replacing the committed set", () => {
    const mirror = makeMirror();
    const source = join(dirname(mirror.assetDir), "fresh-icons");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "alpha.png"), "png-bytes-alpha");
    writeFileSync(join(source, "beta.png"), "png-bytes-beta");
    const result = runBake(mirror.script, [source]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("packaged 2 icons");
    expect(readdirSync(mirror.assetDir).sort()).toEqual([
      "alpha.png",
      "beta.png",
    ]);
    // Assert via the asset URL paths: the script's trailing best-effort Biome
    // pass may reformat key quoting when a global bunx is on PATH.
    const generated = readFileSync(mirror.generated, "utf8");
    expect(generated).toContain("./view-icons/alpha.png");
    expect(generated).toContain("./view-icons/beta.png");
    expect(existsSync(join(mirror.assetDir, "chat.png"))).toBe(false);
  });
});
