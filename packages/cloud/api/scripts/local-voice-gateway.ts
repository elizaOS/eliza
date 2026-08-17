/**
 * Runs the real realtime voice-session stack on loopback for the web dev app.
 * Cartesia credentials stay in this server process; chat turns are bridged to
 * the already-running local elizaOS API rather than a second model runtime.
 */

const DEFAULT_RUNTIME_ORIGIN = "http://127.0.0.1:31337";
const DEFAULT_GATEWAY_PORT = 31_338;
const LOCAL_VOICE_PREWARM_REFRESH_MS = 45_100;
const LOCAL_VOICE_PREWARM_STARTUP_ATTEMPTS = 3;
const LOCAL_VOICE_PREWARM_RETRY_MS = 250;
// Keep the zero-config local gateway aligned with the repo-root character used
// by this dev stack. Operators can still override it explicitly per process.
const DEFAULT_CARTESIA_VOICE_ID = "b9c387c8-2583-4b89-9a8e-be6699e38a23";
const LOCAL_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const LOCAL_USER_ID = "20000000-0000-4000-8000-000000000002";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

process.env.MOCK_REDIS ??= "1";
process.env.ENVIRONMENT ??= "local-voice-gateway";
process.env.VOICE_REALTIME_WS_ENABLED = "1";

function writeLog(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    scope: "LocalVoiceGateway",
    message,
    ...(data ? { data } : {}),
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer TCP port`);
  }
  return value;
}

function assertUuid(label: string, value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

async function readLocalIdentity(runtimeOrigin: string): Promise<{
  agentId: string;
  conversationId: string;
  runtimeModel: string;
}> {
  const healthResponse = await fetch(new URL("/api/health", runtimeOrigin));
  if (!healthResponse.ok) {
    throw new Error(
      `local runtime health returned HTTP ${healthResponse.status}`,
    );
  }
  const health = (await healthResponse.json()) as {
    ready?: unknown;
    canRespond?: unknown;
  };
  if (health.ready !== true || health.canRespond !== true) {
    throw new Error("local runtime is not ready to respond");
  }

  const statusResponse = await fetch(new URL("/api/status", runtimeOrigin));
  if (!statusResponse.ok) {
    throw new Error(
      `local runtime status returned HTTP ${statusResponse.status}`,
    );
  }
  const status = (await statusResponse.json()) as { model?: unknown };
  const runtimeModel =
    typeof status.model === "string" && status.model.trim()
      ? status.model.trim().slice(0, 128)
      : "unknown";

  const configuredAgentId = process.env.ELIZA_LOCAL_VOICE_AGENT_ID?.trim();
  const agentResponse = await fetch(new URL("/api/agents", runtimeOrigin));
  if (!agentResponse.ok) {
    throw new Error(`local agents route returned HTTP ${agentResponse.status}`);
  }
  const agentsBody = (await agentResponse.json()) as {
    agents?: Array<{ id?: unknown; status?: unknown }>;
  };
  const discoveredAgentId = agentsBody.agents?.find(
    (agent) => agent.status === "running" && typeof agent.id === "string",
  )?.id as string | undefined;
  const agentId = assertUuid(
    "local agent id",
    configuredAgentId || discoveredAgentId || "",
  );

  const configuredConversationId =
    process.env.ELIZA_LOCAL_VOICE_CONVERSATION_ID?.trim();
  const conversationResponse = await fetch(
    new URL("/api/conversations", runtimeOrigin),
  );
  if (!conversationResponse.ok) {
    throw new Error(
      `local conversations route returned HTTP ${conversationResponse.status}`,
    );
  }
  const conversationsBody = (await conversationResponse.json()) as {
    conversations?: Array<{ id?: unknown; updatedAt?: unknown }>;
  };
  const discoveredConversationId = conversationsBody.conversations
    ?.filter((conversation) => typeof conversation.id === "string")
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    )[0]?.id as string | undefined;
  const conversationId = assertUuid(
    "local conversation id",
    configuredConversationId || discoveredConversationId || "",
  );

  return { agentId, conversationId, runtimeModel };
}

async function main(): Promise<void> {
  const cartesiaApiKey = requiredSecret("CARTESIA_API_KEY");
  const runtimeOrigin =
    process.env.ELIZA_LOCAL_API_ORIGIN?.trim() || DEFAULT_RUNTIME_ORIGIN;
  const gatewayPort = readPort(
    "ELIZA_LOCAL_VOICE_GATEWAY_PORT",
    DEFAULT_GATEWAY_PORT,
  );
  const cartesiaVoiceId = assertUuid(
    "Cartesia voice id",
    process.env.VOICE_REALTIME_CARTESIA_VOICE_ID?.trim() ||
      DEFAULT_CARTESIA_VOICE_ID,
  );
  const { agentId, conversationId, runtimeModel } =
    await readLocalIdentity(runtimeOrigin);
  const [{ createLocalRuntimeConversationFetch }, harness] = await Promise.all([
    import("../v1/voice/session/lib/local-runtime-conversation-fetch"),
    import("../v1/voice/session/lib/harness-real-server"),
  ]);

  await harness.installHarnessSigningKey();
  const localRuntimeFetch = createLocalRuntimeConversationFetch(
    runtimeOrigin,
    fetch,
    // A genuinely cold Cloud admission path can legitimately outlive the
    // per-session hint deadline while its bounded 503 retries hydrate caches.
    // Gateway startup is the safe place to absorb that delay once.
    { prewarmTimeoutMs: 30_000 },
  );
  // Pay the provider/admission cold-start before the gateway advertises
  // readiness. Session.start() retains the same latency hint as a fallback,
  // but the runtime-side coalescer makes that call content-free and immediate
  // after this process-lifecycle warmup succeeds. This keeps the user's first
  // committed utterance from queueing behind a background model request.
  let inferencePrewarmed = false;
  for (
    let attempt = 1;
    attempt <= LOCAL_VOICE_PREWARM_STARTUP_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await localRuntimeFetch.prewarm();
      inferencePrewarmed = true;
      writeLog("info", "local voice inference prewarm complete", { attempt });
      break;
    } catch (error) {
      // error-policy:J7 prewarm is latency-only; the real turn retains its
      // typed provider retry/fallback path and the diagnostic stays
      // content-free. A warming 503 can outlive one model-handler retry budget,
      // so gateway startup makes a few bounded loopback attempts before it
      // advertises readiness.
      writeLog("warn", "local voice inference prewarm attempt unavailable", {
        attempt,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
      if (attempt < LOCAL_VOICE_PREWARM_STARTUP_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, LOCAL_VOICE_PREWARM_RETRY_MS),
        );
      }
    }
  }
  if (!inferencePrewarmed) {
    writeLog("warn", "local voice inference prewarm unavailable after retries");
  }
  const server = await harness.startRealVoiceServer({
    cartesiaApiKey,
    cartesiaVoiceId,
    elizaEndpoint: runtimeOrigin,
    elizaAuthorization: "Bearer local-loopback-voice",
    organizationId: LOCAL_ORGANIZATION_ID,
    userId: LOCAL_USER_ID,
    agentId,
    conversationId,
    fetchImpl: localRuntimeFetch,
    prewarmElizaContext: localRuntimeFetch.prewarm,
    listenPort: gatewayPort,
    hooks: { log: writeLog },
  });

  writeLog("info", "Cartesia realtime voice gateway ready", {
    httpUrl: server.httpUrl,
    runtimeOrigin,
    agentId,
    providers: {
      stt: "cartesia/ink-2",
      llm: `local-runtime/${runtimeModel}`,
      tts: "cartesia/sonic-3.5",
    },
  });

  // Keep the two Cloud inference admission lanes warm while this explicitly
  // local development gateway is running. The runtime-side lease coalesces
  // session starts, and this refresh lands just after that lease expires, so a
  // user pressing Talk never races two synthetic warmup generations beside the
  // real utterance. The timer is process-local and is stopped with the server.
  let stopping = false;
  let prewarmRefresh: ReturnType<typeof setTimeout> | undefined;
  const schedulePrewarmRefresh = () => {
    prewarmRefresh = setTimeout(async () => {
      try {
        await localRuntimeFetch.prewarm();
      } catch (error) {
        // error-policy:J7 refresh is latency-only and the real turn retains its
        // normal typed retry/fallback behavior.
        writeLog("warn", "local voice inference prewarm refresh unavailable", {
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        // Schedule from completion, not the preceding timer edge. A cold probe
        // can itself take seconds; setInterval then lands just inside the
        // runtime-side cooldown, skips that refresh, and leaves the Cloud auth
        // lease cold until the following interval. Completion-relative refresh
        // preserves one real warmup per lease without overlapping probes.
        if (!stopping) schedulePrewarmRefresh();
      }
    }, LOCAL_VOICE_PREWARM_REFRESH_MS);
    prewarmRefresh.unref();
  };
  schedulePrewarmRefresh();

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (prewarmRefresh) clearTimeout(prewarmRefresh);
    writeLog("info", "stopping local voice gateway", { signal });
    await server.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

void main().catch((error) => {
  // error-policy:J1 The CLI process boundary emits one structured failure and
  // exits non-zero; it never starts a partially configured voice gateway.
  writeLog("error", "local voice gateway failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
