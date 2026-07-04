/**
 * Regression coverage for web-chat conversation creation role grants.
 *
 * The route must write world roles through the auditable grant helpers so every
 * role mutation pairs `metadata.roles[id]` with `metadata.roleSources[id]`.
 */

import crypto from "node:crypto";
import http from "node:http";
import { ChannelType, logger, stringToUuid, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "hello",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
    })),
  };
});

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    resolveAppUserName: () => "tester",
  };
});

import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { handleConversationRoutes } from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("agent-role-grant") as UUID;
const OWNER_ID = stringToUuid("owner-role-grant") as UUID;
const WAIFU_SECRET = "conversation-role-grant-secret";
const WAIFU_WALLET = "0x1111111111111111111111111111111111111111";

const priorWaifuSecret = process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;

beforeEach(() => {
  process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = WAIFU_SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
  if (priorWaifuSecret === undefined) {
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
  } else {
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = priorWaifuSecret;
  }
});

function signWaifuToken(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: Math.floor(Date.now() / 1000) + 60,
      role: "user",
      walletAddress: WAIFU_WALLET,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto
    .createHmac("sha256", WAIFU_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function createReq(token: string): http.IncomingMessage {
  return Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations",
    headers: {
      authorization: `Bearer ${token}`,
      host: "localhost",
    },
  }) as http.IncomingMessage;
}

function createState(): {
  state: ConversationRouteState;
  updateWorld: ReturnType<typeof vi.fn>;
} {
  const world = {
    id: stringToUuid("Test Agent-web-chat-world") as UUID,
    metadata: {},
  };
  const updateWorld = vi.fn(async () => undefined);
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Test Agent" },
    logger,
    ensureConnection: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => world),
    updateWorld,
    getRoom: vi.fn(async () => null),
    adapter: {},
  };
  return {
    state: {
      runtime: runtime as never,
      config: { user: { name: "tester" } } as never,
      agentName: "Test Agent",
      adminEntityId: OWNER_ID,
      chatUserId: OWNER_ID,
      logBuffer: [],
      conversations: new Map(),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    },
    updateWorld,
  };
}

function createCtx(state: ConversationRouteState): ConversationRouteContext {
  const token = signWaifuToken();
  return {
    req: createReq(token),
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/conversations",
    state,
    readJsonBody: vi.fn(async () => ({ title: "Role grant check" })),
    json: vi.fn(),
    error: vi.fn(),
  } as unknown as ConversationRouteContext;
}

describe("conversation role grants (#12087 Item 11)", () => {
  it("records owner and connector caller roleSources when creating a conversation", async () => {
    const { state, updateWorld } = createState();
    const ctx = createCtx(state);

    await handleConversationRoutes(ctx);

    expect(ctx.error).not.toHaveBeenCalled();
    expect(updateWorld).toHaveBeenCalledTimes(1);
    const updatedWorld = updateWorld.mock.calls[0]?.[0] as {
      metadata?: {
        roles?: Record<string, string>;
        roleSources?: Record<string, string>;
      };
    };
    const callerId = stringToUuid(`waifu-wallet:${WAIFU_WALLET}`);
    expect(updatedWorld.metadata?.roles?.[OWNER_ID]).toBe("OWNER");
    expect(updatedWorld.metadata?.roleSources?.[OWNER_ID]).toBe("owner");
    expect(updatedWorld.metadata?.roles?.[callerId]).toBe("USER");
    expect(updatedWorld.metadata?.roleSources?.[callerId]).toBe(
      "connector_admin",
    );
  });
});
