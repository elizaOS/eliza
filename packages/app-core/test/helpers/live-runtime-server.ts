import type { Plugin } from "@elizaos/core";
import { startApiServer } from "../../src/api/server.ts";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "./real-runtime.ts";
import { saveEnv } from "./test-utils.ts";

export type StartLiveRuntimeServerOptions = {
  env?: Record<string, string | undefined>;
  plugins?: Plugin[];
  loggingLevel?: "debug" | "info" | "warn" | "error";
  pluginsAllow?: string[];
  startupTimeoutMs?: number;
  tempPrefix: string;
};

export type RuntimeHarness = {
  close: () => Promise<void>;
  logs: () => string;
  port: number;
};

async function resolveAllowedPlugin(name: string): Promise<Plugin> {
  switch (name) {
    case "@elizaos/app-shopify": {
      const { shopifyPlugin } = await import("@elizaos/app-shopify");
      return shopifyPlugin;
    }
    case "@elizaos/app-vincent": {
      const { vincentPlugin } = await import("@elizaos/app-vincent");
      return vincentPlugin;
    }
    default:
      throw new Error(`Unsupported live test plugin allow entry: ${name}`);
  }
}

async function resolvePlugins(
  options: StartLiveRuntimeServerOptions,
): Promise<Plugin[]> {
  const plugins = [...(options.plugins ?? [])];
  for (const pluginName of options.pluginsAllow ?? []) {
    plugins.push(await resolveAllowedPlugin(pluginName));
  }
  return plugins;
}

export async function startLiveRuntimeServer(
  options: StartLiveRuntimeServerOptions,
): Promise<RuntimeHarness> {
  const envBackup = saveEnv(...Object.keys(options.env ?? {}));
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  let runtimeResult: RealTestRuntimeResult | null = null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;
  try {
    runtimeResult = await createRealTestRuntime({
      plugins: await resolvePlugins(options),
    });
    server = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
  } catch (error) {
    await server?.close();
    await runtimeResult?.cleanup();
    envBackup.restore();
    throw error;
  }

  return {
    port: server.port,
    logs: () => "",
    close: async () => {
      await server?.close();
      await runtimeResult?.cleanup();
      envBackup.restore();
    },
  };
}
