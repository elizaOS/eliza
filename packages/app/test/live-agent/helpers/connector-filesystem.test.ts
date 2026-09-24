/** Exercises connector resolution through real package layouts and dynamic imports in isolated Node processes. */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperSource = fileURLToPath(
  new URL("./connector-imports.ts", import.meta.url),
);
const connectors = [
  "Telegram",
  "Lens",
  "Farcaster",
  "Nostr",
  "Matrix",
  "Feishu",
] as const;

function runFixture(
  connector: (typeof connectors)[number],
  files: Record<string, string>,
) {
  const root = mkdtempSync(path.join(tmpdir(), "connector-import-"));
  try {
    const helper = path.join(
      root,
      "packages/app/test/live-agent/helpers/connector-imports.ts",
    );
    mkdirSync(path.dirname(helper), { recursive: true });
    copyFileSync(helperSource, helper);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const runner = path.join(path.dirname(helper), "run.mjs");
    writeFileSync(
      runner,
      `import { resolve${connector}PluginImportSpecifier, extractPlugin } from './connector-imports.ts';
const specifier = resolve${connector}PluginImportSpecifier();
const plugin = specifier === null ? null : extractPlugin(await import(specifier));
process.stdout.write(JSON.stringify(plugin));`,
    );
    return JSON.parse(
      execFileSync(process.execPath, [runner], { encoding: "utf8" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const entry = (name: string) =>
  `export default { name: ${JSON.stringify(name)} };`;

describe("connector filesystem imports", () => {
  it.each(["Telegram", "Lens", "Feishu"] as const)(
    "imports %s from an ESM-only package-local dependency",
    (connector) => {
      const packageName =
        connector === "Lens"
          ? "@elizaos-plugins/client-lens"
          : `@elizaos/plugin-${connector.toLowerCase()}`;
      const directory = `packages/app/node_modules/${packageName}`;
      expect(
        runFixture(connector, {
          [`${directory}/package.json`]: JSON.stringify({
            name: packageName,
            type: "module",
            exports: { import: "./dist/index.js" },
          }),
          [`${directory}/dist/index.js`]: entry(connector),
        }),
      ).toEqual({ name: connector });
    },
  );

  it.each(connectors)(
    "imports the %s checkout when no installed package resolves",
    (connector) => {
      const relative =
        connector === "Farcaster" ? "dist/node/index.node.js" : "dist/index.js";
      expect(
        runFixture(connector, {
          [`plugins/plugin-${connector.toLowerCase()}/${relative}`]:
            entry(connector),
        }),
      ).toEqual({ name: connector });
    },
  );

  it("imports the existing sibling Farcaster checkout layout", () => {
    expect(
      runFixture("Farcaster", {
        "packages/plugins/plugin-farcaster/dist/node/index.node.js":
          entry("sibling"),
      }),
    ).toEqual({ name: "sibling" });
  });

  it("imports the standalone Lens source checkout", () => {
    expect(
      runFixture("Lens", {
        "client-lens/src/index.ts": entry("lens-source"),
      }),
    ).toEqual({ name: "lens-source" });
  });

  it("prefers the installed canonical package to a local checkout", () => {
    const directory = "packages/app/node_modules/@elizaos/plugin-telegram";
    expect(
      runFixture("Telegram", {
        [`${directory}/package.json`]: JSON.stringify({
          type: "module",
          exports: "./dist/index.js",
        }),
        [`${directory}/dist/index.js`]: entry("installed"),
        "plugins/plugin-telegram/dist/index.js": entry("checkout"),
      }),
    ).toEqual({ name: "installed" });
  });

  it("imports the alternate Lens package before checkout fallbacks", () => {
    const directory =
      "packages/app/node_modules/@elizaos-plugins/client-lens";
    expect(
      runFixture("Lens", {
        [`${directory}/package.json`]: JSON.stringify({
          type: "module",
          exports: "./dist/index.js",
        }),
        [`${directory}/dist/index.js`]: entry("alternate"),
        "plugins/plugin-lens/dist/index.js": entry("checkout"),
      }),
    ).toEqual({ name: "alternate" });
  });

  it.each(connectors)(
    "returns unavailable for absent %s installations",
    (connector) => {
      expect(runFixture(connector, {})).toBeNull();
    },
  );
});
