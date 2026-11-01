/** Real HTTP moderation, safety cache and speech relay; providers/accounting stay local. */
import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { createSpeechRelaySession } from "@elizaos/host/voice/speech-relay-session";
import { InMemoryVoiceUsageStore } from "@elizaos/host/voice/usage";

import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import { assertSafeTtsText } from "./tts-safety-cache";

test("cancel aborts delayed HTTP moderation, releases the next phrase and never caches the retired approval", () => {
  const values = new Map<string, string>();
  return runWithCloudBindingsAsync(
    {
      OPENAI_MODERATION_API_KEY: "local-test-only",
      CONTENT_SAFETY_MODE: "enforce",
      CONTENT_SAFETY_FAIL_OPEN: "true",
      CACHE_KV: {
        get: async (key: string) => values.get(key) ?? null,
        put: async (key: string, value: string) => {
          values.set(key, value);
        },
      },
    },
    async () => {
      const nativeFetch = globalThis.fetch;
      let held: ServerResponse | undefined;
      let started!: () => void;
      const firstRequest = new Promise<void>((resolve) => {
        started = resolve;
      });
      let requests = 0;
      const server = createServer(async (request, response) => {
        for await (const _part of request) {
          /* consume the real request body */
        }
        requests++;
        if (requests === 1) {
          held = response;
          started();
        } else {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
          );
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing local server");
      let signal: AbortSignal | undefined;
      globalThis.fetch = ((url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/moderations");
        signal ??= init?.signal ?? undefined;
        return nativeFetch(`http://127.0.0.1:${address.port}`, init);
      }) as typeof fetch;
      const sent: string[] = [];
      const settled: unknown[] = [];
      let reviewFailure: unknown;
      const safetyInput = (text: string) => ({
        surface: "media_generation_prompt" as const,
        userId: "cancellation-test-user",
        organizationId: "cancellation-test-org",
        text,
      });
      const session = await createSpeechRelaySession(
        {
          userId: "cancellation-test-user",
          organizationId: "cancellation-test-org",
          cloudSessionId: "cancellation-test-session",
        },
        "local-consent",
        {
          enabled: true,
          assertCurrent() {},
          consumeConsent: async () => true,
          usageStore: new InMemoryVoiceUsageStore(),
          usageLimits: { organizationDailyMinutes: 5, userDailyMinutes: 5 },
          reserveCredits: async () => ({
            beforeProviderDispatch: async () => {},
            settle: async (value) => {
              settled.push(value);
            },
          }),
          subscribeRevoked: () => () => {},
          assertTtsAllowed: async (text, callerSignal) => {
            try {
              await assertSafeTtsText(safetyInput(text), undefined, callerSignal);
            } catch (error) {
              reviewFailure = error;
              throw error;
            }
          },
          openStt: () => ({ sendAudioChunk() {}, cancel() {} }),
          openTts: () => ({
            sendPhrase: ({ text }) => {
              sent.push(text);
            },
            finish() {},
            cancel() {},
          }),
          emit() {},
          onClosed(result) {
            void result.catch(() => {});
          },
        },
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const old = session.control({ t: "tts", id: "old", text: "cancelled phrase" });
        await firstRequest;
        // Match the coordinator's ordered controls while cancel takes its direct path.
        const next = old
          .then(() => session.control({ t: "finish", id: "old" }))
          .then(() => session.control({ t: "tts", id: "new", text: "new phrase" }));
        await session.control({ t: "cancel", id: "old" });
        await Promise.race([
          next,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(Error("Next speech waited for retired moderation")),
              1000,
            );
          }),
        ]);
        expect(signal?.aborted).toBe(true);
        expect(reviewFailure).toMatchObject({ name: "AbortError" });
        expect(sent).toEqual(["new phrase"]);
        expect(requests).toBe(2);
        expect(values.size).toBe(1);
        // A late server success is neither a voice phrase nor a positive cache receipt.
        held?.end(
          JSON.stringify({ results: [{ flagged: false, categories: {}, category_scores: {} }] }),
        );
        await expect(assertSafeTtsText(safetyInput("cancelled phrase"))).resolves.toBe("reviewed");
        expect(requests).toBe(3);
        expect(sent).toEqual(["new phrase"]);
      } finally {
        if (deadline) clearTimeout(deadline);
        await session.close();
        expect(settled).toHaveLength(1);
        globalThis.fetch = nativeFetch;
        held?.end();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    },
  );
});
