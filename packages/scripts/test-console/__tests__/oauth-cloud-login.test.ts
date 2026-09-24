/** Exercises the console's zero-workspace-import Cloud login protocol boundary. */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { startCloudLogin } from "../lib/oauth.mjs";

const originalFetch = globalThis.fetch;
const SERVER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startCloudLogin", () => {
  it("uses the server session and derives the paired production browser URL", async () => {
    let requestBody;
    globalThis.fetch = mock(async (_input, init) => {
      requestBody = init?.body;
      return new Response(JSON.stringify({ sessionId: SERVER_SESSION_ID }), {
        status: 201,
      });
    });

    await expect(startCloudLogin()).resolves.toEqual({
      sessionId: SERVER_SESSION_ID,
      browserUrl: `https://eliza.app/auth/cli-login?session=${SERVER_SESSION_ID}`,
    });
    expect(JSON.parse(requestBody)).toEqual({
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
  });

  it.each([{}, { sessionId: "client-chosen" }])(
    "rejects malformed server session data: %j",
    async (payload) => {
      globalThis.fetch = mock(
        async () => new Response(JSON.stringify(payload), { status: 201 }),
      );

      await expect(startCloudLogin()).rejects.toThrow("invalid session ID");
    },
  );
});
