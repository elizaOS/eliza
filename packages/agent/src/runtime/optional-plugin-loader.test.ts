/** Exercises the actual optional importer against isolated source wrappers and the built provider. */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const loaderPath = fileURLToPath(
  new URL("./optional-plugin-loader.ts", import.meta.url),
);
const agentRoot = path.resolve(path.dirname(loaderPath), "../..");
let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "optional-source-loader-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writePackage(
  name = "plugin-openai",
  declaration: Record<string, string | false> | false = {
    ".": "./index.node.ts",
  },
): string {
  const packageRoot = path.join(fixtureRoot, "plugins", name);
  mkdirSync(path.join(packageRoot, "models"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: `@elizaos/${name}`,
      type: "module",
      exports: { ".": "./dist/index.node.js" },
      files: ["dist"],
      elizaos: { plugin: { workspaceSource: declaration } },
    }),
  );
  writeFileSync(
    path.join(packageRoot, "models/text.ts"),
    'export const version = "edited-model";\n',
  );
  writeFileSync(
    path.join(packageRoot, "index.ts"),
    'export const marker = "unwrapped-source";\n',
  );
  writeFileSync(
    path.join(packageRoot, "index.node.ts"),
    'import { version } from "./models/text.ts"; export const marker = "node-wrapper:" + version;\n',
  );
  return packageRoot;
}

function runLoader(
  packageName = "@elizaos/plugin-openai",
  options: { source?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(
    "bun",
    [
      "--no-install",
      ...(options.source === false ? [] : ["--conditions=eliza-source"]),
      "-e",
      `import { loadOptionalPlugin } from ${JSON.stringify(loaderPath)};
       const mod = await loadOptionalPlugin(${JSON.stringify(packageName)}, ${JSON.stringify(path.join(fixtureRoot, "packages/agent/src/runtime"))});
       console.log(JSON.stringify({ marker: mod?.marker ?? null, providerName: mod?.default?.name ?? null }));`,
    ],
    {
      cwd: agentRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_ENV: "development",
        ELIZA_BUILD_VARIANT: "development",
        ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES: "0",
        ELIZA_ALLOW_WORKSPACE_PLUGIN_SRC: "0",
        ...options.env,
      },
    },
  );
}

describe("optional workspace source loading", () => {
  it("loads the declared Node wrapper and its edited model before the built provider", () => {
    writePackage();
    const loaded = runLoader();
    expect(loaded.error).toBeUndefined();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"node-wrapper:edited-model"');
  });

  it.each([
    { label: "without source mode", source: false, env: {} },
    {
      label: "with the kill switch",
      env: { ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES: "1" },
    },
    { label: "in NODE_ENV production", env: { NODE_ENV: "production" } },
    {
      label: "in a production build",
      env: { ELIZA_BUILD_VARIANT: "production" },
    },
  ])(
    "keeps the built provider $label despite invalid workspace-only metadata",
    (options) => {
      writePackage("plugin-openai", { ".": "../../do-not-import.ts" });
      const loaded = runLoader("@elizaos/plugin-openai", options);
      expect(loaded.error).toBeUndefined();
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toContain('"providerName":"openai"');
      expect(loaded.stdout).toContain('"marker":null');
    },
  );

  it("retains the explicit production debugging opt-in", () => {
    writePackage();
    const loaded = runLoader("@elizaos/plugin-openai", {
      env: { NODE_ENV: "production", ELIZA_ALLOW_WORKSPACE_PLUGIN_SRC: "1" },
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"node-wrapper:edited-model"');
  });

  it.each([false, { ".": false }] as const)(
    "honors explicit source disabling: %j",
    (declaration) => {
      const packageRoot = writePackage("plugin-openai", declaration);
      mkdirSync(path.join(packageRoot, "src"));
      writeFileSync(
        path.join(packageRoot, "src/index.ts"),
        'throw new Error("disabled source executed");\n',
      );
      const loaded = runLoader();
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toContain('"providerName":"openai"');
    },
  );

  it.each([
    { entry: "./missing.ts", message: "declared entry is missing" },
    { entry: "../../outside.ts", message: "not package-local source" },
    { entry: "./dist/index.node.js", message: "not package-local source" },
  ])(
    "rejects invalid explicit source $entry without selecting the built provider",
    ({ entry, message }) => {
      writePackage("plugin-openai", { ".": entry });
      writeFileSync(
        path.join(fixtureRoot, "outside.ts"),
        'throw new Error("outside source executed");\n',
      );
      const loaded = runLoader();
      expect(loaded.status).not.toBe(0);
      expect(loaded.stderr).toContain(message);
      expect(loaded.stdout).not.toContain('"providerName":"openai"');
      expect(loaded.stderr).not.toContain("outside source executed");
    },
  );

  it("rejects a declared file symlink escaping the package", () => {
    const packageRoot = writePackage("plugin-openai", { ".": "./escaped.ts" });
    const outside = path.join(fixtureRoot, "outside.ts");
    writeFileSync(outside, 'throw new Error("outside source executed");\n');
    symlinkSync(outside, path.join(packageRoot, "escaped.ts"));
    const loaded = runLoader();
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain("entry resolves outside package source");
    expect(loaded.stderr).not.toContain("outside source executed");
  });

  it("preserves the runtime ./plugin override instead of loading the root barrel", () => {
    const packageRoot = writePackage("plugin-calendar", {
      ".": "./index.node.ts",
      "./plugin": "./runtime.node.ts",
    });
    writeFileSync(
      path.join(packageRoot, "index.node.ts"),
      'throw new Error("view barrel executed");\n',
    );
    writeFileSync(
      path.join(packageRoot, "runtime.node.ts"),
      'export const marker = "runtime-plugin";\n',
    );
    const loaded = runLoader("@elizaos/plugin-calendar");
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"runtime-plugin"');
  });

  it("keeps existing flat eliza-source export declarations authoritative", () => {
    const packageRoot = writePackage();
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-openai",
        type: "module",
        exports: {
          ".": {
            "eliza-source": {
              import: "./index.node.ts",
              default: "./index.node.ts",
            },
            default: "./dist/index.node.js",
          },
        },
      }),
    );
    const loaded = runLoader();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"node-wrapper:edited-model"');
  });

  it("uses the Node source condition without importing a browser wrapper or generic barrel", () => {
    const packageRoot = writePackage();
    writeFileSync(
      path.join(packageRoot, "index.browser.ts"),
      'throw new Error("browser wrapper executed");\n',
    );
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-openai",
        type: "module",
        exports: {
          ".": {
            "eliza-source": {
              browser: "./index.browser.ts",
              node: { import: "./index.node.ts", default: "./index.node.ts" },
              default: "./index.ts",
            },
            default: "./dist/index.node.js",
          },
        },
      }),
    );
    const loaded = runLoader();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"node-wrapper:edited-model"');
  });

  it("rejects a missing selected Node wrapper instead of switching to the generic barrel", () => {
    const packageRoot = writePackage();
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-openai",
        type: "module",
        exports: {
          ".": {
            "eliza-source": {
              node: { import: "./missing-node.ts" },
              default: "./index.ts",
            },
            default: "./dist/index.node.js",
          },
        },
      }),
    );
    const loaded = runLoader();
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain("declared entry is missing");
    expect(loaded.stdout).not.toContain("unwrapped-source");
  });

  it("retains conventional src entry discovery when no declaration is present", () => {
    const packageRoot = writePackage("plugin-openai", {});
    mkdirSync(path.join(packageRoot, "src"));
    writeFileSync(
      path.join(packageRoot, "src/index.ts"),
      'export const marker = "conventional-source";\n',
    );
    const loaded = runLoader();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"marker":"conventional-source"');
  });

  it("does not interpret installed/default package metadata when workspace source is absent", () => {
    const loaded = runLoader();
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(loaded.stdout).toContain('"providerName":"openai"');
  });
});
