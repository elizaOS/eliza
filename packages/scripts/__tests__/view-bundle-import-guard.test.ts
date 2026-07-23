/**
 * Drives the view import guard against real files so absent bundles and
 * unsupported bare imports remain distinct hard failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bareImportSpecifiers,
  getHostExternalSpecifiers,
  hostExternalSpecifiersFromSources,
  validateViewBundles,
} from "../view-bundle-import-guard.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "view-import-guard-"));
  tempDirs.push(root);
  const workspaceDir = "plugins/plugin-fixture";
  const absoluteDir = path.join(root, workspaceDir);
  fs.mkdirSync(absoluteDir, { recursive: true });
  fs.writeFileSync(
    path.join(absoluteDir, "vite.config.views.ts"),
    "export {};\n",
  );
  const workspace = {
    name: "@fixture/plugin-fixture",
    dir: workspaceDir,
    packageJson: {
      name: "@fixture/plugin-fixture",
      devDependencies: {
        vite: "^8.0.0",
      },
      scripts: {
        "build:views": "bunx --bun vite build --config vite.config.views.ts",
      },
    },
  };
  fs.writeFileSync(
    path.join(absoluteDir, "package.json"),
    `${JSON.stringify(workspace.packageJson)}\n`,
  );
  return {
    root,
    absoluteDir,
    options: {
      repoRoot: root,
      workspacePackages: [workspace],
      repositoryFiles: [`${workspaceDir}/vite.config.views.ts`],
      allowedSpecifiers: ["react"],
    },
  };
}

describe("view bundle import guard", () => {
  test("reports a configured bundle that was not built", async () => {
    const { options } = fixture();
    const result = await validateViewBundles({
      ...options,
      enforceFreshOutputs: true,
    });
    expect(result.bundleCount).toBe(0);
    expect(result.expectedBundleCount).toBe(1);
    expect(result.missingBundles).toHaveLength(1);
    expect(result.violations).toEqual([]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  });

  test("reports unsupported imports from a real emitted bundle", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      'const documentation = "import from fake"; import React from "react";\nimport x from "@fixture/missing"; export { y } from "@fixture/exported";\nimport("@fixture/dynamic"); export { x, documentation };\n',
    );

    const result = await validateViewBundles(options);
    expect(result.missingBundles).toEqual([]);
    expect(result.violations).toEqual([
      { plugin: "plugin-fixture", specifier: "@fixture/missing" },
      { plugin: "plugin-fixture", specifier: "@fixture/exported" },
      { plugin: "plugin-fixture", specifier: "@fixture/dynamic" },
    ]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  });

  test("reports stale or split JavaScript chunks beside bundle.js", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(path.join(bundleDir, "lazy"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "bundle.js"), "export {};\n");
    fs.writeFileSync(
      path.join(bundleDir, "lazy", "old-chunk.js"),
      "export {};\n",
    );
    fs.writeFileSync(path.join(bundleDir, "styles.css"), "body {}\n");

    const result = await validateViewBundles({
      ...options,
      enforceFreshOutputs: true,
    });
    expect(result.unexpectedChunks).toEqual([
      expect.objectContaining({
        name: "plugin-fixture",
        relativeChunk: "dist/views/lazy/old-chunk.js",
      }),
    ]);
    expect(result.unexpectedArtifacts).toEqual([
      expect.objectContaining({
        name: "plugin-fixture",
        relativeArtifact: "dist/views/styles.css",
      }),
    ]);
  });

  test("post-Turbo import validation permits package compiler outputs", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "bundle.js"), "export {};\n");
    fs.writeFileSync(path.join(bundleDir, "view-module.js"), "export {};\n");
    fs.writeFileSync(path.join(bundleDir, "view-module.d.ts"), "export {};\n");

    const result = await validateViewBundles(options);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
  });

  test("rejects malformed bundles instead of treating them as import-free", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "bundle.js"), "import {");

    await expect(validateViewBundles(options)).rejects.toThrow(
      "is not parseable JavaScript",
    );
    expect(() =>
      bareImportSpecifiers(
        'const text = "import x from fake"; import("./relative.js");',
      ),
    ).toThrow("must be self-contained");
  });

  test("rejects imports whose runtime specifier cannot be proven loadable", () => {
    expect(() => bareImportSpecifiers("import(moduleName);")).toThrow(
      "computed dynamic import",
    );
    expect(() => bareImportSpecifiers('require("@fixture/missing");')).toThrow(
      "CommonJS require",
    );
  });

  test("derives registrations from syntax without accepting comment examples", () => {
    const loader = `
      const HOST_EXTERNAL_IMPORTERS = {
        react: () => import("react"),
        "@fixture/static": () => import("@fixture/static"),
      };
      function resolveHostExternal(specifier) {
        return HOST_EXTERNAL_IMPORTERS[specifier];
      }
      export const hostImport = (specifier) => resolveHostExternal(specifier)?.();
    `;
    const registration = `
      import { registerHostExternalImporter as register } from "@elizaos/ui/app-shell-registry";
      // register("<comment-only>", () => import("<comment-only>"));
      const example = 'register("<string-only>", factory)';
      function importHostExternal(specifier) {
        return import(specifier);
      }
      export function initializeHostExternals() {
        register("@fixture/runtime", () => importHostExternal("@fixture/runtime"));
      }
    `;
    const record = {
      entryFile: "main.tsx",
      entrySource: `
        import { initializeHostExternals } from "./host-externals";
        initializeHostExternals();
      `,
      file: "host-externals.ts",
      source: registration,
    };
    expect(hostExternalSpecifiersFromSources(loader, [record])).toEqual(
      new Set(["react", "@fixture/static", "@fixture/runtime"]),
    );
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        {
          ...record,
          file: "host-externals.ts",
          source: `
            import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
            export function initializeHostExternals() {
              registerHostExternalImporter(specifier, () => importHostExternal("@fixture/runtime"));
            }
          `,
        },
      ]),
    ).toThrow("literal specifiers");
  });

  test("requires the loader map and registration initializer to be reachable", () => {
    const deadLoader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      function deadLookup(name) { return HOST_EXTERNAL_IMPORTERS[name]; }
      export const unrelated = true;
    `;
    const registration = {
      entryFile: "main.tsx",
      entrySource: `
        import { initializeHostExternals } from "./host-externals";
      `,
      file: "host-externals.ts",
      source: `
        import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
        export function initializeHostExternals() {
          registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));
        }
      `,
    };
    expect(() =>
      hostExternalSpecifiersFromSources(deadLoader, [registration]),
    ).toThrow("not consumed by an exported runtime path");

    const liveLoader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
    `;
    expect(() =>
      hostExternalSpecifiersFromSources(liveLoader, [registration]),
    ).toThrow("must call initializeHostExternals exactly once at module scope");
    expect(() =>
      hostExternalSpecifiersFromSources(liveLoader, [
        {
          ...registration,
          entrySource: `
            import { initializeHostExternals } from "./host-externals";
            if (false) initializeHostExternals();
          `,
        },
      ]),
    ).toThrow("module scope");
  });

  test("rejects shadowed, non-callable, dead-branch, and mismatched registrations", () => {
    const loader = `
      const HOST_EXTERNAL_IMPORTERS = { react: () => import("react") };
      export function hostImport(name) { return HOST_EXTERNAL_IMPORTERS[name]?.(); }
    `;
    const entry = `
      import { initializeHostExternals } from "./host-externals";
      initializeHostExternals();
    `;
    const source = (body: string, parameters = "") => ({
      entryFile: "main.tsx",
      entrySource: entry,
      file: "host-externals.ts",
      source: `
        import { registerHostExternalImporter } from "@elizaos/ui/app-shell-registry";
        export function initializeHostExternals(${parameters}) {
          ${body}
        }
      `,
    });
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));',
          "registerHostExternalImporter",
        ),
      ]),
    ).toThrow("shadows the registration API");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source('registerHostExternalImporter("@fixture/runtime", undefined);'),
      ]),
    ).toThrow("inline callable");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'if (enabled) registerHostExternalImporter("@fixture/runtime", () => import("@fixture/runtime"));',
        ),
      ]),
    ).toThrow("direct statements");
    expect(() =>
      hostExternalSpecifiersFromSources(loader, [
        source(
          'registerHostExternalImporter("@fixture/runtime", () => import("@fixture/other"));',
        ),
      ]),
    ).toThrow("mismatched specifier");
  });

  test("accepts only imports provided by the host", async () => {
    const { absoluteDir, options } = fixture();
    const bundleDir = path.join(absoluteDir, "dist", "views");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "bundle.js"),
      'import React from "react";\nexport { React };\n',
    );

    const result = await validateViewBundles(options);
    expect(result.missingBundles).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.unexpectedChunks).toEqual([]);
    expect(result.unexpectedArtifacts).toEqual([]);
    expect(result.bundleCount).toBe(1);
  });

  test("the real host registry remains readable and non-empty", async () => {
    const specifiers = await getHostExternalSpecifiers();
    expect(specifiers.size).toBeGreaterThan(0);
    expect(specifiers).toContain("react");
  });
});
