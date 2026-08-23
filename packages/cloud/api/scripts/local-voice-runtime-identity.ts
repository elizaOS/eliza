/**
 * Binds the local voice gateway to one live loopback runtime, running agent,
 * and conversation before the gateway can create a realtime session. Runtime
 * responses and operator-provided identifiers are validated as untrusted
 * boundary data; conversations are scoped by the standalone runtime's
 * singleton `/api/agents` authority because the runtime conversation DTO does
 * not carry an agent identifier.
 */

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SHAPE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_IP_LITERALS = new Set(["127.0.0.1", "[::1]"]);
const MAX_RUNTIME_RESPONSE_BYTES = 1024 * 1024;
const MAX_RUNTIME_CONVERSATION_ID_LENGTH = 128;
// restoreConversationsFromDb bypasses the runtime's own
// evictOldestConversation(..., 500), so a legitimate list can exceed 500 and a
// cap at that number would refuse startup on a healthy host. This bound exists
// only to stop an unbounded response, not to express a product limit.
const MAX_RUNTIME_CONVERSATION_RECORDS = 2000;

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
  updatedAtEpochMs: number;
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

export type LocalVoiceRuntimeConversationAuthorizationResult =
  | "authorized"
  | "forbidden";

export interface AuthorizeLocalVoiceRuntimeConversationOptions {
  runtimeOrigin: string;
  agentId: string;
  conversationId: string;
  fetchImpl?: FetchLike;
}

export type LocalVoiceRuntimeIdentityErrorCode =
  | "conversation_not_found"
  | "runtime_unavailable";

export class LocalVoiceRuntimeIdentityError extends Error {
  readonly code: LocalVoiceRuntimeIdentityErrorCode;

  constructor(
    message: string,
    options?: ErrorOptions & { code?: LocalVoiceRuntimeIdentityErrorCode },
  ) {
    super(message, options);
    this.name = "LocalVoiceRuntimeIdentityError";
    this.code = options?.code ?? "runtime_unavailable";
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
    !LOOPBACK_IP_LITERALS.has(parsed.hostname) ||
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
  const configuredConversationId = readOptionalConversationId(
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
    configuredConversationId,
  );

  return { runtimeOrigin, agentId, conversationId };
}

/**
 * Proves a requested conversation against the current loopback runtime and
 * startup agent. Only a well-formed live listing that omits the conversation
 * is an authorization denial; transport, health, shape, and agent failures
 * remain availability errors so callers never misreport them as scope denial.
 */
export async function authorizeLocalVoiceRuntimeConversation(
  options: AuthorizeLocalVoiceRuntimeConversationOptions,
): Promise<LocalVoiceRuntimeConversationAuthorizationResult> {
  try {
    await resolveLocalVoiceRuntimeIdentity({
      runtimeOrigin: options.runtimeOrigin,
      configuredAgentId: options.agentId,
      configuredConversationId: options.conversationId,
      fetchImpl: options.fetchImpl,
    });
    return "authorized";
  } catch (error) {
    if (
      error instanceof LocalVoiceRuntimeIdentityError &&
      error.code === "conversation_not_found"
    ) {
      return "forbidden";
    }
    throw error;
  }
}

async function fetchJson(
  label: string,
  url: URL,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "error" });
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
  let rawBody: string;
  try {
    rawBody = await readBoundedResponseBody(label, response);
  } catch (error) {
    if (error instanceof LocalVoiceRuntimeIdentityError) throw error;
    // error-policy:J2 Response stream failures retain their transport cause
    // and cannot become a partially parsed runtime identity document.
    throw new LocalVoiceRuntimeIdentityError(
      `${label} response body could not be read`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    // error-policy:J3 Runtime JSON is untrusted input and malformed responses
    // fail explicitly instead of becoming an empty healthy identity list.
    throw new LocalVoiceRuntimeIdentityError(`${label} returned invalid JSON`, {
      cause: error,
    });
  }
}

async function readBoundedResponseBody(
  label: string,
  response: Response,
): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      Number.isFinite(parsedLength) &&
      parsedLength > MAX_RUNTIME_RESPONSE_BYTES
    ) {
      throw new LocalVoiceRuntimeIdentityError(
        `${label} exceeded the response size limit`,
      );
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_RUNTIME_RESPONSE_BYTES) {
      await reader.cancel();
      throw new LocalVoiceRuntimeIdentityError(
        `${label} exceeded the response size limit`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
  if (body.conversations.length > MAX_RUNTIME_CONVERSATION_RECORDS) {
    throw new LocalVoiceRuntimeIdentityError(
      "local conversations response exceeds the record limit",
    );
  }
  // Conversation ids are not UUIDs in general: restoreConversationsFromDb
  // derives one by stripping the "web-conv-" prefix off a persisted channel
  // id. Rejecting the whole listing because a single record has an unexpected
  // id would refuse startup on an ordinary host, so unreadable records are
  // skipped and the selected one is still validated strictly below.
  const parsed: RuntimeConversation[] = [];
  body.conversations.forEach((value, index) => {
    let record: Record<string, unknown>;
    try {
      record = readRecord(`local conversation ${index}`, value);
    } catch {
      // error-policy:J3 an unreadable record yields an explicit skip rather
      // than a fabricated conversation; the selection below fails closed if
      // nothing usable survives.
      return;
    }
    parsed.push({
      id: readCanonicalConversationId(
        `local conversation ${index} id`,
        record.id,
      ),
      updatedAtEpochMs: readCanonicalTimestamp(
        `local conversation ${index} updatedAt`,
        record.updatedAt,
      ),
    });
  });
  return parsed;
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
  configuredConversationId: string | undefined,
): string {
  if (configuredConversationId !== undefined) {
    const configured = conversations.find(
      (conversation) => conversation.id === configuredConversationId,
    );
    if (!configured) {
      throw new LocalVoiceRuntimeIdentityError(
        "configured local conversation does not exist in the runtime",
        { code: "conversation_not_found" },
      );
    }
    return configured.id;
  }

  const candidates = conversations.toSorted(
    (left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs,
  );
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

function readOptionalConversationId(
  label: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return readCanonicalConversationId(label, value);
}

function readCanonicalConversationId(label: string, value: unknown): string {
  const id = readRequiredString(label, value);
  if (
    id.length > MAX_RUNTIME_CONVERSATION_ID_LENGTH ||
    id.trim() !== id ||
    (UUID_SHAPE_PATTERN.test(id) && !CANONICAL_UUID_PATTERN.test(id))
  ) {
    throw new LocalVoiceRuntimeIdentityError(
      `${label} must be canonical and at most 128 characters`,
    );
  }
  return id;
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

function readCanonicalTimestamp(label: string, value: unknown): number {
  const timestamp = readRequiredString(label, value);
  const epochMs = Date.parse(timestamp);
  if (
    !Number.isFinite(epochMs) ||
    new Date(epochMs).toISOString() !== timestamp
  ) {
    throw new LocalVoiceRuntimeIdentityError(
      `${label} must be a canonical ISO timestamp`,
    );
  }
  return epochMs;
}
