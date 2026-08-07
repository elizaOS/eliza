/** Defines app-core live runtime server ts behavior for dashboard host and runtime integration. */
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
  startupTimeoutMs?: number;
  tempPrefix: string;
};

export type RuntimeHarness = {
  close: () => Promise<void>;
  logs: () => string;
  port: number;
};

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
      plugins: options.plugins ?? [],
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
