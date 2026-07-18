/**
 * Covers the app-route-plugin skip/normalize/load helpers exported from
 * `eliza.ts`: `getSkippedAppRoutePluginIds` (parsing the
 * `ELIZA_SKIP_APP_ROUTE_PLUGINS` env list), `normalizeAppRoutePluginId` (id
 * canonicalization), and `__loadAppRoutePluginFromSpecifierForTest` (loading a
 * real first-party route plugin and surfacing missing transitive imports). One
 * case writes a throwaway plugin package into `node_modules`; another asserts
 * eliza.ts hardcodes no first-party route-loader fallbacks.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __loadAppRoutePluginFromSpecifierForTest,
  getSkippedAppRoutePluginIds,
  normalizeAppRoutePluginId,
} from "./eliza.ts";

const ENV_KEY = "ELIZA_SKIP_APP_ROUTE_PLUGINS";
const nodeExecutable = process.versions.bun ? "node" : process.execPath;

describe("getSkippedAppRoutePluginIds", () => {
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedValue;
    }
  });

  it("returns an empty set when the knob is unset (default unchanged: every app-route plugin loads)", () => {
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for an empty string", () => {
    process.env[ENV_KEY] = "";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for whitespace-only input", () => {
    process.env[ENV_KEY] = "   ";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("parses a comma-separated list, trimming each id and dropping blank segments", () => {
    process.env[ENV_KEY] = "lifeops,training, steward";
    const skipped = getSkippedAppRoutePluginIds();
    expect(skipped).toEqual(new Set(["lifeops", "training", "steward"]));
  });

  it("ignores trailing and duplicate commas without producing empty entries", () => {
    process.env[ENV_KEY] = "lifeops,,training,";
    const skipped = getSkippedAppRoutePluginIds();
    expect(skipped).toEqual(new Set(["lifeops", "training"]));
    expect(skipped.has("")).toBe(false);
  });
});

describe("normalizeAppRoutePluginId", () => {
  it("strips the @elizaos/plugin- prefix", () => {
    expect(
      normalizeAppRoutePluginId("@elizaos/plugin-personal-assistant"),
    ).toBe("personal-assistant");
  });

  it("strips -app / -ui / -routes suffixes", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-wallet-ui")).toBe(
      "wallet",
    );
    expect(normalizeAppRoutePluginId("@elizaos/plugin-shopify")).toBe(
      "shopify",
    );
    expect(normalizeAppRoutePluginId("@elizaos/plugin-documents-routes")).toBe(
      "documents",
    );
  });

  it("strips the :routes suffix", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-elizacloud:routes")).toBe(
      "elizacloud",
    );
  });

  it("lowercases and trims", () => {
    expect(normalizeAppRoutePluginId("  Hyperliquid-App  ")).toBe(
      "hyperliquid",
    );
  });

  it("is idempotent on an already-short alias (so short tokens match full ids)", () => {
    expect(normalizeAppRoutePluginId("wallet")).toBe("wallet");
    expect(normalizeAppRoutePluginId("@elizaos/plugin-wallet-ui")).toBe(
      normalizeAppRoutePluginId("wallet"),
    );
  });
});

describe("__loadAppRoutePluginFromSpecifierForTest", () => {
  const packageRoot = path.resolve(
    process.cwd(),
    "node_modules/@elizaos/plugin-broken-route-loader-test",
  );

  afterEach(async () => {
    await rm(packageRoot, { force: true, recursive: true });
  });

  it("does not classify missing transitive source imports as optional unavailable", async () => {
    await mkdir(path.join(packageRoot, "src"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@elizaos/plugin-broken-route-loader-test",
        type: "module",
        exports: {
          "./package.json": "./package.json",
          "./plugin-routes": "./src/plugin-routes.js",
        },
      }),
      { encoding: "utf-8" },
    );
    await writeFile(
      path.join(packageRoot, "src/plugin-routes.js"),
      [
        'import "@elizaos/definitely-missing-transitive-route-test";',
        "export const routePlugin = {",
        '  name: "broken-route-loader-test",',
        "  routes: [],",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      __loadAppRoutePluginFromSpecifierForTest(
        "@elizaos/plugin-broken-route-loader-test/plugin-routes",
        "routePlugin",
      ),
    ).rejects.toThrow(/definitely-missing-transitive-route-test/);
  });

  it("loads the agent-orchestrator rawPath route plugin by explicit specifier", async () => {
    const plugin = await __loadAppRoutePluginFromSpecifierForTest(
      "@elizaos/plugin-agent-orchestrator/setup-routes",
      "codingAgentRoutePlugin",
    );

    expect(plugin.name).toBe("@elizaos/plugin-agent-orchestrator-routes");
    expect(
      plugin.routes?.some((route) => route.path === "/api/coding-agents"),
    ).toBe(true);
    expect(
      plugin.routes?.some((route) => route.path === "/api/orchestrator/status"),
    ).toBe(true);
  });

  it("loads the personal-assistant LifeOps routes by explicit specifier", async () => {
    const appCoreRoot = path.resolve(import.meta.dirname, "../..");
    const monorepoRoot = path.resolve(appCoreRoot, "../..");
    const script = [
      'const { __loadAppRoutePluginFromSpecifierForTest } = await import("./src/runtime/eliza.ts");',
      "const plugin = await __loadAppRoutePluginFromSpecifierForTest(",
      '  "@elizaos/plugin-personal-assistant/routes/plugin",',
      '  "personalAssistantRoutesPlugin",',
      ");",
      "const paths = (plugin.routes ?? []).map((route) => route.path);",
      'if (plugin.name !== "@elizaos/plugin-personal-assistant-routes") {',
      '  throw new Error("Unexpected route plugin: " + plugin.name);',
      "}",
      'for (const requiredPath of ["/api/lifeops/goals", "/api/lifeops/todos"]) {',
      "  if (!paths.includes(requiredPath)) {",
      '    throw new Error("Missing LifeOps route: " + requiredPath);',
      "  }",
      "}",
    ].join("\n");

    // Runtime app-route imports are intentionally variable specifiers and
    // therefore bypass Vite aliases. A source-conditioned Node process mirrors
    // workspace development while keeping the default Vitest resolver stable.
    execFileSync(
      nodeExecutable,
      [
        "--conditions=eliza-source",
        "--conditions=development",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: appCoreRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(monorepoRoot, "tsconfig.json"),
        },
      },
    );
  });
});

describe("app-core route plugin ownership boundary", () => {
  it("does not hardcode first-party plugin route-loader fallbacks", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "eliza.ts"),
      "utf8",
    );

    expect(source).not.toContain("@elizaos/plugin-workflow/plugin-routes");
    expect(source).not.toContain("@elizaos/plugin-wallet/routes/plugin");
    expect(source).not.toContain(
      "@elizaos/plugin-agent-orchestrator/setup-routes",
    );
  });
});
