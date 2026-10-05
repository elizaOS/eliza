import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createConsumerSourceResolver } from "./consumer-source-resolver.mjs";

test("external consumers resolve public source exports without admitting private or escaped files", () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-source-consumer-")),
  );
  try {
    const pkg = path.join(root, "packages/core");
    fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "plugins"));
    fs.writeFileSync(path.join(pkg, "src/index.ts"), "export const value = 1;");
    fs.writeFileSync(
      path.join(pkg, "src/public.ts"),
      "export const value = 2;",
    );
    fs.writeFileSync(path.join(root, "outside.ts"), "");
    fs.symlinkSync(
      path.join(root, "outside.ts"),
      path.join(pkg, "src/escape.ts"),
    );
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        exports: {
          ".": { "eliza-source": "./src/index.ts", default: "./dist/index.js" },
          "./*": "./src/*.ts",
          "./private": null,
          "./blocked/*": null,
          "./outside": "../../outside.ts",
          "./compiled": "./dist/index.js",
        },
      }),
    );
    const { plugin, resolvedSources } = createConsumerSourceResolver({
      sourceRoot: root,
    });
    const handlers = [];
    plugin.setup({ onResolve: (_filter, handler) => handlers.push(handler) });
    const resolve = (name) => handlers[0]({ path: name });
    assert.equal(resolve("@elizaos/core").path, path.join(pkg, "src/index.ts"));
    assert.equal(
      resolve("@elizaos/core/public").path,
      path.join(pkg, "src/public.ts"),
    );
    for (const name of [
      "private",
      "blocked/nested",
      "outside",
      "compiled",
      "escape",
    ])
      assert.throws(() => resolve(`@elizaos/core/${name}`));
    assert.throws(() => resolve("@elizaos/missing"));
    assert.deepEqual(
      handlers[1]({ path: "zod", importer: path.join(pkg, "src/index.ts") }),
      { path: "zod", external: true },
    );
    assert.equal(
      handlers[1]({
        path: "node:fs",
        importer: path.join(pkg, "src/index.ts"),
      }),
      undefined,
    );
    assert.equal(
      resolvedSources.get("@elizaos/core"),
      "packages/core/src/index.ts",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a checkout under a directory named dist still resolves source exports", () => {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "eliza-source-consumer-")),
  );
  try {
    const root = path.join(parent, "dist", "eliza");
    const pkg = path.join(root, "packages/core");
    fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "plugins"));
    fs.writeFileSync(path.join(pkg, "src/index.ts"), "export const value = 1;");
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@elizaos/core",
        exports: {
          ".": { "eliza-source": "./src/index.ts", default: "./dist/index.js" },
          "./compiled": "./dist/index.js",
        },
      }),
    );
    const { plugin } = createConsumerSourceResolver({ sourceRoot: root });
    const handlers = [];
    plugin.setup({ onResolve: (_filter, handler) => handlers.push(handler) });
    const resolve = (name) => handlers[0]({ path: name });
    assert.equal(resolve("@elizaos/core").path, path.join(pkg, "src/index.ts"));
    assert.throws(() => resolve("@elizaos/core/compiled"));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
