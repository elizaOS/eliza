/** Verifies the app's real Vite aliases preserve browser-safe package entry contracts. */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import {
  type Alias,
  build,
  type ConfigEnv,
  createServer,
  defaultClientConditions,
  normalizePath,
  optimizeDeps,
  resolveConfig,
  type UserConfig,
} from "vite";
import { describe, expect, test } from "vitest";
import { rejectRuntimeInRendererPlugin } from "../scripts/lib/renderer-runtime-boundary.ts";
import appViteConfig from "../vite.config";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function resolveAppViteConfig(command: ConfigEnv["command"]) {
  if (typeof appViteConfig !== "function") {
    throw new Error("app Vite config must be command-aware");
  }
  return await appViteConfig({
    command,
    mode: command === "serve" ? "development" : "production",
    isPreview: false,
    isSsrBuild: false,
  });
}

function appAliases(config: UserConfig): Alias[] {
  const aliases = config.resolve?.alias;
  if (!Array.isArray(aliases)) {
    throw new Error("app Vite aliases must use ordered array semantics");
  }
  return aliases;
}

async function createAppResolutionServer(
  command: ConfigEnv["command"],
): Promise<{
  config: UserConfig;
  server: Awaited<ReturnType<typeof createServer>>;
}> {
  const config = await resolveAppViteConfig(command);
  const server = await createServer({
    configFile: false,
    root: appRoot,
    plugins: [rejectRuntimeInRendererPlugin()],
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: appAliases(config),
      conditions: config.resolve?.conditions,
    },
    server: { middlewareMode: true },
  });
  return { config, server };
}

describe("workspace package resolution", () => {
  test("dev selector imports use optimized ESM instead of raw CommonJS", async () => {
    const config = await resolveAppViteConfig("serve");
    const cacheDir = await mkdtemp(
      path.join(os.tmpdir(), "eliza-selector-interop-"),
    );
    // Exercise the app's exact aliases and optimizer entries with a fresh cache.
    const include = config.optimizeDeps?.include?.filter(
      (id) => id === "react" || id.startsWith("use-sync-external-store/"),
    );
    const options: UserConfig = {
      configFile: false,
      root: appRoot,
      cacheDir,
      logLevel: "silent",
      resolve: {
        alias: appAliases(config),
        conditions: config.resolve?.conditions,
      },
      optimizeDeps: { noDiscovery: true, entries: [], include },
      server: { middlewareMode: true, ws: false },
    };
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const metadata = await optimizeDeps(
        await resolveConfig(options, "serve"),
        true,
      );
      const entry =
        metadata.optimized["use-sync-external-store/shim/with-selector.js"];
      expect(
        entry,
        "selector shim must be prebundled when discovery is disabled",
      ).toBeDefined();
      const code = await readFile(entry.file, "utf8");
      expect(code).toMatch(/export[\s\S]*\bdefault\b/);
      const exports = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const m=await import(process.argv[1]); console.log(JSON.stringify({selector:typeof m.default.useSyncExternalStoreWithSelector}));",
            pathToFileURL(entry.file).href,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(exports).toEqual({ selector: "function" });
      server = await createServer(options);
      const require = createRequire(path.join(appRoot, "package.json"));
      const importer = require.resolve("use-sync-external-store/package.json");
      for (const specifier of [
        "use-sync-external-store/shim",
        "use-sync-external-store/shim/with-selector",
        "use-sync-external-store/shim/with-selector.js",
        "use-sync-external-store/with-selector",
        "use-sync-external-store/with-selector.js",
      ]) {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            specifier,
            importer,
          );
        expect(resolved?.id, specifier).toContain(normalizePath(cacheDir));
        expect(resolved?.id).not.toContain("/shim/with-selector.js?");
        const transformed = await server.environments.client.transformRequest(
          `/@fs${resolved?.id}`,
        );
        expect(transformed?.code).toMatch(/export[\s\S]*\bdefault\b/);
      }
    } finally {
      await server?.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["relationships", "RelationshipsPage"],
    ["calendar", "CalendarPage"],
    ["notes", "NotesView"],
    ["knowledge", "KnowledgeView"],
  ])(
    "%s dev modules stay inside the renderer boundary",
    async (plugin, view) => {
      const { server } = await createAppResolutionServer("serve");
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            `@elizaos/plugin-${plugin}`,
            path.resolve(appRoot, "src/main.tsx"),
          );
        const root = normalizePath(
          path.resolve(appRoot, `../../plugins/plugin-${plugin}/src`),
        );
        expect(resolved?.id).toBe(`${root}/browser.ts`);
        const pending = [`/@fs${resolved?.id}`];
        const visited = new Set<string>();
        while (pending.length) {
          const url = pending.pop();
          if (!url) break;
          if (visited.has(url)) continue;
          visited.add(url);
          await server.environments.client.transformRequest(url);
          const module =
            await server.environments.client.moduleGraph.getModuleByUrl(url);
          for (const dependency of module?.importedModules ?? []) {
            if (dependency.id?.startsWith(`${root}/`))
              pending.push(dependency.url);
          }
        }
        expect([...visited].some((url) => url.includes(view))).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  test.each([
    [
      "@elizaos/plugin-elizacloud/steward-session-client",
      "plugins/plugin-elizacloud/src/steward-session-client/index.ts",
    ],
    [
      "@elizaos/plugin-elizacloud/cloud-config/domain-contract",
      "plugins/plugin-elizacloud/src/cloud-config/domain-contract.ts",
    ],
    [
      "@elizaos/plugin-native-phone",
      "plugins/plugin-native-phone/src/index.ts",
    ],
    [
      "@elizaos/plugin-native-phone/register",
      "plugins/plugin-native-phone/src/register.ts",
    ],
    [
      "@elizaos/plugin-assistant/text/template-rendering",
      "plugins/plugin-assistant/src/text/template-rendering.ts",
    ],
  ])(
    "resolves %s from its canonical source export",
    async (specifier, source) => {
      const { server } = await createAppResolutionServer("build");
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            specifier,
            path.resolve(appRoot, "src/main.tsx"),
          );
        expect(resolved?.id).toBe(
          normalizePath(path.resolve(appRoot, "../..", source)),
        );
      } finally {
        await server.close();
      }
    },
  );

  test.each(["contacts", "messages", "phone"])(
    "resolves the %s host bridge from source in production",
    async (name) => {
      const { server } = await createAppResolutionServer("build");
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            `@elizaos/plugin-native-${name}/bridge`,
            path.resolve(appRoot, "src/host-externals.ts"),
          );
        expect(resolved?.id).toBe(
          normalizePath(
            path.resolve(
              appRoot,
              `../../plugins/plugin-native-${name}/src/bridge.ts`,
            ),
          ),
        );
      } finally {
        await server.close();
      }
    },
  );

  test("browser libraries preserve scheduling, decimal and template semantics", async () => {
    const config = await resolveAppViteConfig("build");
    const entry = path.resolve(appRoot, "src/browser-library-contract.js");
    const result = await build({
      configFile: false,
      root: appRoot,
      logLevel: "silent",
      resolve: { alias: appAliases(config) },
      plugins: [
        {
          name: "cron-contract-entry",
          resolveId(id) {
            if (id === entry) return id;
          },
          load(id) {
            if (id === entry)
              return `
            import { CronExpressionParser } from "cron-parser";
            import Decimal from "decimal.js-light";
            import Handlebars from "handlebars";
            import debug from "debug";
            import redact from "fast-redact";
            export function next() {
              const schedule = CronExpressionParser.parse("0 9 * * 1-5", {
                currentDate: "2026-09-25T10:00:00Z", tz: "UTC"
              });
              return schedule.next().toDate().toISOString();
            }
            export function contracts() {
              debug.enable("app:*,-app:private");
              return {
                decimal: new Decimal("0.1").plus("0.2").toString(),
                template: Handlebars.compile("{{#if enabled}}{{name}}{{/if}}")({ enabled: true, name: "<value>" }),
                debugEnabled: debug.enabled("app:public"),
                debugExcluded: debug.enabled("app:private"),
                redacted: JSON.parse(redact({ paths: ["token"] })({ token: "private-value", visible: "ok" })),
              };
            }
          `;
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: { entry, name: "CronContract", formats: ["iife"] },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result).output;
    const chunk = output.find((item) => item.type === "chunk");
    if (!chunk) throw new Error("Expected a browser cron bundle");
    expect(Object.keys(chunk.modules)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("CronFileParser")]),
    );
    expect(runInNewContext(`${chunk.code}\nCronContract.next()`)).toBe(
      "2026-09-28T09:00:00.000Z",
    );
    expect(runInNewContext(`${chunk.code}\nCronContract.contracts()`)).toEqual({
      decimal: "0.3",
      template: "&lt;value&gt;",
      debugEnabled: true,
      debugExcluded: false,
      redacted: { token: "[REDACTED]", visible: "ok" },
    });
  });

  test("extends Vite client conditions only while serving", async () => {
    const serveConfig = await resolveAppViteConfig("serve");
    const buildConfig = await resolveAppViteConfig("build");

    expect(serveConfig.resolve?.conditions).toEqual([
      "eliza-source",
      ...defaultClientConditions,
    ]);
    expect(buildConfig.resolve?.conditions).toBeUndefined();
  });

  test.each(["serve", "build"] as const)(
    "resolves the Cloud SDK redemption contract from workspace source with %s aliases",
    async (command) => {
      const { server } = await createAppResolutionServer(command);
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            "@elizaos/cloud-sdk/redemption-contract",
            path.resolve(
              appRoot,
              "../ui/src/cloud/monetization/earnings/CreatorEarningsStatement.tsx",
            ),
          );
        expect(resolved?.id).toBe(
          normalizePath(
            path.resolve(appRoot, "../cloud/sdk/src/redemption-contract.ts"),
          ),
        );
      } finally {
        await server.close();
      }
    },
  );

  test("keeps browser conditional exports on their browser entry", async () => {
    const { server } = await createAppResolutionServer("serve");

    try {
      const resolved =
        await server.environments.client.pluginContainer.resolveId(
          "react-dom/server",
          path.join(appRoot, "src/main.tsx"),
        );
      expect(resolved?.id).toMatch(/react-dom[/\\]server\.browser\.js$/);
    } finally {
      await server.close();
    }
  });

  test.each(["serve", "build"] as const)(
    "resolves canonical browser contracts and rejects runtime imports with %s aliases",
    async (command) => {
      const { server } = await createAppResolutionServer(command);
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            "@elizaos/core/protocol",
            path.join(appRoot, "src/main.tsx"),
          );
        expect(resolved?.id).toBe(
          normalizePath(path.resolve(appRoot, "../core/src/protocol.ts")),
        );
        for (const runtimeImport of [
          "@elizaos/core",
          "@elizaos/core/client-public",
        ]) {
          await expect(
            server.environments.client.pluginContainer.resolveId(
              runtimeImport,
              path.join(appRoot, "src/main.tsx"),
            ),
          ).rejects.toThrow(
            runtimeImport === "@elizaos/core"
              ? "Node runtime import"
              : "not exported",
          );
        }
      } finally {
        await server.close();
      }
    },
  );
});
