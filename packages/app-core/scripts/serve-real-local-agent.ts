/**
 * Persistent real local agent for device e2e.
 *
 * This is the long-running counterpart to check-real-local-chat.ts: it boots a
 * real AgentRuntime + real app-core HTTP API with a deterministic model plugin,
 * then stays alive until the surrounding workflow sends SIGTERM. Android
 * WebView tests reach it through adb reverse as a "remote" first-run target.
 */

import { ModelType } from "@elizaos/core";
import { backgroundUploadImageRoute } from "../../agent/src/api/background-routes.ts";
import { createDeterministicLlmProxyPlugin } from "../../test/mocks/helpers/llm-proxy-plugin.ts";
import { startApiServer } from "../src/api/server.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../test/helpers/real-runtime.ts";

const deviceE2eUploadImageRoute = {
  ...backgroundUploadImageRoute,
  path: "/api/device-e2e/upload-image",
  name: "device-e2e-upload-image",
};

const STREAM_E2E_REPLY =
  "STREAM_E2E_OK The dashboard receives this reply through the real model callback, runtime message loop, HTTP SSE route, browser parser, and React transcript. " +
  "Each chunk is intentionally small and evenly paced so the browser lane can measure token-to-paint latency, frame cadence, layout stability, and DOM identity while the visible answer grows.";

function resolvePort(): number {
  const raw = process.env.ELIZA_API_PORT ?? process.env.ELIZA_PORT ?? "31337";
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid ELIZA_API_PORT/ELIZA_PORT: ${raw}`);
  }
  return port;
}

function resolveNonNegativeIntegerEnv(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer: ${raw}`);
  }
  return value;
}

function resolvePositiveIntegerEnv(name: string, fallback: string): number {
  const value = resolveNonNegativeIntegerEnv(name, fallback);
  if (value === 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return value;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const port = resolvePort();
  const streamIntervalMs = resolveNonNegativeIntegerEnv(
    "ELIZA_E2E_MODEL_STREAM_INTERVAL_MS",
    "0",
  );
  const streamChunkSize = resolvePositiveIntegerEnv(
    "ELIZA_E2E_MODEL_STREAM_CHUNK_SIZE",
    "4",
  );
  const deterministicStream = {
    chunkSize: streamChunkSize,
    intervalMs: streamIntervalMs,
    modelTypes: [ModelType.RESPONSE_HANDLER],
  };

  process.env.ELIZA_PAIRING_DISABLED ??= "1";

  const configEnv = useIsolatedConfigEnv("eliza-device-e2e-host-agent-");
  const proxy = createDeterministicLlmProxyPlugin({
    failOnUnhandledAction: false,
    stream: deterministicStream,
    resolve(call) {
      if (call.modelType !== ModelType.RESPONSE_HANDLER) {
        return null;
      }
      const args = {
        shouldRespond: "RESPOND",
        contexts: ["simple"],
        intents: ["chat"],
        replyText: STREAM_E2E_REPLY,
        candidateActionNames: [],
        facts: [],
        relationships: [],
        addressedTo: [],
        emotion: "none",
      };
      return JSON.stringify(args);
    },
  });
  const mediaRoutesPlugin = {
    name: "device-e2e-media-routes",
    description: "No-secret media-store routes for mobile device smokes.",
    routes: [backgroundUploadImageRoute, deviceE2eUploadImageRoute],
  };
  const runtimeResult = await createRealTestRuntime({
    characterName: "DeviceE2EHostAgent",
    plugins: [proxy, mediaRoutesPlugin],
  });
  const server = await startApiServer({
    port,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });

  console.log(
    `[device-e2e-host-agent] real API up on :${server.port} in ${Date.now() - t0}ms`,
  );

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[device-e2e-host-agent] stopping (${signal})`);
    // error-policy:J6 best-effort teardown on shutdown signal; nothing consumes
    // a teardown rejection once the process is stopping.
    await server.close().catch(() => undefined);
    await runtimeResult.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(signal).finally(() => process.exit(0));
    });
  }

  await new Promise<never>(() => {});
}

main().catch((error) => {
  console.error(
    `[device-e2e-host-agent] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
