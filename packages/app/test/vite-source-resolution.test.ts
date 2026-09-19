/** Verifies the app's real Vite aliases preserve browser-safe package entry contracts. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Alias,
  type ConfigEnv,
  createServer,
  defaultClientConditions,
  normalizePath,
  type UserConfig,
} from "vite";
import { describe, expect, test } from "vitest";
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

  test("resolves the shared terminal palette from workspace source while serving", async () => {
    const { server } = await createAppResolutionServer("serve");

    try {
      const resolved =
        await server.environments.client.pluginContainer.resolveId(
          "@elizaos/shared/terminal/palette",
          path.resolve(appRoot, "../ui/src/terminal/palette.ts"),
        );
      expect(resolved?.id).toBe(
        normalizePath(
          path.resolve(appRoot, "../shared/src/terminal/palette.ts"),
        ),
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
    "resolves shared environment utilities through the common owner while %s config resolves",
    async (command) => {
      const { server } = await createAppResolutionServer(command);
      try {
        const resolved =
          await server.environments.client.pluginContainer.resolveId(
            "@elizaos/common",
            path.resolve(appRoot, "../shared/src/env-utils.ts"),
          );
        expect(resolved?.id).toBe(
          normalizePath(
            path.resolve(
              appRoot,
              command === "serve"
                ? "../common/src/index.ts"
                : "../common/dist/index.js",
            ),
          ),
        );
        await expect(
          server.environments.client.pluginContainer.resolveId(
            "@elizaos/core/client-public",
            path.join(appRoot, "src/main.tsx"),
          ),
        ).rejects.toThrow();
      } finally {
        await server.close();
      }
    },
  );
});
