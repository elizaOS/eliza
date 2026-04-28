import { afterEach, describe, expect, test, vi } from "vitest";
import { postToX, sendXDm, type XPosterCredentials } from "./x-poster.js";

const credentials: XPosterCredentials = {
  apiKey: "key",
  apiSecretKey: "secret",
  accessToken: "token",
  accessTokenSecret: "token-secret",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

describe("x-poster strict success validation", () => {
  test("sendXDm posts to the participant DM endpoint with OAuth auth and returns ids", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubEnv("MILADY_MOCK_X_BASE", "http://127.0.0.1:7878");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: {
              dm_conversation_id: "conversation-123",
              dm_event_id: "event-456",
            },
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await sendXDm({
      participantId: "12345",
      text: "hello",
      credentials,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      dmConversationId: "conversation-123",
      dmEventId: "event-456",
      category: "success",
    });
    expect(capturedUrl).toBe(
      "http://127.0.0.1:7878/2/dm_conversations/with/12345/messages",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization.startsWith("OAuth ")).toBe(true);
    expect(headers.Authorization).toContain("oauth_signature=");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ text: "hello" });
  });

  test("postToX rejects successful responses without a tweet id", async () => {
    stubFetch(
      new Response(JSON.stringify({ data: {} }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await postToX({ text: "hello", credentials });

    expect(result).toMatchObject({
      ok: false,
      status: 201,
      category: "invalid",
      error: "X post API response did not include data.id.",
    });
  });

  test("sendXDm rejects successful responses without a DM event id", async () => {
    stubFetch(
      new Response(JSON.stringify({ data: { dm_conversation_id: "c-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendXDm({
      participantId: "12345",
      text: "hello",
      credentials,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 201,
      category: "invalid",
      error: "X DM API response did not include data.dm_event_id.",
    });
  });

  test("sendXDm rejects invalid JSON success responses", async () => {
    stubFetch(
      new Response("not json", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendXDm({
      participantId: "12345",
      text: "hello",
      credentials,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 201,
      category: "invalid",
      error: "X DM API returned invalid JSON.",
    });
  });
});
