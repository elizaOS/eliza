import { afterEach, describe, expect, test, vi } from "vitest";
import { postToX, sendXDm, type XPosterCredentials } from "./x-poster.js";

const credentials: XPosterCredentials = {
  apiKey: "key",
  apiSecretKey: "secret",
  accessToken: "token",
  accessTokenSecret: "token-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => response));
}

describe("x-poster strict success validation", () => {
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
