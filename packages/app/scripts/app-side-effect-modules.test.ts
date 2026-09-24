/** Executes generated registration loaders through native Node against real temporary packages. */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appSideEffectModulesPlugin,
  discoverSideEffectAppModules,
} from "../vite/app-side-effect-modules.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(registration: unknown, source: string) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "app-root-registration-"),
  );
  directories.push(directory);
  const root = path.join(directory, "plugins");
  const plugin = path.join(root, "plugin-fixture");
  mkdirSync(path.join(plugin, "src"), { recursive: true });
  writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "fixture-app-registration",
      type: "module",
      exports: { ".": "./src/index.ts" },
      elizaos: { appRegister: registration },
    }),
  );
  writeFileSync(path.join(plugin, "src/index.ts"), source);
  mkdirSync(path.join(directory, "node_modules"));
  symlinkSync(
    plugin,
    path.join(directory, "node_modules/fixture-app-registration"),
    "dir",
  );
  const generated = appSideEffectModulesPlugin([root]).transform(
    "export const loaders = /* @__ELIZA_APP_REGISTER_LOADERS__ */ [];",
    path.join(directory, "src/plugin-registrations.ts"),
  );
  if (!generated) throw new Error("Registration transform did not run");
  const output = path.join(directory, "registration.mjs");
  writeFileSync(output, generated.code);
  return { directory, root, output };
}

describe("root app registration", () => {
  it("calls the named root export only when the generated loader runs", () => {
    const { directory } = fixture(
      { export: "registerApp" },
      `
      import { appendFileSync } from 'node:fs';
      export function registerApp() { appendFileSync(new URL('./receipt', import.meta.url), 'registered'); }
    `,
    );
    const runner = path.join(directory, "runner.mjs");
    writeFileSync(
      runner,
      `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { loaders } from './registration.mjs';
      const receipt = new URL('./plugins/plugin-fixture/src/receipt', import.meta.url);
      assert.equal(existsSync(receipt), false);
      await loaders[0].load();
      assert.equal(existsSync(receipt), true);
    `,
    );
    execFileSync(process.execPath, [runner], { encoding: "utf8" });
    expect(
      readFileSync(
        path.join(directory, "plugins/plugin-fixture/src/receipt"),
        "utf8",
      ),
    ).toBe("registered");
  });

  it("rejects a declared export that cannot register the app", () => {
    const { directory } = fixture(
      { export: "registerApp" },
      "export const registerApp = 42;",
    );
    const runner = path.join(directory, "runner.mjs");
    writeFileSync(
      runner,
      `
      import assert from 'node:assert/strict';
      import { loaders } from './registration.mjs';
      await assert.rejects(loaders[0].load(), /must export callable registerApp/);
    `,
    );
    expect(() =>
      execFileSync(process.execPath, [runner], { encoding: "utf8" }),
    ).not.toThrow();
  });

  it("rejects invalid declarations before generating JavaScript", () => {
    expect(() => fixture({ export: "register();" }, "")).toThrow(
      /must name a root export/,
    );
  });

  it("fails on malformed manifests instead of silently omitting an app", () => {
    const { root } = fixture(
      { export: "registerApp" },
      "export function registerApp() {}",
    );
    writeFileSync(path.join(root, "plugin-fixture/package.json"), "{");
    expect(() => discoverSideEffectAppModules([root])).toThrow(
      /Invalid app plugin manifest/,
    );
  });
});
