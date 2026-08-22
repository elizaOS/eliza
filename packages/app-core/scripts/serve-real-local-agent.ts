/**
 * Persistent real local agent for device e2e.
 *
 * This is the long-running counterpart to check-real-local-chat.ts: it boots a
 * real AgentRuntime + real app-core HTTP API with a deterministic model plugin,
 * then stays alive until the surrounding workflow sends SIGTERM. Android
 * WebView tests reach it through adb reverse as a "remote" first-run target.
 * When the parent requests an ephemeral port, this process advertises the
 * already-bound listener through the shared atomic port-file handshake.
 */

import { readFile } from "node:fs/promises";
import { ModelType, type Plugin, type Route } from "@elizaos/core";
import { createDeterministicModelPlugin } from "@elizaos/core/testing";
import { backgroundUploadImageRoute } from "../../agent/src/api/background-routes.ts";
import { registerPluginViews } from "../../agent/src/api/views-registry.ts";
import { registerTriggerTaskWorker } from "../../agent/src/triggers/runtime.ts";
import { startApiServer } from "../src/api/server.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../test/helpers/real-runtime.ts";
import { resolveDeviceE2eModelCall } from "./lib/device-e2e-model-resolver.ts";
import { publishBoundDeviceE2ePort } from "./lib/device-e2e-port-advertisement.ts";

const deviceE2eUploadImageRoute = {
  ...backgroundUploadImageRoute,
  path: "/api/device-e2e/upload-image",
  name: "device-e2e-upload-image",
};

const GENERATED_REGISTRY_URL =
  "https://plugins.eliza.app/generated-registry.json";
const CLOUD_API_PROBE_URL = "https://api.eliza.app/api/v1";
const RUBY_HIGH_EVIDENCE_ACTIONS = new Set([
  "CONNECT_RUBY_HIGH",
  "ENROLL_RUBY_HIGH",
]);

const rubyHighEvidenceActionRoute: Route = {
  type: "POST",
  path: "/api/device-e2e/ruby-high/action",
  rawPath: true,
  name: "device-e2e-ruby-high-action",
  routeHandler: async (ctx) => {
    const json = (status: number, body: unknown) => ({
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    });
    if (process.env.ELIZA_UI_SMOKE_RUBY_HIGH_JOURNEY !== "1") {
      return json(404, { error: "Ruby High evidence actions are disabled." });
    }
    const body =
      ctx.body && typeof ctx.body === "object" && !Array.isArray(ctx.body)
        ? (ctx.body as Record<string, unknown>)
        : {};
    const actionName =
      typeof body.actionName === "string" ? body.actionName.trim() : "";
    if (!RUBY_HIGH_EVIDENCE_ACTIONS.has(actionName)) {
      return json(400, { error: "Unsupported Ruby High evidence action." });
    }
    const action = ctx.runtime.actions.find(
      (candidate) => candidate.name === actionName,
    );
    if (!action) {
      return json(409, {
        error: `${actionName} is not registered on the runtime.`,
      });
    }
    const parameters =
      body.parameters &&
      typeof body.parameters === "object" &&
      !Array.isArray(body.parameters)
        ? (body.parameters as Record<string, unknown>)
        : {};
    const message = {
      content: {
        text: `Run ${actionName} for the connected-agent evidence journey.`,
        source: "client_chat",
      },
    };
    const options = { parameters };
    const valid = await action.validate(
      ctx.runtime,
      message as never,
      undefined,
      options as never,
    );
    if (!valid) {
      return json(409, {
        error: `${actionName} is not valid in the current state.`,
      });
    }
    const callbacks: string[] = [];
    const result = await action.handler(
      ctx.runtime,
      message as never,
      undefined,
      options as never,
      async (content) => {
        if (typeof content.text === "string") callbacks.push(content.text);
      },
    );
    return json(200, { ok: true, actionName, callbacks, result });
  },
};

/**
 * Let an opt-in real-local UI smoke consume the generated registry from the
 * exact checkout under test. Only the canonical generated-registry request is
 * intercepted; npm downloads and every other network boundary stay real.
 */
async function installGeneratedRegistryFixture(): Promise<() => void> {
  const fixturePath =
    process.env.ELIZA_UI_SMOKE_GENERATED_REGISTRY_FIXTURE?.trim();
  if (!fixturePath) return () => {};

  const body = await readFile(fixturePath, "utf8");
  JSON.parse(body);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method =
      init?.method ??
      (typeof input === "string" || input instanceof URL
        ? undefined
        : input.method);
    if (url === CLOUD_API_PROBE_URL && method?.toUpperCase() === "HEAD") {
      return new Response(null, { status: 204 });
    }
    if (url === GENERATED_REGISTRY_URL) {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  console.log(
    `[device-e2e-host-agent] serving generated registry fixture: ${fixturePath}`,
  );
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function resolvePort(): number {
  const raw = process.env.ELIZA_API_PORT ?? process.env.ELIZA_PORT ?? "31337";
  const port = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  const allowsEphemeral = Boolean(process.env.ELIZA_E2E_PORT_FILE?.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid ELIZA_API_PORT/ELIZA_PORT: ${raw}`);
  }
  if (port === 0 && !allowsEphemeral) {
    throw new Error(
      "ELIZA_API_PORT=0 requires ELIZA_E2E_PORT_FILE so the parent can discover the bound port.",
    );
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
  const restoreRegistryFetch = await installGeneratedRegistryFixture();
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
  const proxy = createDeterministicModelPlugin({
    stream: deterministicStream,
    resolve(call) {
      return resolveDeviceE2eModelCall(call, {
        workflowJourney: process.env.ELIZA_UI_SMOKE_WORKFLOW_JOURNEY === "1",
      });
    },
  });
  const mediaRoutesPlugin = {
    name: "device-e2e-media-routes",
    description: "No-secret media-store routes for mobile device smokes.",
    routes: [
      backgroundUploadImageRoute,
      deviceE2eUploadImageRoute,
      rubyHighEvidenceActionRoute,
    ],
  };
  // Route coverage exercises the real dynamic view registry, so the host must
  // declare the view-only task-coordinator plugin instead of relying on the
  // browser smoke suite's synthetic registry fixture. Its Node entrypoint does
  // not load the UI bundle; app-core serves that bundle only when requested.
  const { default: taskCoordinatorPlugin } = await import(
    "../../../plugins/plugin-task-coordinator/src/index.ts"
  );
  const workflowPlugins: Plugin[] = [];
  if (process.env.ELIZA_UI_SMOKE_WORKFLOW_JOURNEY === "1") {
    const { default: workflowPlugin } = await import(
      "../../../plugins/plugin-workflow/src/index.ts"
    );
    const { workflowRoutePlugin } = await import(
      "../../../plugins/plugin-workflow/src/plugin-routes.ts"
    );
    workflowPlugins.push(workflowPlugin, workflowRoutePlugin);
  }
  const runtimeResult = await createRealTestRuntime({
    characterName: "DeviceE2EHostAgent",
    plugins: [
      proxy,
      mediaRoutesPlugin,
      taskCoordinatorPlugin,
      ...workflowPlugins,
    ],
  });
  await registerPluginViews(
    taskCoordinatorPlugin,
    undefined,
    runtimeResult.runtime,
  );
  if (process.env.ELIZA_UI_SMOKE_WORKFLOW_JOURNEY === "1") {
    registerTriggerTaskWorker(runtimeResult.runtime);
  }
  if (process.env.ELIZA_UI_SMOKE_RUBY_HIGH_JOURNEY === "1") {
    const rubyHighUrl = process.env.RUBY_HIGH_URL?.trim();
    if (!rubyHighUrl) {
      throw new Error(
        "RUBY_HIGH_URL is required for the Ruby High evidence journey.",
      );
    }
    runtimeResult.runtime.setSetting("RUBY_HIGH_URL", rubyHighUrl, false);
    console.log(
      `[device-e2e-host-agent] Ruby High evidence URL: ${rubyHighUrl}`,
    );
  }
  const server = await startApiServer({
    port,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });

  const portFile = process.env.ELIZA_E2E_PORT_FILE?.trim();
  publishBoundDeviceE2ePort(server.port, portFile);

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
    restoreRegistryFetch();
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
