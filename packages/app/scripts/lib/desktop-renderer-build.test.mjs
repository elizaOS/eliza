import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDesktopRenderer } from "./desktop-renderer-build.mjs";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(appDir, "package.json"));
const pinnedManifest = require.resolve("@elizaos/vitest-vite/package.json");
const pinnedCli = path.join(path.dirname(pinnedManifest), "bin", "vite.js");

test("desktop resolves the actual build:web Vite owner and runs both output gates", () => {
  const calls = [];
  const env = { ELIZA_BUILD_VARIANT: "direct" };
  buildDesktopRenderer({
    appDir,
    env,
    label: "fixture",
    runBun: (...args) => calls.push(args),
  });
  assert.deepEqual(
    calls.map(([args]) => args),
    [
      [pinnedCli, "build"],
      [path.join(appDir, "scripts", "verify-chunk-safety.ts")],
      [path.join(appDir, "scripts", "verify-viewport-meta.ts")],
    ],
  );
  for (const [, options] of calls) {
    assert.equal(options.cwd, appDir);
    assert.equal(options.env, env);
  }
  const actual = spawnSync("bun", [pinnedCli, "--version"], {
    cwd: appDir,
    encoding: "utf8",
  });
  assert.equal(actual.status, 0, actual.stderr);
  assert(actual.stdout.includes(`vite/${require(pinnedManifest).version}`));
});

for (const failAt of [0, 1, 2]) {
  test(`renderer failure at step ${failAt} prevents subsequent staging steps`, () => {
    const calls = [];
    assert.throws(
      () =>
        buildDesktopRenderer({
          appDir,
          runBun: (args) => {
            calls.push(args);
            if (calls.length === failAt + 1) throw new Error("fixture failure");
          },
        }),
      /fixture failure/,
    );
    assert.equal(calls.length, failAt + 1);
  });
}
