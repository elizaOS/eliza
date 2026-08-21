// @vitest-environment jsdom

/**
 * Exercises the Play-safe Cloud transport with deterministic HTTP responses,
 * including authority, session, transcript, logout, and malformed-body cases.
 */

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AndroidCloudClient,
  resolveAndroidCloudChatAuthority,
} from "./android-cloud-client";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const PERSONAL_ID = "personal:org-1:user-1";
const RUNTIME_ID = "30000000-0000-4000-8000-000000000003";
const RUNTIME_BASE = `https://${RUNTIME_ID}.cloud.eliza.app`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AndroidCloudClient", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("pins configuration to an official Cloud authority", () => {
    expect(
      new AndroidCloudClient({ cloudApiBase: "https://attacker.example" })
        .apiBase,
    ).toBe("https://api.eliza.app");
  });

  it("accepts only the canonical API or UUID-shaped managed runtime hosts", () => {
    expect(
      resolveAndroidCloudChatAuthority(
        `https://api.eliza.app/api/v1/eliza/agents/${ACCOUNT_ID}`,
        ACCOUNT_ID,
      ),
    ).toBe(`https://api.eliza.app/api/v1/eliza/agents/${ACCOUNT_ID}`);
    expect(resolveAndroidCloudChatAuthority(RUNTIME_BASE)).toBe(RUNTIME_BASE);
    expect(() =>
      resolveAndroidCloudChatAuthority(`${RUNTIME_BASE}/api`),
    ).toThrow("untrusted chat authority");
    expect(() =>
      resolveAndroidCloudChatAuthority("https://not-a-uuid.cloud.eliza.app"),
    ).toThrow("untrusted chat authority");
    expect(() =>
      resolveAndroidCloudChatAuthority("http://api.eliza.app"),
    ).toThrow("untrusted chat authority");
  });

  it("creates and completes the bounded external sign-in contract", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(SESSION_ID);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { sessionId: SESSION_ID }))
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "steward-token" }),
      );
    const client = new AndroidCloudClient({ fetchImpl });

    const attempt = await client.beginLogin();
    expect(attempt).toEqual({
      sessionId: SESSION_ID,
      browserUrl: `https://cloud.eliza.app/auth/cli-login?session=${SESSION_ID}`,
    });
    await expect(client.pollLogin(SESSION_ID)).resolves.toEqual({
      status: "authenticated",
      token: "steward-token",
    });
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("steward-token");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.eliza.app/api/auth/cli-session",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("clears a token when sign-in is cancelled during durable persistence", async () => {
    let storedToken: string | null = null;
    let releaseWrite: () => void = () => {};
    const writeWait = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        await writeWait;
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        storedToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "cancelled-token" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });
    const controller = new AbortController();

    const poll = client.pollLogin(SESSION_ID, controller.signal);
    await vi.waitFor(() =>
      expect(credentialStore.write).toHaveBeenCalledOnce(),
    );
    controller.abort();
    releaseWrite();

    await expect(poll).rejects.toMatchObject({ name: "AbortError" });
    expect(credentialStore.clear).toHaveBeenCalledOnce();
    expect(storedToken).toBeNull();
  });

  it("clears a current attempt without depending on a secure-store read", async () => {
    let storedToken: string | null = null;
    let rejectReads = true;
    const credentialStore = {
      read: vi.fn(async () => {
        if (rejectReads) throw new Error("secure read unavailable");
        return storedToken;
      }),
      write: vi.fn(async (token: string) => {
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        storedToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "cancelled-token" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin(SESSION_ID);
    await client.discardLoginAttempt(SESSION_ID, "cancelled-token");

    expect(credentialStore.read).not.toHaveBeenCalled();
    expect(credentialStore.clear).toHaveBeenCalledOnce();
    rejectReads = false;
    const restarted = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    await expect(restarted.restoreSession()).resolves.toBeNull();
  });

  it("writes a non-authenticating tombstone when secure clear rejects", async () => {
    let storedToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        throw new Error("secure clear unavailable");
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "cancelled-token" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin(SESSION_ID);
    await client.discardLoginAttempt(SESSION_ID, "cancelled-token");

    expect(credentialStore.clear).toHaveBeenCalledOnce();
    expect(storedToken).not.toBe("cancelled-token");
    const restarted = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    await expect(restarted.restoreSession()).resolves.toBeNull();
  });

  it("retains attempt ownership when secure clear and tombstone both fail", async () => {
    let storedToken: string | null = null;
    let rejectTombstone = true;
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        if (token !== "cancelled-token" && rejectTombstone) {
          throw new Error("secure tombstone unavailable");
        }
        storedToken = token;
      }),
      clear: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("secure clear unavailable"))
        .mockImplementation(async () => {
          storedToken = null;
        }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "cancelled-token" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin(SESSION_ID);
    await expect(
      client.discardLoginAttempt(SESSION_ID, "cancelled-token"),
    ).rejects.toThrow("could not be removed");
    expect(storedToken).toBe("cancelled-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    rejectTombstone = false;
    await client.discardLoginAttempt(SESSION_ID, "cancelled-token");
    expect(storedToken).toBeNull();
    expect(credentialStore.clear).toHaveBeenCalledTimes(2);
    const restarted = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    await expect(restarted.restoreSession()).resolves.toBeNull();
  });

  it("does not revoke or clear a newer login when stale cleanup finishes last", async () => {
    let storedToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        storedToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "shared-token" }),
      )
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "shared-token" }),
      );
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin("10000000-0000-4000-8000-000000000001");
    await client.pollLogin("10000000-0000-4000-8000-000000000002");
    await client.discardLoginAttempt(
      "10000000-0000-4000-8000-000000000001",
      "shared-token",
    );

    expect(storedToken).toBe("shared-token");
    expect(credentialStore.clear).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("revokes a distinct stale bearer without clearing the newer login", async () => {
    let storedToken: string | null = null;
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        storedToken = null;
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "stale-token" }),
      )
      .mockResolvedValueOnce(
        json(200, { status: "authenticated", apiKey: "newer-token" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin("10000000-0000-4000-8000-000000000001");
    await client.pollLogin("10000000-0000-4000-8000-000000000002");
    await client.discardLoginAttempt(
      "10000000-0000-4000-8000-000000000001",
      "stale-token",
    );

    expect(storedToken).toBe("newer-token");
    expect(credentialStore.clear).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://api.eliza.app/api/auth/cli-session/10000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer stale-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not hold the credential queue while stale remote revocation is pending", async () => {
    let storedToken: string | null = null;
    let finishRevocation: () => void = () => {};
    const revocation = new Promise<Response>((resolve) => {
      finishRevocation = () => resolve(new Response(null, { status: 204 }));
    });
    const firstSession = "10000000-0000-4000-8000-000000000001";
    const secondSession = "10000000-0000-4000-8000-000000000002";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") return revocation;
      if (url.endsWith(firstSession)) {
        return json(200, { status: "authenticated", apiKey: "stale-token" });
      }
      return json(200, { status: "authenticated", apiKey: "newer-token" });
    });
    const credentialStore = {
      read: vi.fn(async () => storedToken),
      write: vi.fn(async (token: string) => {
        storedToken = token;
      }),
      clear: vi.fn(async () => {
        storedToken = null;
      }),
    };
    const client = new AndroidCloudClient({ fetchImpl, credentialStore });

    await client.pollLogin(firstSession);
    const staleCleanup = client.discardLoginAttempt(
      firstSession,
      "stale-token",
    );
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.stringContaining(firstSession),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );

    await expect(client.pollLogin(secondSession)).resolves.toMatchObject({
      status: "authenticated",
      token: "newer-token",
    });
    expect(storedToken).toBe("newer-token");
    finishRevocation();
    await staleCleanup;
    expect(storedToken).toBe("newer-token");
  });

  it("restores identity and resolves its managed runtime before chat", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        success: true,
        data: {
          identity: {
            id: ACCOUNT_ID,
            displayName: "Ada",
            runtime: "dedicated",
            apiBase: RUNTIME_BASE,
          },
        },
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.restoreSession()).resolves.toEqual({
      identity: { id: ACCOUNT_ID, displayName: "Ada" },
      token: "steward-token",
      chatApiBase: RUNTIME_BASE,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.eliza.app/api/v1/eliza/personal",
      { headers: { Authorization: "Bearer steward-token" } },
    );
  });

  it("constructs the exact shared adapter path for a shared identity", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        data: {
          identity: {
            id: PERSONAL_ID,
            displayName: "Ada",
            runtime: "shared",
          },
        },
      }),
    );
    const restored = await new AndroidCloudClient({
      fetchImpl,
    }).restoreSession();
    expect(restored?.chatApiBase).toBe(
      `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
    );
  });

  it("clears an expired token when Cloud rejects session restoration", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "expired-token");
    const client = new AndroidCloudClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(json(401, {})),
    });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("uses an injected secure credential store without touching localStorage", async () => {
    let secureToken: string | null = "secure-token";
    const credentialStore = {
      read: vi.fn(async () => secureToken),
      write: vi.fn(async (token: string) => {
        secureToken = token;
      }),
      clear: vi.fn(async () => {
        secureToken = null;
      }),
    };
    const client = new AndroidCloudClient({
      credentialStore,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(json(401, {})),
    });

    await expect(client.restoreSession()).resolves.toBeNull();
    expect(credentialStore.read).toHaveBeenCalledTimes(2);
    expect(credentialStore.clear).toHaveBeenCalledOnce();
    expect(secureToken).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("restores only valid visible user and assistant transcript messages", async () => {
    const client = new AndroidCloudClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        json(200, {
          messages: [
            { id: "user-1", role: "user", text: "Hello" },
            { id: "assistant-1", role: "assistant", text: "Hi" },
            { id: "internal-1", role: "assistant", text: "" },
            { id: "tool-1", role: "tool", text: "hidden" },
          ],
        }),
      ),
    });

    await expect(
      client.getConversationMessages(
        {
          identity: { id: PERSONAL_ID, displayName: "Ada" },
          token: "steward-token",
          chatApiBase: RUNTIME_BASE,
        },
        "conversation-1",
      ),
    ).resolves.toEqual([
      { id: "user-1", role: "user", text: "Hello" },
      { id: "assistant-1", role: "assistant", text: "Hi" },
    ]);
  });

  it("fails closed when Cloud returns an unknown runtime binding", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json(200, {
        data: {
          identity: {
            id: ACCOUNT_ID,
            displayName: "Ada",
            runtime: "unknown",
          },
        },
      }),
    );
    await expect(
      new AndroidCloudClient({ fetchImpl }).restoreSession(),
    ).rejects.toThrow("invalid runtime binding");
  });

  it("clears the local Steward token even when remote logout fails", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network unavailable"));
    const client = new AndroidCloudClient({ fetchImpl });
    await expect(client.signOut()).resolves.toBeUndefined();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/logout",
      {
        method: "POST",
        headers: { Authorization: "Bearer steward-token" },
      },
    );
  });

  it("creates a server conversation and sends a text turn to that id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(200, { conversation: { id: "conversation-1" } }),
      )
      .mockResolvedValueOnce(json(200, { text: "Hello from Eliza" }));
    const client = new AndroidCloudClient({ fetchImpl });
    const session = {
      identity: { id: ACCOUNT_ID, displayName: "Ada" },
      token: "steward-token",
      chatApiBase: RUNTIME_BASE,
    };
    const conversationId = await client.createConversation(session);
    const onText = vi.fn();

    await expect(
      client.sendChat(session, conversationId, "Hello", onText),
    ).resolves.toBe("Hello from Eliza");
    expect(onText).toHaveBeenCalledWith("Hello from Eliza");
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `${RUNTIME_BASE}/api/conversations/conversation-1/messages`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer steward-token",
        }),
      }),
    );
  });

  // A staging build must send users to the staging login: the session was
  // minted against the staging API, and production cannot claim it.
  it("pairs the sign-in origin with the API the session was minted against", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(SESSION_ID);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(200, { sessionId: SESSION_ID }));
    const client = new AndroidCloudClient({
      fetchImpl,
      cloudApiBase: "https://api-staging.eliza.app",
    });

    const attempt = await client.beginLogin();

    expect(attempt.browserUrl).toBe(
      `https://cloud-staging.eliza.app/auth/cli-login?session=${SESSION_ID}`,
    );
  });

  // A body that is present but unparsable is a broken endpoint, not "no
  // session yet". Collapsing it to {} made pollLogin spin its full timeout.
  it("reports an unreadable response instead of reading it as pending", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("<html>gateway error</html>", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.pollLogin(SESSION_ID)).rejects.toThrow(
      /could not be read/,
    );
  });

  it.each([
    ["null", null],
    ["an array", [{ status: "authenticated", token: "attacker-token" }]],
    ["a string", "pending"],
    ["a number", 0],
    ["a boolean", false],
  ])(
    "rejects %s JSON body instead of reading it as pending",
    async (_label, body) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(200, body));
      const client = new AndroidCloudClient({ fetchImpl });

      await expect(client.pollLogin(SESSION_ID)).rejects.toThrow(
        /invalid JSON response/,
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("treats a genuinely empty body as empty rather than unreadable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const client = new AndroidCloudClient({ fetchImpl });

    await expect(client.pollLogin(SESSION_ID)).resolves.toEqual({
      status: "pending",
    });
  });
});
