// === Phase 5D: extracted from packages/app/src/main.tsx ===
// iOS full-Bun smoke harness: when the host build sets the smoke-request
// flag in localStorage / Capacitor Preferences, this module boots the
// in-process ElizaBunRuntime, drives a sequence of WebView-fetch and direct
// bridge probes against the local agent, and persists the result back into
// Preferences so the simulator host can read it. The probe runs once per
// page load and is a no-op when the flag is absent.
import { Preferences } from "@capacitor/preferences";
import { primeIosFullBunRuntime } from "@elizaos/ui";

export const IOS_FULL_BUN_SMOKE_REQUEST_KEY =
  "eliza:ios-full-bun-smoke:request";
export const IOS_FULL_BUN_SMOKE_RESULT_KEY = "eliza:ios-full-bun-smoke:result";

const IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS = 300_000;
const IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS = 600_000;
const IOS_FULL_BUN_SMOKE_CHAT_TEXT =
  "In one short sentence, confirm the iOS full Bun local backend is running.";

declare global {
  interface Window {
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (event: Record<string, unknown>) => void;
  }
}

let iosFullBunSmokeStarted = false;

function hasIosLocalAgentNativeRequest(): boolean {
  return (
    typeof (
      window as Window & {
        __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: unknown;
      }
    ).__ELIZA_IOS_LOCAL_AGENT_REQUEST__ === "function"
  );
}

async function writeIosFullBunSmokeResult(
  result: Record<string, unknown>,
): Promise<void> {
  const value = JSON.stringify({
    ...result,
    updatedAt: new Date().toISOString(),
  });
  try {
    Storage.prototype.setItem.call(
      window.localStorage,
      IOS_FULL_BUN_SMOKE_RESULT_KEY,
      value,
    );
  } catch {
    // Ignore localStorage failures; Preferences is the simulator harness source of truth.
  }
  await boundedPreferenceWrite(() =>
    Preferences.set({
      key: IOS_FULL_BUN_SMOKE_RESULT_KEY,
      value,
    }),
  );
}

async function boundedPreferenceWrite(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await Promise.race([
      operation(),
      new Promise((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
  } catch {
    // The storage bridge also issued a fire-and-forget Preferences write from
    // localStorage.setItem. The simulator smoke will keep polling the native
    // defaults domain, but the WebView must not block forever on persistence.
  }
}

async function boundedPreferenceGet(key: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      Preferences.get({ key }),
      new Promise<null>((resolve) => window.setTimeout(resolve, 2_000)),
    ]);
    return result?.value ?? null;
  } catch {
    return null;
  }
}

function renderIosFullBunSmokeStatus(message: string): void {
  try {
    document.body.innerHTML = "";
    const container = document.createElement("main");
    container.style.cssText =
      "min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f8fa;color:#101114;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;text-align:center;";
    const text = document.createElement("div");
    text.style.cssText = "max-width:360px;font-size:16px;line-height:1.45;";
    text.textContent = message;
    container.appendChild(text);
    document.body.appendChild(container);
  } catch {
    // Smoke diagnostics are best-effort.
  }
}

async function fetchIosFullBunSmokeJson<T>(
  label: string,
  path: string,
  init?: RequestInit,
  timeoutMs = IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  let status: number | undefined;
  let text: string | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  await Promise.race([
    (async () => {
      const response = await fetch(path, { ...init, headers });
      status = response.status;
      text = await response.text();
    })(),
    timeout,
  ]);
  if (typeof status !== "number" || typeof text !== "string") {
    throw new Error(`${label} did not return a complete response`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function fetchIosFullBunSmokeText(
  label: string,
  path: string,
  init?: RequestInit,
  timeoutMs = IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
): Promise<string> {
  const headers = new Headers(init?.headers);
  let status: number | undefined;
  let text: string | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  await Promise.race([
    (async () => {
      const response = await fetch(path, { ...init, headers });
      status = response.status;
      text = await response.text();
    })(),
    timeout,
  ]);
  if (typeof status !== "number" || typeof text !== "string") {
    throw new Error(`${label} did not return a complete response`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${text.slice(0, 500)}`);
  }
  return text;
}

function parseIosFullBunSmokeHttpJson<T>(label: string, value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  const response = value as { status?: unknown; body?: unknown };
  const status = typeof response.status === "number" ? response.status : 0;
  const body = typeof response.body === "string" ? response.body : "";
  if (status < 200 || status >= 300) {
    throw new Error(`${label} returned HTTP ${status}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertSmokeObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function assertSmokeArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} did not return an array`);
  }
  return value;
}

async function withIosFullBunSmokeTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      window.setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

/**
 * If the host has requested the iOS full-Bun smoke (via localStorage or
 * Capacitor Preferences), boot the in-process Bun runtime and drive the
 * canonical probe sequence. Returns true when the smoke ran (whether it
 * passed or failed) so the caller can short-circuit the normal React boot.
 */
export async function runIosFullBunSmokeIfRequested(): Promise<boolean> {
  if (iosFullBunSmokeStarted) return true;
  let requested = false;
  try {
    requested =
      window.localStorage.getItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY) === "1";
  } catch {
    requested = false;
  }
  try {
    if (!requested) {
      requested =
        (await boundedPreferenceGet(IOS_FULL_BUN_SMOKE_REQUEST_KEY)) === "1";
    }
  } catch {
    // Keep the localStorage result from the storage bridge hydration.
  }
  if (!requested) return false;
  iosFullBunSmokeStarted = true;
  try {
    window.localStorage.setItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY, "1");
  } catch {
    // Preferences can request the smoke before localStorage is hydrated.
  }
  renderIosFullBunSmokeStatus("Running iOS full Bun backend smoke...");
  window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__ = (event) => {
    void writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      ...event,
    });
  };

  await writeIosFullBunSmokeResult({
    ok: false,
    phase: "running",
    startedAt: new Date().toISOString(),
  });

  try {
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "bridge-installed",
      hasNativeRequest: hasIosLocalAgentNativeRequest(),
    });

    const { ElizaBunRuntime } = await import("@elizaos/capacitor-bun-runtime");
    primeIosFullBunRuntime(ElizaBunRuntime);
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "plugin-imported",
      hasNativeRequest: hasIosLocalAgentNativeRequest(),
    });

    const started = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.start",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.start({
        engine: "bun",
        argv: [
          "bun",
          "--no-install",
          "public/agent/agent-bundle.js",
          "ios-bridge",
          "--stdio",
        ],
        env: {
          ELIZA_PLATFORM: "ios",
          ELIZA_MOBILE_PLATFORM: "ios",
          ELIZA_IOS_LOCAL_BACKEND: "1",
          ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS: "300000",
          ELIZA_IOS_FULL_BUN_SMOKE: "1",
          ELIZA_PGLITE_DISABLE_EXTENSIONS: "0",
          ELIZA_VAULT_BACKEND: "file",
          ELIZA_DISABLE_VAULT_PROFILE_RESOLVER: "1",
          ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP: "1",
          ELIZA_HEADLESS: "1",
          ELIZA_IOS_BRIDGE_TRANSPORT: "bun-host-ipc",
          LOG_LEVEL: "error",
        },
      }),
    );
    if (!started.ok) {
      throw new Error(
        started.error ?? "ElizaBunRuntime.start returned ok=false",
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "runtime-started",
      start: started,
    });

    const status = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.getStatus",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.getStatus(),
    );
    if (!status.ready || status.engine !== "bun") {
      throw new Error(
        `ElizaBunRuntime status was ready=${String(status.ready)} engine=${status.engine ?? "unknown"}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "status-ok",
      runtimeStatus: status,
    });

    const bridgeStatus = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.call(status)",
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
      ElizaBunRuntime.call({
        method: "status",
        args: { timeoutMs: 120_000 },
      }),
    );

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "bridge-status-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
    });

    const directHealthResponse = await withIosFullBunSmokeTimeout(
      "ElizaBunRuntime.call(http_request /api/health)",
      60_000,
      ElizaBunRuntime.call({
        method: "http_request",
        args: {
          method: "GET",
          path: "/api/health",
          headers: { accept: "application/json" },
          timeoutMs: 60_000,
        },
      }),
    );
    const directHealth = parseIosFullBunSmokeHttpJson<{
      ready?: unknown;
      runtime?: unknown;
    }>("Direct full Bun bridge /api/health", directHealthResponse.result);
    if (directHealth.ready !== true || directHealth.runtime !== "ok") {
      throw new Error(
        `Direct full Bun bridge /api/health returned unexpected body: ${JSON.stringify(directHealth)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "direct-health-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      directHealth,
    });

    const fetchHealth = await fetchIosFullBunSmokeJson<{
      ready?: unknown;
      runtime?: unknown;
    }>("WebView fetch bridge /api/health", "/api/health");
    if (fetchHealth.ready !== true || fetchHealth.runtime !== "ok") {
      throw new Error(
        `WebView fetch bridge /api/health returned unexpected body: ${JSON.stringify(fetchHealth)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "health-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
    });

    const localInferenceHub = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/hub",
      "/api/local-inference/hub",
      undefined,
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
    );
    assertSmokeArray(localInferenceHub.catalog, "local-inference hub catalog");
    const hubInstalled = assertSmokeArray(
      localInferenceHub.installed,
      "local-inference hub installed",
    );
    assertSmokeObject(localInferenceHub.active, "local-inference hub active");
    assertSmokeObject(
      localInferenceHub.assignments,
      "local-inference hub assignments",
    );

    const localInferenceProviders = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/providers",
      "/api/local-inference/providers",
    );
    const providerList = assertSmokeArray(
      localInferenceProviders.providers,
      "local-inference providers",
    );
    const capacitorProvider = providerList
      .map((provider) =>
        assertSmokeObject(provider, "local-inference provider"),
      )
      .find((provider) => provider.id === "capacitor-llama");
    if (!capacitorProvider) {
      throw new Error(
        "local-inference providers did not include capacitor-llama",
      );
    }
    const slots = assertSmokeArray(
      capacitorProvider.registeredSlots,
      "capacitor-llama registeredSlots",
    );
    if (!slots.includes("TEXT_SMALL") || !slots.includes("TEXT_LARGE")) {
      throw new Error("capacitor-llama did not register TEXT_SMALL/TEXT_LARGE");
    }

    const localInferenceDevice = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge /api/local-inference/device",
      "/api/local-inference/device",
      undefined,
      30_000,
    );
    if (
      localInferenceDevice.enabled !== true ||
      localInferenceDevice.connected !== true ||
      localInferenceDevice.transport !== "bun-host-ipc"
    ) {
      throw new Error(
        `local-inference native bridge returned unexpected status: ${JSON.stringify(localInferenceDevice)}`,
      );
    }
    assertSmokeArray(
      localInferenceDevice.devices,
      "local-inference device list",
    );

    if (hubInstalled.length === 0) {
      throw new Error(
        "local-inference hub had no installed Qwen3.5 GGUF model; full-Bun smoke requires a staged local model",
      );
    }

    const firstInstalled = assertSmokeObject(
      hubInstalled[0],
      "local-inference installed model",
    );
    if (typeof firstInstalled.id !== "string" || !firstInstalled.id) {
      throw new Error("local-inference installed model was missing id");
    }
    const activatedModel = await fetchIosFullBunSmokeJson<
      Record<string, unknown>
    >(
      "WebView fetch bridge POST /api/local-inference/active",
      "/api/local-inference/active",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ modelId: firstInstalled.id }),
      },
      IOS_FULL_BUN_SMOKE_ROUTE_TIMEOUT_MS,
    );
    if (
      activatedModel.status !== "ready" ||
      typeof activatedModel.modelPath !== "string" ||
      !activatedModel.modelPath
    ) {
      throw new Error(
        `local-inference active model did not become ready: ${JSON.stringify(activatedModel)}`,
      );
    }

    const [
      localInferenceActive,
      localInferenceInstalled,
      localInferenceRouting,
    ] = await Promise.all([
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/active",
        "/api/local-inference/active",
      ),
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/installed",
        "/api/local-inference/installed",
      ),
      fetchIosFullBunSmokeJson<Record<string, unknown>>(
        "WebView fetch bridge /api/local-inference/routing",
        "/api/local-inference/routing",
      ),
    ]);
    assertSmokeArray(
      localInferenceInstalled.models,
      "local-inference installed models",
    );
    assertSmokeArray(
      localInferenceRouting.registrations,
      "local-inference routing registrations",
    );
    assertSmokeObject(
      localInferenceRouting.preferences,
      "local-inference routing preferences",
    );

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "local-inference-ok",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      directHealth,
      fetchHealth,
      localInference: {
        hub: localInferenceHub,
        providers: localInferenceProviders,
        device: localInferenceDevice,
        activatedModel,
        active: localInferenceActive,
        installed: localInferenceInstalled,
        routing: localInferenceRouting,
      },
    });

    const created = await fetchIosFullBunSmokeJson<{
      conversation?: { id?: unknown };
    }>("WebView fetch bridge POST /api/conversations", "/api/conversations", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "iOS Full Bun Smoke" }),
    });
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId) {
      throw new Error("full Bun conversation create did not return an id");
    }

    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "running",
      step: "conversation-created",
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
      conversationId,
    });

    const sendMessage = await fetchIosFullBunSmokeJson<Record<string, unknown>>(
      "WebView fetch bridge POST /api/conversations/:id/messages",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: IOS_FULL_BUN_SMOKE_CHAT_TEXT,
          channelType: "DM",
          source: "ios-local",
          metadata: { smoke: "ios-full-bun" },
        }),
      },
      IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS,
    );
    const streamMessage = await fetchIosFullBunSmokeText(
      "WebView fetch bridge POST /api/conversations/:id/messages/stream",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: IOS_FULL_BUN_SMOKE_CHAT_TEXT,
          channelType: "DM",
          source: "ios-local",
          metadata: { smoke: "ios-full-bun-stream" },
        }),
      },
      IOS_FULL_BUN_SMOKE_MESSAGE_TIMEOUT_MS,
    );
    if (
      !streamMessage.includes('"type":"done"') ||
      /something went wrong|<think\b|<\/think>|\/?\bno_think\b/i.test(
        streamMessage,
      )
    ) {
      throw new Error(
        `full Bun conversation stream returned unusable SSE: ${streamMessage.slice(0, 500)}`,
      );
    }

    await writeIosFullBunSmokeResult({
      ok: true,
      phase: "complete",
      finishedAt: new Date().toISOString(),
      runtimeStatus: status,
      bridgeStatus: bridgeStatus.result,
      fetchHealth,
      localInference: {
        hub: localInferenceHub,
        providers: localInferenceProviders,
        device: localInferenceDevice,
        activatedModel,
        active: localInferenceActive,
        installed: localInferenceInstalled,
        routing: localInferenceRouting,
      },
      conversationId,
      sendMessage,
      streamMessage,
    });
  } catch (error) {
    await writeIosFullBunSmokeResult({
      ok: false,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    delete window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__;
    try {
      window.localStorage.removeItem(IOS_FULL_BUN_SMOKE_REQUEST_KEY);
    } catch {
      // Ignore localStorage failures; Preferences removal below is authoritative.
    }
    await boundedPreferenceWrite(() =>
      Preferences.remove({ key: IOS_FULL_BUN_SMOKE_REQUEST_KEY }),
    );
  }
  return true;
}
