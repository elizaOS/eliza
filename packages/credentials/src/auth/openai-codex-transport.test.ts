/**
 * Exercises OAuth rejection cleanup through real Node HTTP and Fetch responses.
 * Only endpoint routing is replaced; provider bodies must be released before the
 * caller receives failure so repeated login attempts do not retain transport resources.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorizationCode,
  refreshOpenAICodexToken,
} from "./vendor/pi-oauth/openai-codex-login.ts";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI Codex rejected response lifecycle", () => {
  it.each(["exchange", "refresh"] as const)(
    "releases each rejected %s response before another attempt",
    async (mode) => {
      let requests = 0;
      const server = createServer((request, response) => {
        request.resume();
        requests += 1;
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("synthetic-provider-error".repeat(16_384));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP fixture did not bind a TCP port");
      }
      const realFetch = globalThis.fetch;
      const responses: Response[] = [];
      vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
        const response = await realFetch(
          `http://127.0.0.1:${address.port}/oauth/token`,
          { ...init, signal: AbortSignal.timeout(5_000) },
        );
        responses.push(response);
        return response;
      });

      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (mode === "exchange") {
            await expect(
              exchangeAuthorizationCode("synthetic-code", "synthetic-verifier"),
            ).resolves.toMatchObject({ type: "failed" });
          } else {
            await expect(
              refreshOpenAICodexToken("synthetic-refresh"),
            ).rejects.toThrow("Failed to refresh OpenAI Codex token");
          }
          const response = responses[attempt];
          expect(response.bodyUsed).toBe(true);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("HTTP fixture response has no body");
          await expect(reader.read()).resolves.toEqual({
            done: true,
            value: undefined,
          });
          reader.releaseLock();
        }
        expect(requests).toBe(2);
      } finally {
        vi.unstubAllGlobals();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
