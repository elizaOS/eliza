/**
 * Binds the local voice gateway to one live loopback runtime, running agent,
 * and conversation before the gateway can create a realtime session. Runtime
 * responses and operator-provided identifiers are validated as untrusted
 * boundary data; a conversation without an explicit agent field is scoped by
 * the standalone runtime's singleton `/api/agents` authority.
 */

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface RuntimeAgent {
  id: string;
  status: string;
}

interface RuntimeConversation {
  id: string;
  updatedAt: string;
  agentId?: string;
}

export interface LocalVoiceRuntimeIdentity {
  runtimeOrigin: string;
  agentId: string;
  conversationId: string;
}

export interface ResolveLocalVoiceRuntimeIdentityOptions {
  runtimeOrigin: string;
  configuredAgentId?: string;
  configuredConversationId?: string;
  fetchImpl?: FetchLike;
}

export class LocalVoiceRuntimeIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalVoiceRuntimeIdentityError";
  }
}

export function resolveCanonicalLoopbackRuntimeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    // error-policy:J2 Startup retains the URL parser cause while failing before
    // any request can escape the local voice process.
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime origin is not a valid URL",
      { cause: error },
    );
  }

  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTNAMES.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime origin must be a canonical HTTP loopback origin",
    );
  }

  if (raw !== parsed.origin && raw !== `${parsed.origin}/`) {
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime origin must use its canonical serialized form",
    );
  }
  return parsed.origin;
}

export async function resolveLocalVoiceRuntimeIdentity(
  options: ResolveLocalVoiceRuntimeIdentityOptions,
): Promise<LocalVoiceRuntimeIdentity> {
  const runtimeOrigin = resolveCanonicalLoopbackRuntimeOrigin(
    options.runtimeOrigin,
  );
  const configuredAgentId = readOptionalCanonicalUuid(
    "configured local agent id",
    options.configuredAgentId,
  );
  const configuredConversationId = readOptionalCanonicalUuid(
    "configured local conversation id",
    options.configuredConversationId,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const health = readRecord(
    "local runtime health",
    await fetchJson(
      "local runtime health",
      new URL("/api/health", runtimeOrigin),
      fetchImpl,
    ),
  );
  if (health.ready !== true || health.canRespond !== true) {
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime is not ready to respond",
    );
  }

  const agents = readAgents(
    await fetchJson(
      "local agents route",
      new URL("/api/agents", runtimeOrigin),
      fetchImpl,
    ),
  );
  const agentId = selectAgentId(agents, configuredAgentId);

  const conversations = readConversations(
    await fetchJson(
      "local conversations route",
      new URL("/api/conversations", runtimeOrigin),
      fetchImpl,
    ),
  );
  const conversationId = selectConversationId(
    conversations,
    agentId,
    configuredConversationId,
  );

  return { runtimeOrigin, agentId, conversationId };
}

async function fetchJson(
  label: string,
  url: URL,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    // error-policy:J2 The process boundary needs the failed route and original
    // transport cause to diagnose an unavailable local runtime.
    throw new LocalVoiceRuntimeIdentityError(`${label} request failed`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new LocalVoiceRuntimeIdentityError(
      `${label} returned HTTP ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    // error-policy:J3 Runtime JSON is untrusted input and malformed responses
    // fail explicitly instead of becoming an empty healthy identity list.
    throw new LocalVoiceRuntimeIdentityError(`${label} returned invalid JSON`, {
      cause: error,
    });
  }
}

function readRecord(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalVoiceRuntimeIdentityError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readAgents(value: unknown): RuntimeAgent[] {
  const body = readRecord("local agents response", value);
  if (!Array.isArray(body.agents)) {
    throw new LocalVoiceRuntimeIdentityError(
      "local agents response must include an agents array",
    );
  }
  return body.agents.map((value, index) => {
    const record = readRecord(`local agent ${index}`, value);
    return {
      id: readCanonicalUuid(`local agent ${index} id`, record.id),
      status: readRequiredString(`local agent ${index} status`, record.status),
    };
  });
}

function readConversations(value: unknown): RuntimeConversation[] {
  const body = readRecord("local conversations response", value);
  if (!Array.isArray(body.conversations)) {
    throw new LocalVoiceRuntimeIdentityError(
      "local conversations response must include a conversations array",
    );
  }
  return body.conversations.map((value, index) => {
    const record = readRecord(`local conversation ${index}`, value);
    const agentId =
      record.agentId === undefined
        ? undefined
        : readCanonicalUuid(
            `local conversation ${index} agent id`,
            record.agentId,
          );
    return {
      id: readCanonicalUuid(`local conversation ${index} id`, record.id),
      updatedAt: readTimestamp(
        `local conversation ${index} updatedAt`,
        record.updatedAt,
      ),
      ...(agentId === undefined ? {} : { agentId }),
    };
  });
}

function selectAgentId(
  agents: RuntimeAgent[],
  configuredAgentId: string | undefined,
): string {
  if (agents.length !== 1) {
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime must expose exactly one agent",
    );
  }
  const agent = agents[0]!;
  if (configuredAgentId !== undefined && agent.id !== configuredAgentId) {
    throw new LocalVoiceRuntimeIdentityError(
      "configured local agent does not exist in the runtime",
    );
  }
  if (agent.status !== "running") {
    throw new LocalVoiceRuntimeIdentityError("local agent is not running");
  }
  return agent.id;
}

function selectConversationId(
  conversations: RuntimeConversation[],
  agentId: string,
  configuredConversationId: string | undefined,
): string {
  if (configuredConversationId !== undefined) {
    const configured = conversations.find(
      (conversation) => conversation.id === configuredConversationId,
    );
    if (!configured) {
      throw new LocalVoiceRuntimeIdentityError(
        "configured local conversation does not exist in the runtime",
      );
    }
    if (configured.agentId !== undefined && configured.agentId !== agentId) {
      throw new LocalVoiceRuntimeIdentityError(
        "configured local conversation belongs to a different agent",
      );
    }
    return configured.id;
  }

  const candidates = conversations
    .filter(
      (conversation) =>
        conversation.agentId === undefined || conversation.agentId === agentId,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (candidates.length === 0) {
    throw new LocalVoiceRuntimeIdentityError(
      "local runtime has no conversation for the running agent",
    );
  }
  return candidates[0]!.id;
}

function readOptionalCanonicalUuid(
  label: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return readCanonicalUuid(label, value);
}

function readCanonicalUuid(label: string, value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new LocalVoiceRuntimeIdentityError(
      `${label} must be a canonical lowercase UUID`,
    );
  }
  return value;
}

function readRequiredString(label: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new LocalVoiceRuntimeIdentityError(`${label} must be a string`);
  }
  return value;
}

function readTimestamp(label: string, value: unknown): string {
  const timestamp = readRequiredString(label, value);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new LocalVoiceRuntimeIdentityError(
      `${label} must be an ISO-compatible timestamp`,
    );
  }
  return timestamp;
}
