/**
 * Exercises AST-derived runtime view inventory generation with synthetic
 * manifests and the real repository, including collision and missing-field
 * CI failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverPluginViewInventory,
  serializePluginViewInventory,
} from "../lib/plugin-view-inventory.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-view-inventory-"));
  tempDirs.push(root);
  return root;
}

function write(root: string, file: string, contents: string) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function addPlugin(root: string, name: string, declaration: string): string {
  const directory = `plugins/${name}`;
  write(
    root,
    `${directory}/package.json`,
    JSON.stringify({ name: `@fixture/${name}` }),
  );
  const source = `${directory}/src/plugin.ts`;
  write(
    root,
    source,
    `export const plugin = { name: "fixture", description: "fixture", views: [${declaration}] };\n`,
  );
  return source;
}

const view = (id: string, route = `/${id}`) => `{
  id: "${id}",
  label: "${id}",
  path: "${route}",
  modalities: ["gui"],
  bundlePath: "dist/views/bundle.js",
  componentExport: "FixtureView",
}`;

describe("plugin view declaration inventory", () => {
  test("parses, classifies, and deterministically serializes declarations", () => {
    const root = makeRoot();
    const beta = addPlugin(
      root,
      "plugin-beta",
      `${view("beta")}, {
        id: "hidden",
        label: "Hidden",
        path: "/hidden",
        viewType: "gui",
        bundlePath: "dist/views/bundle.js",
        componentExport: "HiddenView",
        developerOnly: true,
        roleGate: { minRole: "OWNER" },
        surface: { capabilities: ["agent-surface"] },
        relatedActions: ["HIDDEN_ACTION"],
        capabilities: [{ id: "refresh" }],
      }`,
    );
    const alpha = addPlugin(root, "plugin-alpha", view("alpha"));
    const entries = discoverPluginViewInventory({
      repoRoot: root,
      repositoryFiles: [beta, alpha],
    });
    expect(entries.map((entry) => entry.id)).toEqual([
      "alpha",
      "beta",
      "hidden",
    ]);
    expect(entries[2]).toMatchObject({
      minRole: "OWNER",
      developerOnly: true,
      surfaceCapabilities: ["agent-surface"],
      relatedActions: ["HIDDEN_ACTION"],
      operationIds: ["refresh"],
    });
    expect(serializePluginViewInventory(entries)).toMatchObject({
      schemaVersion: 1,
      discoveredCount: 3,
      pluginCount: 3,
      builtinCount: 0,
    });
  });

  test("rejects duplicate ids and routes across owners", () => {
    const root = makeRoot();
    const alpha = addPlugin(root, "plugin-alpha", view("shared", "/alpha"));
    const beta = addPlugin(root, "plugin-beta", view("shared", "/beta"));
    expect(() =>
      discoverPluginViewInventory({
        repoRoot: root,
        repositoryFiles: [alpha, beta],
      }),
    ).toThrow(/duplicate id "shared"/);

    write(
      root,
      beta,
      `export const plugin = { name: "fixture", description: "fixture", views: [${view("beta", "/alpha")}] };`,
    );
    expect(() =>
      discoverPluginViewInventory({
        repoRoot: root,
        repositoryFiles: [alpha, beta],
      }),
    ).toThrow(/duplicate route "\/alpha"/);
  });

  test("rejects incomplete literal declarations", () => {
    const root = makeRoot();
    const source = addPlugin(
      root,
      "plugin-incomplete",
      '{ id: "incomplete", label: "Incomplete", componentExport: "View" }',
    );
    expect(() =>
      discoverPluginViewInventory({
        repoRoot: root,
        repositoryFiles: [source],
      }),
    ).toThrow(/requires literal path, componentExport, and bundlePath/);
  });

  test("rejects plugin manifests whose view list is not statically inspectable", () => {
    const root = makeRoot();
    const source = addPlugin(root, "plugin-dynamic", view("dynamic"));
    write(
      root,
      source,
      'export const plugin = { name: "dynamic", description: "dynamic", views: createViews() };',
    );
    expect(() =>
      discoverPluginViewInventory({
        repoRoot: root,
        repositoryFiles: [source],
      }),
    ).toThrow(/plugin views must be a literal array/);
  });

  test("the repository inventory is collision-free and includes both document surfaces", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const inventory = serializePluginViewInventory(
      discoverPluginViewInventory({ repoRoot }),
    );
    expect(inventory.pluginCount).toBeGreaterThan(20);
    expect(inventory.builtinCount).toBeGreaterThan(10);
    expect(
      inventory.views.filter((entry) =>
        ["documents", "document-library"].includes(entry.id),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "documents",
        owner: "@elizaos/builtin",
        route: "/character/documents",
      }),
      expect.objectContaining({
        id: "document-library",
        owner: "@elizaos/plugin-documents",
        route: "/documents",
      }),
    ]);
  });
});
