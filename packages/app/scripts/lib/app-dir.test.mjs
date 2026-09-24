import { spawnSync } from "node:child_process";
/** Resolves real package layouts and fails before creating phantom package paths. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveMainAppDir } from "./app-dir.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "app-dir-"));
  roots.push(root);
  return root;
}
function manifest(root, relative) {
  const dir = path.join(root, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  return dir;
}
it("requires an existing app instead of guessing a dead package", () => {
  const root = fixture();
  expect(() => resolveMainAppDir(root)).toThrow("App package not found");
});
it("finds the flat package and respects outer consumer ownership", () => {
  const root = fixture();
  const flat = manifest(root, "packages/app");
  expect(resolveMainAppDir(root)).toBe(flat);
  manifest(root, "eliza");
  manifest(root, "eliza/packages/app");
  const consumer = manifest(root, "apps/app");
  expect(resolveMainAppDir(root)).toBe(consumer);
});
it("resolves an explicitly named existing consumer app", () => {
  const root = fixture();
  const named = manifest(root, "apps/brand");
  expect(resolveMainAppDir(root, "brand")).toBe(named);
  expect(() => resolveMainAppDir(root, "absent")).toThrow(
    "App package not found",
  );
});
it.each(["", ".", "..", "../outside", "a/b", "a\\b"])(
  "rejects package traversal %s",
  (name) => {
    expect(() => resolveMainAppDir(fixture(), name)).toThrow(
      "Invalid app package name",
    );
  },
);

it("preflights all release manifests and leaves Electrobun source unchanged", () => {
  const root = fixture();
  manifest(root, ".");
  manifest(root, "packages/app");
  const platform = manifest(root, "packages/app/platforms/electrobun");
  const config = path.join(platform, "electrobun.config.ts");
  const source =
    "export default { app: { version: resolveDesktopAppVersion() } };\n";
  writeFileSync(config, source);
  const script = fileURLToPath(
    new URL("../align-electrobun-version.mjs", import.meta.url),
  );
  const run = () =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, RELEASE_VERSION: "2.0.4-beta.1" },
      encoding: "utf8",
      timeout: 10000,
    });
  writeFileSync(path.join(platform, "package.json"), "{broken");
  expect(run().status).not.toBe(0);
  expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe("{}");
  writeFileSync(path.join(platform, "package.json"), "{}");
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  for (const dir of [root, path.join(root, "packages/app"), platform]) {
    expect(
      JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version,
    ).toBe("2.0.4-beta.1");
  }
  expect(readFileSync(config, "utf8")).toBe(source);
});
