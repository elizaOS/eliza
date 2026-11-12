import { expect, test } from "vitest";
import {
  CloudSpeechRelayClientError,
  createCloudSpeechRelayPorts,
} from "./cloud-speech-relay-client";

test("HTTP availability is transport, not authorization, and never retries consent or mint", async () => {
  for (const failedPath of ["/consent", "/session"])
    for (const [status, code] of [
      [503, "transport"],
      [429, "transport"],
      [401, "authorization"],
      [403, "authorization"],
      [410, "expired"],
      [400, "protocol"],
    ] as const) {
      const paths: string[] = [];
      let cancelled = 0;
      const fakeFetch = async (input: RequestInfo | URL) => {
        const p = new URL(String(input)).pathname;
        paths.push(p);
        if (p.endsWith(failedPath))
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status },
          );
        return Response.json({
          consentNonce: crypto.randomUUID(),
          retirementProofVersion: 1,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        });
      };
      const startup = createCloudSpeechRelayPorts({
        enabled: true,
        origin: "https://api-staging.eliza.app",
        credential: async () => "fixture-only",
        assertCurrent() {},
        fetch: fakeFetch as typeof fetch,
        websocket() {
          throw Error("must not open socket");
        },
      });
      await expect(startup).rejects.toMatchObject({ code });
      if (failedPath === "/session") {
        const failure = await startup.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CloudSpeechRelayClientError);
        const cause = (failure as Error).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors).toHaveLength(2);
        expect((cause as AggregateError).errors[0]).toMatchObject({ code });
        expect((cause as AggregateError).errors[1]).toMatchObject({
          code: "protocol",
          message: "Cloud speech admission remains unconfirmed",
        });
      }
      expect(paths).toEqual(
        failedPath === "/consent"
          ? ["/api/v1/voice/speech/consent"]
          : ["/api/v1/voice/speech/consent", "/api/v1/voice/speech/session"],
      );
      expect(cancelled).toBe(1);
    }
});
