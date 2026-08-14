/** Exercises the real inbound and media Hono boundaries before provider setup. */

import { describe, expect, test } from "bun:test";
import inbound from "./inbound/route";
import media from "./media/route";

describe("Twilio voice route boundaries", () => {
  test("inbound rejects an invalid provider payload", async () => {
    const response = await inbound.request("http://local/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid payload");
  });

  test("media requires a WebSocket upgrade", async () => {
    const response = await media.request("http://local/", undefined, {
      VOICE_REALTIME_WS_ENABLED: "true",
    } as never);
    expect(response.status).toBe(426);
  });

  test("media refuses an upgrade when provider configuration is absent", async () => {
    const response = await media.request(
      "http://local/?sessionId=11111111-1111-4111-8111-111111111111&token=bad",
      { headers: { Upgrade: "websocket" } },
      {
        VOICE_REALTIME_WS_ENABLED: "true",
        ELIZA_APP_TWILIO_AUTH_TOKEN: "secret",
      } as never,
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: "voice realtime session misconfigured",
    });
  });
});
