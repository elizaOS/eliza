/**
 * Exercises AST-derived first-party view discovery, deterministic artifacts,
 * and collision failures against synthetic manifests and the real repository.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePluginViewInventoryArgs } from "../audit-plugin-view-inventory.mjs";
import {
  discoverPluginViewInventory,
  renderPluginViewInventoryMarkdown,
  serializePluginViewInventory,
} from "../lib/plugin-view-inventory.mjs";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-view-inventory-"));
  tempDirectories.push(root);
  return root;
}

function write(root: string, file: string, contents: string) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function addBuiltin(root: string, declaration = view("builtin", "/builtin")) {
  const source = "packages/agent/src/api/builtin-views.ts";
  write(root, source, `export const BUILTIN_VIEWS = [${declaration}];\n`);
  return source;
}

function addPlugin(
  root: string,
  name: string,
  declaration: string,
  extraSource = "",
) {
  const directory = `plugins/${name}`;
  write(
    root,
    `${directory}/package.json`,
    `${JSON.stringify({ name: `@fixture/${name}`, source: "./src/plugin.ts" })}\n`,
  );
  const source = `${directory}/src/plugin.ts`;
  write(
    root,
    source,
    `${extraSource}\nexport const plugin: Plugin = { name: "${name}", description: "fixture", views: [${declaration}] };\n`,
  );
  return source;
}

function addPluginSource(root: string, name: string, contents: string) {
  const directory = `plugins/${name}`;
  write(
    root,
    `${directory}/package.json`,
    `${JSON.stringify({ name: `@fixture/${name}`, source: "./src/plugin.ts" })}\n`,
  );
  const source = `${directory}/src/plugin.ts`;
  write(root, source, contents);
  return source;
}

function view(id: string, route = `/${id}`, modalities = '["gui"]') {
  return `{
    id: "${id}",
    label: "${id}",
    path: "${route}",
    modalities: ${modalities},
    bundlePath: "dist/views/bundle.js",
    componentExport: "FixtureView",
  }`;
}

function discover(root: string, files: string[]) {
  return discoverPluginViewInventory({
    repoRoot: root,
    files: [addBuiltin(root), ...files],
  });
}

describe("first-party runtime view inventory", () => {
  test("parses runtime sources and deterministically renders JSON and Markdown", () => {
    const root = makeRoot();
    const capabilitySource = "plugins/plugin-alpha/src/capabilities.ts";
    write(
      root,
      capabilitySource,
      'export const VIEW_OPERATIONS = [{ id: "refresh" }, { id: "open" }];\n',
    );
    const pluginSource = addPlugin(
      root,
      "plugin-alpha",
      `{
        id: "alpha",
        label: "Alpha",
        path: "/alpha",
        modalities: ["gui"],
        bundlePath: "dist/views/bundle.js",
        componentExport: "FixtureView",
        roleGate: { minRole: "OWNER" },
        surface: { capabilities: ["agent-surface"] },
        relatedActions: ["ALPHA"],
        capabilities: VIEW_OPERATIONS,
        developerOnly: true,
        visibleInManager: true,
      }`,
      'import { VIEW_OPERATIONS } from "./capabilities.js";',
    );
    const inventory = discover(root, [capabilitySource, pluginSource]);
    const serialized = serializePluginViewInventory(inventory);

    expect(serialized).toMatchObject({
      schemaVersion: 1,
      discoveredCount: 2,
      builtinCount: 1,
      pluginCount: 1,
      declarationSourceCount: 2,
    });
    expect(serialized.views[1]).toMatchObject({
      id: "alpha",
      owner: "@fixture/plugin-alpha",
      minRole: "OWNER",
      operationIds: ["refresh", "open"],
      relatedActions: ["ALPHA"],
      surfaceCapabilities: ["agent-surface"],
      developerOnly: true,
      visibleInManager: true,
    });
    const markdown = renderPluginViewInventoryMarkdown(serialized);
    expect(markdown).toContain("# First-party runtime view inventory");
    expect(markdown).toContain(
      "| @fixture/plugin-alpha | alpha | gui | /alpha |",
    );
    expect(markdown).toContain("refresh, open");
    expect(markdown).toBe(renderPluginViewInventoryMarkdown(serialized));
  });

  test("rejects duplicate id/modality and normalized path/modality pairs", () => {
    const idRoot = makeRoot();
    const idAlpha = addPlugin(idRoot, "plugin-alpha", view("shared", "/alpha"));
    const idBeta = addPlugin(idRoot, "plugin-beta", view("shared", "/beta"));
    expect(() => discover(idRoot, [idAlpha, idBeta])).toThrow(
      /duplicate id "shared" for gui/,
    );

    const pathRoot = makeRoot();
    const pathAlpha = addPlugin(
      pathRoot,
      "plugin-alpha",
      view("alpha", "/shared"),
    );
    const pathBeta = addPlugin(
      pathRoot,
      "plugin-beta",
      view("beta", "/SHARED/"),
    );
    expect(() => discover(pathRoot, [pathAlpha, pathBeta])).toThrow(
      /duplicate path "\/SHARED\/" for gui/,
    );
  });

  test("rejects repeated modalities within one declaration", () => {
    const root = makeRoot();
    const source = addPlugin(
      root,
      "plugin-alpha",
      view("alpha", "/alpha", '["gui", "gui"]'),
    );
    expect(() => discover(root, [source])).toThrow(/repeats modality gui/);
  });

  test("allows one id and path to serve distinct modalities", () => {
    const root = makeRoot();
    const alpha = addPlugin(
      root,
      "plugin-alpha",
      view("shared", "/shared", '["gui"]'),
    );
    const beta = addPlugin(
      root,
      "plugin-beta",
      view("shared", "/shared", '["xr"]'),
    );
    expect(discover(root, [alpha, beta]).views).toHaveLength(3);
  });

  test("rejects Plugin.views that cannot be statically audited", () => {
    const root = makeRoot();
    const directory = "plugins/plugin-dynamic";
    write(
      root,
      `${directory}/package.json`,
      '{"name":"@fixture/plugin-dynamic"}\n',
    );
    const source = `${directory}/src/plugin.ts`;
    write(
      root,
      source,
      'export const plugin: Plugin = { name: "dynamic", description: "fixture", views: createViews() };\n',
    );
    expect(() => discover(root, [source])).toThrow(
      /Plugin\.views must resolve to an array literal/,
    );
  });

  test("resolves shorthand and statically composed Plugin.views", () => {
    const shorthandRoot = makeRoot();
    const shorthand = addPluginSource(
      shorthandRoot,
      "plugin-shorthand",
      `const views = [${view("shorthand")}];
export const plugin: Plugin = { name: "shorthand", description: "fixture", views };\n`,
    );
    expect(discover(shorthandRoot, [shorthand]).views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "shorthand",
          owner: "@fixture/plugin-shorthand",
        }),
      ]),
    );

    const spreadRoot = makeRoot();
    const spread = addPluginSource(
      spreadRoot,
      "plugin-spread",
      `const base = { views: [${view("spread")}] };
export default { name: "spread", description: "fixture", ...base } satisfies Plugin;\n`,
    );
    expect(discover(spreadRoot, [spread]).views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "spread",
          owner: "@fixture/plugin-spread",
        }),
      ]),
    );
  });

  test("resolves statically computed Plugin.views and rejects dynamic keys", () => {
    const staticRoot = makeRoot();
    const staticSource = addPluginSource(
      staticRoot,
      "plugin-computed-key",
      `const viewKey = "views";
export const plugin: Plugin = {
  name: "computed-key",
  description: "fixture",
  [viewKey]: [${view("computed-key")}],
};\n`,
    );
    expect(discover(staticRoot, [staticSource]).views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "computed-key",
          owner: "@fixture/plugin-computed-key",
        }),
      ]),
    );

    const dynamicRoot = makeRoot();
    const dynamicSource = addPluginSource(
      dynamicRoot,
      "plugin-dynamic-key",
      `declare const viewKey: string;
export const plugin: Plugin = {
  name: "dynamic-key",
  description: "fixture",
  [viewKey]: [${view("dynamic-key")}],
};\n`,
    );
    expect(() => discover(dynamicRoot, [dynamicSource])).toThrow(
      /computed property name must resolve to a string literal/,
    );
  });

  test("inventories only the runtime plugin when a full-shaped helper is spread", () => {
    const explicitAfterRoot = makeRoot();
    const explicitAfter = addPluginSource(
      explicitAfterRoot,
      "plugin-explicit-after",
      `const basePlugin = {
  name: "base",
  description: "helper",
  views: [${view("base-before-override")}],
};
export default {
  ...basePlugin,
  name: "explicit-after",
  views: [${view("explicit-after")}],
} satisfies Plugin;\n`,
    );
    const explicitAfterInventory = discover(explicitAfterRoot, [explicitAfter]);
    expect(explicitAfterInventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "explicit-after",
    ]);
    expect(
      explicitAfterInventory.sources.filter(
        (source) => source.kind === "plugin-manifest",
      ),
    ).toHaveLength(1);

    const spreadAfterRoot = makeRoot();
    const spreadAfter = addPluginSource(
      spreadAfterRoot,
      "plugin-spread-after",
      `const basePlugin = {
  name: "spread-after",
  description: "helper",
  views: [${view("spread-after")}],
};
export default {
  name: "explicit-before",
  description: "fixture",
  views: [${view("explicit-before-spread")}],
  ...basePlugin,
} satisfies Plugin;\n`,
    );
    const spreadAfterInventory = discover(spreadAfterRoot, [spreadAfter]);
    expect(spreadAfterInventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "spread-after",
    ]);
    expect(
      spreadAfterInventory.sources.filter(
        (source) => source.kind === "plugin-manifest",
      ),
    ).toHaveLength(1);
  });

  test("does not inventory an unexported typed composition helper", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-typed-helper",
      `const basePlugin: Plugin = {
  name: "typed-helper",
  description: "helper",
  views: [${view("typed-helper")}],
};
export default {
  ...basePlugin,
  views: [${view("typed-runtime")}],
} satisfies Plugin;\n`,
    );
    const inventory = discover(root, [source]);
    expect(inventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "typed-runtime",
    ]);
    expect(
      inventory.sources.filter((entry) => entry.kind === "plugin-manifest"),
    ).toHaveLength(1);
  });

  test("fails closed on exported plugin declarations with dynamic initializers", () => {
    const factoryRoot = makeRoot();
    const factory = addPluginSource(
      factoryRoot,
      "plugin-dynamic-export",
      `export const validPlugin: Plugin = {
  name: "valid",
  description: "fixture",
  views: [${view("valid")}],
};
export const dynamicPlugin: Plugin = buildPlugin();\n`,
    );
    expect(() => discover(factoryRoot, [factory])).toThrow(
      /exported Plugin dynamicPlugin must resolve statically to an object literal/,
    );

    const conditionalRoot = makeRoot();
    const conditional = addPluginSource(
      conditionalRoot,
      "plugin-conditional-export",
      `const conditionalPlugin: Plugin = enabled ? left : right;
export default conditionalPlugin;\n`,
    );
    expect(() => discover(conditionalRoot, [conditional])).toThrow(
      /exported Plugin conditionalPlugin must resolve statically to an object literal/,
    );
  });

  test("deduplicates local export aliases and ignores ordinary exported objects", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-export-alias",
      `export const layout = { views: ["grid"] };
const runtimePlugin: Plugin = {
  name: "runtime",
  description: "fixture",
  views: [${view("runtime")}],
};
export { runtimePlugin, runtimePlugin as default };\n`,
    );
    const inventory = discover(root, [source]);
    expect(inventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "runtime",
    ]);
    expect(
      inventory.sources.filter((entry) => entry.kind === "plugin-manifest"),
    ).toHaveLength(1);
  });

  test("resolves a zero-argument local plugin factory with one static return", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-static-factory",
      `function createPlugin(): Plugin {
  return {
    name: "factory",
    description: "fixture",
    views: [${view("factory")}],
  };
}
export const factoryPlugin: Plugin = createPlugin();\n`,
    );
    expect(discover(root, [source]).views.map((entry) => entry.id)).toEqual([
      "builtin",
      "factory",
    ]);
  });

  test("rejects a factory that mutates and returns a declared manifest", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-mutating-factory",
      `const manifest = {
  name: "factory",
  description: "fixture",
  views: [${view("pre-mutation")}],
};
function createPlugin(): Plugin {
  manifest.views = [${view("runtime")}];
  return manifest;
}
export const factoryPlugin: Plugin = createPlugin();\n`,
    );

    expect(() => discover(root, [source])).toThrow(
      /exported Plugin factoryPlugin must resolve statically to an object literal/,
    );
  });

  test("rejects an otherwise static factory with an executable statement", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-side-effect-factory",
      `function createPlugin(): Plugin {
  observeFactoryExecution();
  return {
    name: "factory",
    description: "fixture",
    views: [${view("runtime")}],
  };
}
export const factoryPlugin: Plugin = createPlugin();\n`,
    );

    expect(() => discover(root, [source])).toThrow(
      /exported Plugin factoryPlugin must resolve statically to an object literal/,
    );
  });

  test("rejects a view factory whose variable initializer can mutate its manifest", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-initializer-side-effect-factory",
      `const views = [${view("pre-mutation")}];
function createPlugin(): Plugin {
  const ignored = mutateViews(views);
  return {
    name: "factory",
    description: "fixture",
    views,
  };
}
export const factoryPlugin: Plugin = createPlugin();\n`,
    );

    expect(() => discover(root, [source])).toThrow(
      /exported Plugin factoryPlugin must resolve statically to an object literal/,
    );
  });

  test("rejects a zero-argument call whose factory has an effectful default parameter", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-default-parameter-factory",
      `let activeViews = [${view("pre-default")}];
function switchViews() { activeViews = [${view("runtime-default")}]; }
function createPlugin(_effect = switchViews()): Plugin {
  return {
    name: "factory",
    description: "fixture",
    views: activeViews,
  };
}
export const factoryPlugin: Plugin = createPlugin();\n`,
    );

    expect(() => discover(root, [source])).toThrow(
      /exported Plugin factoryPlugin must resolve statically to an object literal/,
    );
  });

  test("rejects view-entry spreads before or after audited identity fields", () => {
    for (const declaration of [
      `{
        ...runtimeFields,
        id: "audited-after-spread",
        label: "audited-after-spread",
        path: "/audited-after-spread",
        modalities: ["gui"],
        bundlePath: "dist/views/bundle.js",
        componentExport: "FixtureView",
      }`,
      `{
        id: "audited-before-spread",
        label: "audited-before-spread",
        path: "/audited-before-spread",
        modalities: ["gui"],
        bundlePath: "dist/views/bundle.js",
        componentExport: "FixtureView",
        ...runtimeFields,
      }`,
    ]) {
      const root = makeRoot();
      const source = addPluginSource(
        root,
        "plugin-view-spread",
        `const runtimeFields = { id: "runtime", path: "/runtime" };
export const plugin: Plugin = {
  name: "view-spread",
  description: "fixture",
  views: [${declaration}],
};\n`,
      );
      expect(() => discover(root, [source])).toThrow(
        /view entries may not use object spreads/,
      );
    }
  });

  test("inventories only plugin manifests reachable from the package source entrypoint", () => {
    const root = makeRoot();
    const directory = "plugins/plugin-entry-reachability";
    write(
      root,
      `${directory}/package.json`,
      JSON.stringify({
        name: "@fixture/plugin-entry-reachability",
        exports: {
          ".": {
            "eliza-source": {
              import: "./src/index.ts",
            },
          },
        },
      }),
    );
    const index = `${directory}/src/index.ts`;
    const runtime = `${directory}/src/runtime.ts`;
    const legacy = `${directory}/src/legacy.ts`;
    write(root, index, 'export { runtimePlugin } from "./runtime.js";\n');
    write(
      root,
      runtime,
      `export const runtimePlugin: Plugin = {
  name: "runtime",
  description: "fixture",
  views: [${view("runtime-reachable")}],
};\n`,
    );
    write(
      root,
      legacy,
      `export const legacyPlugin: Plugin = {
  name: "legacy",
  description: "fixture",
  views: [${view("legacy-unreachable")}],
};\n`,
    );

    const inventory = discover(root, [index, runtime, legacy]);
    expect(inventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "runtime-reachable",
    ]);
  });

  test("does not follow type-only edges into runtime-unreachable plugin modules", () => {
    const root = makeRoot();
    const directory = "plugins/plugin-type-only-reachability";
    write(
      root,
      `${directory}/package.json`,
      JSON.stringify({
        name: "@fixture/plugin-type-only-reachability",
        source: "./src/index.ts",
      }),
    );
    const index = `${directory}/src/index.ts`;
    const runtime = `${directory}/src/runtime.ts`;
    const legacy = `${directory}/src/legacy.ts`;
    write(
      root,
      index,
      'export { runtimePlugin } from "./runtime.js";\nexport type { legacyPlugin } from "./legacy.js";\n',
    );
    write(
      root,
      runtime,
      `export const runtimePlugin: Plugin = {
  name: "runtime",
  description: "fixture",
  views: [${view("runtime-reachable")}],
};\n`,
    );
    write(
      root,
      legacy,
      `throw new Error("type-only module must not execute");
export const legacyPlugin: Plugin = {
  name: "legacy",
  description: "fixture",
  views: [${view("legacy-type-only")}],
};\n`,
    );

    const inventory = discover(root, [index, runtime, legacy]);
    expect(inventory.views.map((entry) => entry.id)).toEqual([
      "builtin",
      "runtime-reachable",
    ]);
  });

  test("rejects plugin composition that could hide runtime views", () => {
    const root = makeRoot();
    const source = addPluginSource(
      root,
      "plugin-composed",
      'export const plugin: Plugin = { name: "composed", description: "fixture", ...createPlugin() };\n',
    );
    expect(() => discover(root, [source])).toThrow(
      /Plugin composition must resolve statically so views cannot evade inventory/,
    );
  });

  test("validates CLI output modes and report containment", () => {
    expect(parsePluginViewInventoryArgs([])).toMatchObject({
      stdout: "summary",
      jsonOutput: "reports/plugin-view-inventory.json",
      markdownOutput: "reports/plugin-view-inventory.md",
    });
    expect(
      parsePluginViewInventoryArgs([
        "--markdown",
        "--output",
        "reports/custom.json",
        "--markdown-output",
        "reports/custom.md",
      ]),
    ).toMatchObject({
      stdout: "markdown",
      jsonOutput: "reports/custom.json",
      markdownOutput: "reports/custom.md",
    });
    expect(() =>
      parsePluginViewInventoryArgs(["--json", "--markdown"]),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parsePluginViewInventoryArgs(["--output", "../outside.json"]),
    ).toThrow(/traversal segments/);
  });

  test("the repository inventory is collision-free and has one document view", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const serialized = serializePluginViewInventory(
      discoverPluginViewInventory({ repoRoot }),
    );
    expect(serialized.builtinCount).toBeGreaterThan(10);
    expect(serialized.pluginCount).toBeGreaterThan(15);
    expect(serialized.declarationSourceCount).toBeGreaterThan(15);
    expect(
      serialized.views.filter((entry) => entry.id === "documents"),
    ).toEqual([
      expect.objectContaining({
        owner: "@elizaos/builtin",
        route: "/character/documents",
      }),
    ]);
    expect(
      serialized.declarationSources.some(
        (source) => source.owner === "@elizaos/plugin-documents",
      ),
    ).toBe(false);
  }, 30_000);
});
