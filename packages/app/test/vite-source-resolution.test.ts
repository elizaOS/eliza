/** Verifies development resolves workspace source without changing production builds. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConfigEnv,
  createServer,
  defaultClientConditions,
  normalizePath,
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

  test("resolves the shared terminal palette from workspace source while serving", async () => {
    const serveConfig = await resolveAppViteConfig("serve");
    const server = await createServer({
      configFile: false,
      root: appRoot,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      resolve: { conditions: serveConfig.resolve?.conditions },
      server: { middlewareMode: true },
    });

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
    const serveConfig = await resolveAppViteConfig("serve");
    const server = await createServer({
      configFile: false,
      root: appRoot,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      resolve: { conditions: serveConfig.resolve?.conditions },
      server: { middlewareMode: true },
    });

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
});
