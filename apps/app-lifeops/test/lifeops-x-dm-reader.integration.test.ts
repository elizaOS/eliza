/**
 * Integration test: X DM reader via `x-dm-reader.ts`.
 *
 * Tests the typed X DM capability descriptor and `pullXInboundDms()` function.
 * This is a distinct channel from the X feed reader — DMs require separate
 * OAuth scopes and are an independent inbound path.
 *
 * Gating:
 * - Credential-independent tests (capability descriptor, env-reading) always run.
 * - Live API tests gate on all four `TWITTER_*` env vars being set.
 * - Set `SKIP_REASON` to skip all tests with a documented reason.
 *
 * No live credentials required for the majority of this suite — a mock server
 * covers the API call path.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import {
  X_DM_INBOUND_CAPABILITY,
  pullXInboundDms,
  readXDmCredentialsFromEnv,
  type XDmCapabilityDescriptor,
} from "../src/lifeops/x-dm-reader.js";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const HAS_X_CREDENTIALS = Boolean(
  process.env.TWITTER_API_KEY?.trim() &&
    process.env.TWITTER_API_SECRET?.trim() &&
    process.env.TWITTER_ACCESS_TOKEN?.trim() &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET?.trim(),
);
const LIVE_CREDS_AVAILABLE = !SKIP_REASON && HAS_X_CREDENTIALS;

// ---------------------------------------------------------------------------
// HTTP mock for the Twitter API v2 /dm_events endpoint
// ---------------------------------------------------------------------------

type MockServer = {
  close: () => Promise<void>;
  port: number;
  baseUrl: string;
};

function makeDmEventsResponse(
  events: Array<{
    id: string;
    sender_id: string;
    username: string;
    text: string;
    created_at: string;
    dm_conversation_id?: string;
  }>,
) {
  return {
    data: events.map((e) => ({
      id: e.id,
      event_type: "MessageCreate",
      text: e.text,
      sender_id: e.sender_id,
      dm_conversation_id: e.dm_conversation_id ?? `conv-${e.id}`,
      created_at: e.created_at,
    })),
    includes: {
      users: events.map((e) => ({
        id: e.sender_id,
        username: e.username,
      })),
    },
    meta: {
      result_count: events.length,
      next_token: null,
    },
  };
}

async function startMockXApi(
  response: ReturnType<typeof makeDmEventsResponse>,
  statusCode = 200,
): Promise<MockServer> {
  const server = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve mock port");
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withMockXBaseUrl(
  baseUrl: string,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env.MILADY_MOCK_X_BASE;
  process.env.MILADY_MOCK_X_BASE = baseUrl;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.MILADY_MOCK_X_BASE;
    else process.env.MILADY_MOCK_X_BASE = prev;
  });
}

// ---------------------------------------------------------------------------
// Tests: capability descriptor
// ---------------------------------------------------------------------------

describe("X_DM_INBOUND_CAPABILITY descriptor", () => {
  it("has channel: x_dm (distinct from x_feed)", () => {
    const cap: XDmCapabilityDescriptor = X_DM_INBOUND_CAPABILITY;
    expect(cap.channel).toBe("x_dm");
  });

  it("has direction: inbound", () => {
    expect(X_DM_INBOUND_CAPABILITY.direction).toBe("inbound");
  });

  it("has transport: api", () => {
    expect(X_DM_INBOUND_CAPABILITY.transport).toBe("api");
  });

  it("requires dm.read scope", () => {
    expect(X_DM_INBOUND_CAPABILITY.requiredScopes).toContain("dm.read");
  });

  it("lists all four TWITTER_* env vars as required", () => {
    const required = X_DM_INBOUND_CAPABILITY.requiredEnvVars;
    expect(required).toContain("TWITTER_API_KEY");
    expect(required).toContain("TWITTER_API_SECRET");
    expect(required).toContain("TWITTER_ACCESS_TOKEN");
    expect(required).toContain("TWITTER_ACCESS_TOKEN_SECRET");
  });

  it("maxPerPull is a positive number", () => {
    expect(X_DM_INBOUND_CAPABILITY.maxPerPull).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: readXDmCredentialsFromEnv
// ---------------------------------------------------------------------------

describe("readXDmCredentialsFromEnv", () => {
  let savedEnv: Partial<NodeJS.ProcessEnv>;

  beforeEach(() => {
    savedEnv = {
      TWITTER_API_KEY: process.env.TWITTER_API_KEY,
      TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
      TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
      TWITTER_ACCESS_TOKEN_SECRET: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      TWITTER_USER_ID: process.env.TWITTER_USER_ID,
    };
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_API_SECRET;
    delete process.env.TWITTER_ACCESS_TOKEN;
    delete process.env.TWITTER_ACCESS_TOKEN_SECRET;
    delete process.env.TWITTER_USER_ID;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns null when all vars are absent", () => {
    expect(readXDmCredentialsFromEnv({})).toBeNull();
  });

  it("returns null when any required var is missing", () => {
    const partial = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      // TWITTER_ACCESS_TOKEN_SECRET missing
    };
    expect(readXDmCredentialsFromEnv(partial)).toBeNull();
  });

  it("returns credentials when all required vars are set", () => {
    const env = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
    };
    const creds = readXDmCredentialsFromEnv(env);
    expect(creds).not.toBeNull();
    expect(creds?.apiKey).toBe("key");
    expect(creds?.apiSecret).toBe("secret");
    expect(creds?.accessToken).toBe("token");
    expect(creds?.accessTokenSecret).toBe("token_secret");
    expect(creds?.userId).toBeUndefined();
  });

  it("includes userId when TWITTER_USER_ID is set", () => {
    const env = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
      TWITTER_USER_ID: "12345",
    };
    const creds = readXDmCredentialsFromEnv(env);
    expect(creds?.userId).toBe("12345");
  });
});

// ---------------------------------------------------------------------------
// Tests: pullXInboundDms (mock server)
// ---------------------------------------------------------------------------

describe("pullXInboundDms (mock server)", () => {
  let mock: MockServer | undefined;
  let savedEnv: Partial<NodeJS.ProcessEnv>;

  beforeEach(() => {
    savedEnv = {
      TWITTER_API_KEY: process.env.TWITTER_API_KEY,
      TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
      TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
      TWITTER_ACCESS_TOKEN_SECRET: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      TWITTER_USER_ID: process.env.TWITTER_USER_ID,
      MILADY_MOCK_X_BASE: process.env.MILADY_MOCK_X_BASE,
    };
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns empty result with hasCredentials: false when creds are absent", async () => {
    const result = await pullXInboundDms({
      env: {}, // empty env — no credentials
    });
    expect(result.hasCredentials).toBe(false);
    expect(result.inbound).toEqual([]);
    expect(result.all).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns inbound DMs only when isInbound filtering applies", async () => {
    const selfUserId = "99999";
    const mockResponse = makeDmEventsResponse([
      {
        id: "dm001",
        sender_id: "11111", // someone else — inbound
        username: "alice",
        text: "Hey there",
        created_at: new Date().toISOString(),
        dm_conversation_id: "conv-001",
      },
      {
        id: "dm002",
        sender_id: selfUserId, // us — outbound
        username: "self",
        text: "Reply",
        created_at: new Date().toISOString(),
        dm_conversation_id: "conv-001",
      },
    ]);

    mock = await startMockXApi(mockResponse);

    const mockEnv = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
      TWITTER_USER_ID: selfUserId,
    };

    await withMockXBaseUrl(mock.baseUrl, async () => {
      const result = await pullXInboundDms({ env: mockEnv });
      expect(result.hasCredentials).toBe(true);
      expect(result.all).toHaveLength(2);
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].senderHandle).toBe("alice");
      expect(result.inbound[0].isInbound).toBe(true);
      expect(result.inbound[0].text).toBe("Hey there");
    });
  });

  it("returns all DMs when userId is not set (all treated as inbound)", async () => {
    const mockResponse = makeDmEventsResponse([
      {
        id: "dm003",
        sender_id: "22222",
        username: "bob",
        text: "Hello",
        created_at: new Date().toISOString(),
      },
    ]);

    mock = await startMockXApi(mockResponse);

    const mockEnv = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
      // No TWITTER_USER_ID — isInbound defaults to true
    };

    await withMockXBaseUrl(mock.baseUrl, async () => {
      const result = await pullXInboundDms({ env: mockEnv });
      expect(result.all).toHaveLength(1);
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].isInbound).toBe(true);
    });
  });

  it("XInboundDm objects have all required fields", async () => {
    const ts = new Date().toISOString();
    const mockResponse = makeDmEventsResponse([
      {
        id: "dm-shape",
        sender_id: "33333",
        username: "carol",
        text: "Shape test",
        created_at: ts,
        dm_conversation_id: "conv-shape",
      },
    ]);

    mock = await startMockXApi(mockResponse);

    const mockEnv = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
    };

    await withMockXBaseUrl(mock.baseUrl, async () => {
      const result = await pullXInboundDms({ env: mockEnv });
      expect(result.all).toHaveLength(1);
      const dm = result.all[0];
      expect(typeof dm.id).toBe("string");
      expect(typeof dm.externalDmId).toBe("string");
      expect(typeof dm.conversationId).toBe("string");
      expect(typeof dm.senderHandle).toBe("string");
      expect(typeof dm.senderId).toBe("string");
      expect(typeof dm.text).toBe("string");
      expect(typeof dm.receivedAt).toBe("string");
      expect(typeof dm.isInbound).toBe("boolean");
      expect(typeof dm.syncedAt).toBe("string");
      expect(typeof dm.metadata).toBe("object");
      expect(dm.externalDmId).toBe("dm-shape");
      expect(dm.conversationId).toBe("conv-shape");
      expect(dm.senderHandle).toBe("carol");
      expect(dm.text).toBe("Shape test");
    });
  });

  it("returns empty inbound + hasCredentials: true on rate-limit response", async () => {
    mock = await startMockXApi(
      { data: [], includes: { users: [] }, meta: { result_count: 0, next_token: null } },
      429,
    );

    const mockEnv = {
      TWITTER_API_KEY: "key",
      TWITTER_API_SECRET: "secret",
      TWITTER_ACCESS_TOKEN: "token",
      TWITTER_ACCESS_TOKEN_SECRET: "token_secret",
    };

    await withMockXBaseUrl(mock.baseUrl, async () => {
      const result = await pullXInboundDms({ env: mockEnv });
      expect(result.hasCredentials).toBe(true);
      expect(result.inbound).toEqual([]);
      expect(result.all).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: pullXInboundDms (live credentials)
// ---------------------------------------------------------------------------

describe("pullXInboundDms (live credentials)", () => {
  itIf(LIVE_CREDS_AVAILABLE)(
    "fetches inbound DMs from the X API",
    async () => {
      const result = await pullXInboundDms({ limit: 10 });
      expect(result.hasCredentials).toBe(true);
      expect(Array.isArray(result.inbound)).toBe(true);
      expect(Array.isArray(result.all)).toBe(true);
      for (const dm of result.inbound) {
        expect(dm.isInbound).toBe(true);
        expect(typeof dm.externalDmId).toBe("string");
        expect(typeof dm.text).toBe("string");
      }
    },
    30_000,
  );
});
