/**
 * Persistent real local agent for device e2e.
 *
 * This is the long-running counterpart to check-real-local-chat.ts. Ordinary
 * UI smokes use its deterministic model mode for repeatable rendering; voice
 * evidence opts into live Cerebras plus a real fused local ASR/TTS bundle. The
 * process stays alive until the surrounding workflow sends SIGTERM, and device
 * tests reach it as a remote first-run target.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ModelType, type Route } from "@elizaos/core";
import { backgroundUploadImageRoute } from "../../agent/src/api/background-routes.ts";
import { createDeterministicLlmProxyPlugin } from "../../test/mocks/helpers/llm-proxy-plugin.ts";
import { startApiServer } from "../src/api/server.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../test/helpers/real-runtime.ts";

const deviceE2eUploadImageRoute = {
  ...backgroundUploadImageRoute,
  path: "/api/device-e2e/upload-image",
  name: "device-e2e-upload-image",
};

const STREAM_E2E_REPLY =
  "STREAM_E2E_OK The dashboard receives this reply through the real model callback, runtime message loop, HTTP SSE route, browser parser, and React transcript. " +
  "Each chunk is intentionally small and evenly paced so the browser lane can measure token-to-paint latency, frame cadence, layout stability, and DOM identity while the visible answer grows.";
const GENERATED_REGISTRY_URL =
  "https://plugins.elizacloud.ai/generated-registry.json";
const CLOUD_API_PROBE_URL = "https://elizacloud.ai/api/v1";
const LIVE_CEREBRAS_MODE = "live-cerebras";
const LIVE_CEREBRAS_MODEL = "gemma-4-31b";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LiveVoiceBundle {
  id: string;
  root: string;
  textModelPath: string;
  audioProjectorPath?: string;
}

async function resolveLiveVoiceBundle(): Promise<LiveVoiceBundle> {
  const root = process.env.ELIZA_E2E_LOCAL_VOICE_BUNDLE?.trim();
  if (!root || !path.isAbsolute(root)) {
    throw new Error(
      "ELIZA_E2E_LOCAL_VOICE_BUNDLE must name an absolute Eliza-1 bundle path.",
    );
  }
  const manifestPath = path.join(root, "eliza-1.manifest.json");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(manifest) || typeof manifest.id !== "string") {
    throw new Error(`${manifestPath} does not declare a string model id.`);
  }
  const files = manifest.files;
  if (!isRecord(files) || !Array.isArray(files.text)) {
    throw new Error(`${manifestPath} does not declare text model files.`);
  }
  const textEntry = files.text.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.path === "string",
  );
  if (!textEntry || typeof textEntry.path !== "string") {
    throw new Error(`${manifestPath} has no usable text model path.`);
  }
  const textModelPath = path.resolve(root, textEntry.path);
  if (!textModelPath.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`${manifestPath} contains a text path outside the bundle.`);
  }
  if (!(await stat(textModelPath)).isFile()) {
    throw new Error(`${textModelPath} is not a model file.`);
  }

  const audioEntry = Array.isArray(files.asr)
    ? files.asr.find(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && typeof entry.path === "string",
      )
    : undefined;
  const audioProjectorPath =
    audioEntry && typeof audioEntry.path === "string"
      ? path.resolve(root, audioEntry.path)
      : undefined;
  if (
    audioProjectorPath &&
    !audioProjectorPath.startsWith(`${path.resolve(root)}${path.sep}`)
  ) {
    throw new Error(`${manifestPath} contains an ASR path outside the bundle.`);
  }
  if (audioProjectorPath && !(await stat(audioProjectorPath)).isFile()) {
    throw new Error(`${audioProjectorPath} is not an ASR model file.`);
  }
  return {
    id: manifest.id,
    root,
    textModelPath,
    ...(audioProjectorPath ? { audioProjectorPath } : {}),
  };
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
  const mediaRoutesPlugin = {
    name: "device-e2e-media-routes",
    description: "No-secret media-store routes for mobile device smokes.",
    routes: [
      backgroundUploadImageRoute,
      deviceE2eUploadImageRoute,
      rubyHighEvidenceActionRoute,
    ],
  };
  const modelMode =
    process.env.ELIZA_DEVICE_E2E_MODEL_MODE?.trim() || "deterministic";
  let localVoiceCleanup: (() => Promise<void>) | null = null;
  let runtimeResult: RealTestRuntimeResult;
  if (modelMode === LIVE_CEREBRAS_MODE) {
    const bundle = await resolveLiveVoiceBundle();
    const [
      { default: localInferencePlugin },
      { ensureLocalInferenceHandler },
      services,
    ] = await Promise.all([
      import("@elizaos/plugin-local-inference"),
      import("@elizaos/plugin-local-inference/runtime"),
      import("@elizaos/plugin-local-inference/services"),
    ]);
    const asrBlockers = services.readBundleAsrProvenanceBlockers(bundle.root);
    if (!bundle.audioProjectorPath) {
      asrBlockers.unshift(
        `files.asr: ${path.join(bundle.root, "eliza-1.manifest.json")} has no staged ASR projector`,
      );
    }
    if (asrBlockers.length > 0) {
      throw new Error(
        `Live voice evidence requires a verified Gemma ASR bundle (#17477): ${asrBlockers.join("; ")}`,
      );
    }
    runtimeResult = await createRealTestRuntime({
      characterName: "DeviceE2EHostAgent",
      plugins: [localInferencePlugin, mediaRoutesPlugin],
      withLLM: true,
      preferredProvider: "cerebras",
    });
    if (
      runtimeResult.providerName !== "cerebras" ||
      runtimeResult.providerConfig?.smallModel !== LIVE_CEREBRAS_MODEL ||
      runtimeResult.providerConfig.largeModel !== LIVE_CEREBRAS_MODEL
    ) {
      throw new Error(
        `Live voice evidence requires Cerebras ${LIVE_CEREBRAS_MODEL}; resolved ${runtimeResult.providerName ?? "no provider"}/${runtimeResult.providerConfig?.smallModel ?? "no model"}.`,
      );
    }
    await services.localInferenceEngine.load(bundle.textModelPath, {
      modelPath: bundle.textModelPath,
      modelId: bundle.id,
      contextSize: 4_096,
      useGpu: true,
      ...(bundle.audioProjectorPath
        ? { mmprojPath: bundle.audioProjectorPath }
        : {}),
    });
    await ensureLocalInferenceHandler(runtimeResult.runtime);
    const localAsrReady =
      await services.localInferenceEngine.canTranscribeLocally();
    if (!localAsrReady) {
      throw new Error(
        "Live voice evidence requires local Gemma ASR readiness after bundle activation (#17477).",
      );
    }
    if (
      !runtimeResult.runtime.getModel(ModelType.TEXT_TO_SPEECH) ||
      !runtimeResult.runtime.getModel(ModelType.TRANSCRIPTION)
    ) {
      throw new Error("Local ASR/TTS model handlers were not registered.");
    }
    localVoiceCleanup = () => services.localInferenceEngine.unload();
    console.log(
      `[device-e2e-host-agent] model mode: cerebras/${LIVE_CEREBRAS_MODEL}; local voice bundle: ${bundle.id}; ASR ready: true`,
    );
  } else if (modelMode === "deterministic") {
    const proxy = createDeterministicLlmProxyPlugin({
      failOnUnhandledAction: false,
      stream: deterministicStream,
      resolve(call) {
        if (call.modelType !== ModelType.RESPONSE_HANDLER) return null;
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
    runtimeResult = await createRealTestRuntime({
      characterName: "DeviceE2EHostAgent",
      plugins: [proxy, mediaRoutesPlugin],
    });
    console.log("[device-e2e-host-agent] model mode: deterministic proxy");
  } else {
    throw new Error(`Unsupported ELIZA_DEVICE_E2E_MODEL_MODE: ${modelMode}`);
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
    await localVoiceCleanup?.().catch(() => undefined);
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
