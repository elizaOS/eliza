/**
 * Route-level guard for C8 (closing a DEFERRED gap from elizaOS/eliza#8434).
 *
 * The document-query-recovery LLM call (`recoverDocumentSearchQueriesWithLlm`
 * inside `maybeAugmentChatMessageWithDocuments`) is a full TEXT_LARGE round-trip
 * that runs BEFORE the chat reply is generated. It is meant to fire only when
 * the corpus returned sub-threshold candidates (documents exist, a better query
 * might surface them). On a plain non-document turn against an EMPTY corpus the
 * recovery call would be pure per-turn latency — and on hosts pinned to
 * zero/low-dim embeddings it would never match anything anyway.
 *
 * The helper-level gate is covered in `src/api/chat-augmentation.test.ts`.
 * What was missing — and what this test adds — is a guarantee at the REAL
 * message route: driving `POST /api/agents/:id/message` (the shared
 * `generateChatResponse` path) with a plain message and an empty documents
 * corpus must produce ZERO TEXT_LARGE recovery calls on that turn.
 *
 * Harness mirrors `test/api/agent-message-route.test.ts`: it invokes the actual
 * `handleConversationRouteGroup` dispatcher against a mock runtime whose
 * `useModel` is a spy and whose `documents` service returns an empty corpus.
 */

import http from "node:http";
import {
  type AgentRuntime,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleConversationRouteGroup } from "../../src/api/server-route-dispatch.ts";

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
  status: number;
  headers: Record<string, string>;
}

function createMockReq(
  method: string,
  pathname: string,
  body?: unknown,
): http.IncomingMessage {
  const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method,
    url: pathname,
    headers: {
      "content-type": "application/json",
      "content-length": String(payload.length),
    },
  });
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data") {
      if (payload.length > 0) {
        setImmediate(() => {
          listener(payload);
        });
      }
    } else if (event === "end") {
      setImmediate(() => listener());
    }
    return req;
  }) as never;
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    writes: [],
    ended: false,
    status: 200,
    headers: {},
  };
  const stub = {
    setHeader: vi.fn((key: string, value: string) => {
      record.headers[key.toLowerCase()] = value;
    }),
    getHeader: vi.fn((key: string) => record.headers[key.toLowerCase()]),
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      record.status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          record.headers[k.toLowerCase()] = v;
        }
      }
      return stub;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      record.writes.push(text);
      return true;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      if (chunk) {
        const text =
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        record.writes.push(text);
      }
      record.ended = true;
    }),
    statusCode: 200,
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res: stub, record };
}

function parseResponseBody(record: MockResponseRecord): unknown {
  if (!record.writes.length) return null;
  const joined = record.writes.join("");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

type MessageService = NonNullable<AgentRuntime["messageService"]>;

function createMessageService(reply: string): MessageService {
  return {
    async handleMessage(_runtime, _message, _callback, _options) {
      return {
        didRespond: true,
        responseContent: { text: reply },
        responseMessages: [
          { id: stringToUuid("reply-msg"), content: { text: reply } },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } as unknown as MessageService;
}

/** Empty-corpus documents service: every search returns no candidates. */
function createEmptyDocumentsService(): {
  searchDocuments: ReturnType<typeof vi.fn>;
} {
  return {
    searchDocuments: vi.fn(async () => []),
  };
}

function createRuntime(
  agentId: UUID,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  const runtime = {
    agentId,
    character: { name: "Eliza", settings: {} },
    plugins: [],
    actions: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
    getService: vi.fn(() => null),
    getServiceLoadPromise: vi.fn(async () => undefined),
    getServicesByType: vi.fn(() => []),
    emitEvent: vi.fn(async () => undefined),
    drainChatPreHandlers: vi.fn(async () => null),
    useModel: vi.fn(async () => ""),
    ...overrides,
  };
  return runtime as unknown as AgentRuntime;
}

function createCtx(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  runtime: AgentRuntime | null;
}) {
  const req = createMockReq(opts.method, opts.pathname, opts.body);
  const { res, record } = createMockRes();
  const json = (
    response: http.ServerResponse,
    data: unknown,
    status?: number,
  ) => {
    if (status !== undefined) record.status = status;
    response.write(JSON.stringify(data));
    response.end();
  };
  const error = (response: http.ServerResponse, msg: string, status = 500) => {
    record.status = status;
    response.write(JSON.stringify({ error: msg }));
    response.end();
  };
  const readJsonBody = async <T extends object>(
    request: http.IncomingMessage,
  ): Promise<T | null> => {
    return await new Promise<T | null>((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (!text) return resolve(null);
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          resolve(null);
        }
      });
    });
  };

  const state = {
    runtime: opts.runtime,
    config: { user: { name: "tester" } },
    agentName: opts.runtime?.character.name ?? "Eliza",
    adminEntityId: stringToUuid("admin-entity-id") as UUID,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    logBuffer: [],
    conversations: new Map(),
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };

  return {
    record,
    invoke: () =>
      handleConversationRouteGroup({
        req,
        res,
        method: opts.method,
        pathname: opts.pathname,
        url: new URL(`http://localhost${opts.pathname}`),
        state: state as never,
        json,
        error,
        readJsonBody: readJsonBody as never,
      }),
  };
}

/** Recovery calls always use TEXT_LARGE (CHAT_DOCUMENTS_RECOVERY_MODEL). */
function textLargeRecoveryCalls(
  useModel: ReturnType<typeof vi.fn>,
): unknown[][] {
  return useModel.mock.calls.filter(
    (call) => call[0] === ModelType.TEXT_LARGE || call[0] === "TEXT_LARGE",
  );
}

describe("document-query-recovery is skipped on a plain turn through the message route (C8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZA_DOCUMENT_AUGMENTATION_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds ZERO TEXT_LARGE recovery calls for a non-document message with an empty corpus", async () => {
    const agentId = stringToUuid("recovery-guard-agent") as UUID;
    const documents = createEmptyDocumentsService();
    const useModel = vi.fn(async () => "");
    const runtime = createRuntime(agentId, {
      messageService: createMessageService("just here, ready to help"),
      getService: vi.fn((name: string) =>
        name === "documents" ? documents : null,
      ) as never,
      useModel: useModel as never,
    });

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      // A plain, non-document conversational turn — no codeword / "uploaded
      // file" / document phrasing that the corpus could ever answer.
      body: { userId: "user-1", text: "what are you up to?" },
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(200);

    const body = parseResponseBody(record) as { response?: string };
    expect(body.response).toBe("just here, ready to help");

    // The augmentation ran on this turn (the corpus was searched at least once)
    // — proving the assertion below is about the recovery gate, not about the
    // augmentation being skipped wholesale.
    expect(documents.searchDocuments).toHaveBeenCalled();

    // The crux: an empty corpus must NOT trigger the recovery TEXT_LARGE call.
    // No TEXT_LARGE useModel call may originate from the augmentation path on a
    // plain turn — that round-trip is pure pre-reply latency here.
    expect(textLargeRecoveryCalls(useModel)).toHaveLength(0);
  });

  it("DOES fire exactly one TEXT_LARGE recovery call when the corpus returns a sub-threshold candidate (negative control)", async () => {
    // Proves the zero-call assertions above are not vacuous: when documents
    // exist but the top candidate falls below the relevance threshold, the
    // recovery TEXT_LARGE round-trip is the intended behaviour and the spy
    // filter detects it through the same route path.
    const agentId = stringToUuid("recovery-fires-agent") as UUID;
    const documents = {
      // First search (raw user prompt) returns a sub-threshold candidate;
      // documents clearly exist, so recovery is warranted. Recovered-query
      // searches return nothing, so the turn still falls through to a reply.
      searchDocuments: vi
        .fn()
        .mockResolvedValueOnce([
          {
            content: { text: "loosely related" },
            similarity: 0.05,
            metadata: {},
          },
        ])
        .mockResolvedValue([]),
    };
    // Recovery model returns a parseable queries JSON so the recovered-query
    // searches run; none clear the threshold, so the message passes through.
    const useModel = vi.fn(async () => JSON.stringify({ queries: ["x"] }));
    const runtime = createRuntime(agentId, {
      messageService: createMessageService("ok"),
      getService: vi.fn((name: string) =>
        name === "documents" ? documents : null,
      ) as never,
      useModel: useModel as never,
    });

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-3", text: "what is the codeword?" },
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(200);
    expect(textLargeRecoveryCalls(useModel)).toHaveLength(1);
    expect(textLargeRecoveryCalls(useModel)[0][1]).toMatchObject({
      responseFormat: { type: "json_object" },
    });
  });

  it("does not call useModel at all from augmentation when the documents service is absent", async () => {
    // The no-documents-service host (e.g. mobile without the documents plugin):
    // augmentation returns early, so there is likewise no recovery model call.
    const agentId = stringToUuid("no-docs-agent") as UUID;
    const useModel = vi.fn(async () => "");
    const runtime = createRuntime(agentId, {
      messageService: createMessageService("hi there"),
      // getService returns null for "documents" → getDocumentsService resolves
      // to no service; default getServiceLoadPromise resolves undefined.
      useModel: useModel as never,
    });

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-2", text: "how are you today?" },
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(200);
    expect(textLargeRecoveryCalls(useModel)).toHaveLength(0);
  });
});
