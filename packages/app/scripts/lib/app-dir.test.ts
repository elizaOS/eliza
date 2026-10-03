import { spawnSync } from "node:child_process";
/** Resolves real package layouts and fails before creating phantom package paths. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveMainAppDir } from "./app-dir.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "app-dir-"));
  roots.push(root);
  return root;
}
function manifest(root: string, relative: string) {
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
    new URL("../align-electrobun-version.ts", import.meta.url),
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

it("loads canonical workspace errors before package installation", () => {
  const root = fixture();
  const helperDir = path.join(root, "packages/app/scripts/lib");
  const coreDir = path.join(root, "packages/core/src");
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  copyFileSync(
    new URL("./eliza-error.ts", import.meta.url),
    path.join(helperDir, "eliza-error.ts"),
  );
  copyFileSync(
    new URL("../../../core/src/errors.ts", import.meta.url),
    path.join(coreDir, "errors.ts"),
  );
  const probe = path.join(root, "probe.ts");
  writeFileSync(
    probe,
    `
    import { ElizaError } from "./packages/app/scripts/lib/eliza-error.ts";
    import { ElizaError as Canonical } from "./packages/core/src/errors.ts";
    if (ElizaError !== Canonical) throw new Error("Wrong error identity");
    if (new ElizaError("fixture", { code: "FIXTURE" }).code !== "FIXTURE") throw new Error("Lost code");
  `,
  );
  const result = spawnSync(process.execPath, [probe], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
});

it.each(["eliza/packages/app", "packages/app"])(
  "creates Capacitor projects in the consumer app when scripts live in %s",
  (scriptPackage) => {
    const root = fixture();
    manifest(root, ".");
    manifest(root, "eliza");
    const consumer = manifest(root, "apps/app");
    const installed = manifest(root, scriptPackage);
    const scripts = path.join(installed, "scripts");
    mkdirSync(path.join(scripts, "lib"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts/run-eliza-app-script.ts"), "");
    copyFileSync(
      new URL("../ensure-capacitor-platform.ts", import.meta.url),
      path.join(scripts, "ensure-capacitor-platform.ts"),
    );
    for (const name of [
      "app-dir.ts",
      "repo-root.ts",
      "capacitor-platform-templates.ts",
    ]) {
      copyFileSync(
        new URL(name, import.meta.url),
        path.join(scripts, "lib", name),
      );
    }
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "bunx"),
      `#!/bin/sh
[ "$1 $2 $3" = "cap add ios" ] || exit 2
pwd > "$CAP_FIXTURE_CWD"
mkdir -p ios/App/App.xcodeproj
: > ios/App/Podfile
: > ios/App/App.xcodeproj/project.pbxproj
`,
      { mode: 0o755 },
    );
    const receipt = path.join(root, "cwd");
    const result = spawnSync(
      process.execPath,
      [path.join(scripts, "ensure-capacitor-platform.ts"), "ios"],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:/usr/bin:/bin`,
          CAP_FIXTURE_CWD: receipt,
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(realpathSync(readFileSync(receipt, "utf8").trim())).toBe(
      realpathSync(consumer),
    );
    expect(existsSync(path.join(consumer, "ios/App/Podfile"))).toBe(true);
    expect(existsSync(path.join(installed, "ios"))).toBe(false);
  },
);
