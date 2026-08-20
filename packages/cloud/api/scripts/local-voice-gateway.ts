/**
 * Runs the real realtime voice-session stack on loopback for the web dev app.
 * Cartesia credentials stay in this server process; chat turns are bridged to
 * the already-running local elizaOS API rather than a second model runtime.
 */

const DEFAULT_RUNTIME_ORIGIN = "http://127.0.0.1:31337";
const DEFAULT_GATEWAY_PORT = 31_338;
const DEFAULT_CARTESIA_VOICE_ID = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
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

  const configuredAgentId = process.env.ELIZA_LOCAL_VOICE_AGENT_ID?.trim();
  let discoveredAgentId: string | undefined;
  if (!configuredAgentId) {
    const agentResponse = await fetch(new URL("/api/agents", runtimeOrigin));
    if (!agentResponse.ok) {
      throw new Error(
        `local agents route returned HTTP ${agentResponse.status}`,
      );
    }
    const agentsBody = (await agentResponse.json()) as {
      agents?: Array<{ id?: unknown; status?: unknown }>;
    };
    discoveredAgentId = agentsBody.agents?.find(
      (agent) => agent.status === "running" && typeof agent.id === "string",
    )?.id as string | undefined;
  }
  const agentId = assertUuid(
    "local agent id",
    configuredAgentId || discoveredAgentId || "",
  );

  const configuredConversationId =
    process.env.ELIZA_LOCAL_VOICE_CONVERSATION_ID?.trim();
  let discoveredConversationId: string | undefined;
  if (!configuredConversationId) {
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
    discoveredConversationId = conversationsBody.conversations
      ?.filter((conversation) => typeof conversation.id === "string")
      .sort((left, right) =>
        String(right.updatedAt ?? "").localeCompare(
          String(left.updatedAt ?? ""),
        ),
      )[0]?.id as string | undefined;
  }
  const conversationId = assertUuid(
    "local conversation id",
    configuredConversationId || discoveredConversationId || "",
  );

  return { agentId, conversationId };
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
  const { agentId, conversationId } = await readLocalIdentity(runtimeOrigin);
  const [{ createLocalRuntimeConversationFetch }, harness] = await Promise.all([
    import("../v1/voice/session/lib/local-runtime-conversation-fetch"),
    import("../v1/voice/session/lib/harness-real-server"),
  ]);

  await harness.installHarnessSigningKey();
  const server = await harness.startRealVoiceServer({
    cartesiaApiKey,
    cartesiaVoiceId,
    elizaEndpoint: runtimeOrigin,
    elizaAuthorization: "Bearer local-loopback-voice",
    organizationId: LOCAL_ORGANIZATION_ID,
    userId: LOCAL_USER_ID,
    agentId,
    conversationId,
    fetchImpl: createLocalRuntimeConversationFetch(runtimeOrigin),
    listenPort: gatewayPort,
    hooks: { log: writeLog },
  });

  writeLog("info", "Cartesia realtime voice gateway ready", {
    httpUrl: server.httpUrl,
    runtimeOrigin,
    agentId,
    providers: {
      stt: "cartesia/ink-2",
      llm: "local-runtime/cerebras",
      tts: "cartesia/sonic-3.5",
    },
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
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
