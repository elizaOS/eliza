// @vitest-environment jsdom

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
