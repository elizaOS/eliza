/** Verifies the app's real Vite aliases preserve browser-safe package entry contracts. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  type Alias,
  build,
  type ConfigEnv,
  createServer,
  defaultClientConditions,
  normalizePath,
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

  test("resolves the Cloud SDK redemption contract from workspace source in production builds", async () => {
    const buildConfig = await resolveAppViteConfig("build");
    const server = await createServer({
      configFile: false,
      root: appRoot,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      resolve: { alias: buildConfig.resolve?.alias },
      server: { middlewareMode: true },
    });

    try {
      const resolved =
        await server.environments.client.pluginContainer.resolveId(
          "@elizaos/cloud-sdk/redemption-contract",
          path.resolve(
            appRoot,
            "../cloud/shared/src/types/redemption-contract.ts",
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
  });

  test.each(["serve", "build"] as const)(
    "resolves Cloud shared wildcard exports from workspace source while %s config resolves",
    async (command) => {
      const { server } = await createAppResolutionServer(command);

      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            "@elizaos/cloud-shared/types/redemption-contract",
            path.resolve(
              appRoot,
              "../ui/src/cloud/monetization/earnings/EarningsPageClient.tsx",
            ),
          );
        expect(resolved?.id).toBe(
          normalizePath(
            path.resolve(
              appRoot,
              "../cloud/shared/src/types/redemption-contract.ts",
            ),
          ),
        );
      } finally {
        await server.close();
      }
    },
  );

  test("resolves the canonical UI terminal palette from workspace source while serving", async () => {
    const { server } = await createAppResolutionServer("serve");

    try {
      const resolved =
        await server.environments.client.pluginContainer.resolveId(
          "@elizaos/ui/terminal/palette",
          path.resolve(appRoot, "../ui/src/terminal/palette.ts"),
        );
      expect(resolved?.id).toBe(
        normalizePath(path.resolve(appRoot, "../ui/src/terminal/palette.ts")),
      );
    } finally {
      await server.close();
    }
  });

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
            "@elizaos/core/views/view-interact-protocol",
            path.join(appRoot, "src/main.tsx"),
          );
        expect(resolved?.id).toBe(
          normalizePath(
            path.resolve(
              appRoot,
              "../core/src/views/view-interact-protocol.ts",
            ),
          ),
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
