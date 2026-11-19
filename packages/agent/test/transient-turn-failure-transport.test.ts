/**
 * A real conversation turn whose model call fails with an untyped provider
 * error (no rate-limit, credits or auth cause) ends in the message runtime's
 * generic `transient_failure`. The chat transport must carry that failure to
 * the client as the public, retryable `provider_issue` on the JSON and SSE
 * routes. Before, the transport dropped the internal kind and delivered the
 * failure apology ("I hit a hiccup and couldn't complete that request") as an
 * ordinary answer, so a phone could not tell the owner what happened.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chatTerminalFailureFromRuntime,
  isRetryableChatFailureKind,
  parseChatTerminalFailure,
} from "@elizaos/contracts";
import { createCharacter, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";

const APOLOGY =
  "I hit a hiccup and couldn't complete that request. Please try sending it again.";
// The failure-reply prompt's own rule; every other model call fails.
const FAILURE_REPLY_PROMPT = "NEVER answer the user's question on the merits.";

it("projects only the runtime's transient failure onto provider_issue", () => {
  const message = "Something went wrong on my end. Please try again.";
  expect(
    chatTerminalFailureFromRuntime({
      kind: "transient_failure",
      transient: true,
      message,
    }),
  ).toEqual({ kind: "provider_issue", transient: true, message });
  // A non-transient record of that kind is not a runtime transient failure.
  expect(
    chatTerminalFailureFromRuntime({
      kind: "transient_failure",
      transient: false,
      message,
    }),
  ).toBeUndefined();
  // Public kinds keep their own meaning, and the client parser stays strict.
  const handler = {
    kind: "handler_error",
    transient: false,
    message: "The action failed.",
    code: "X",
  };
  expect(chatTerminalFailureFromRuntime(handler)).toEqual(handler);
  expect(
    parseChatTerminalFailure({
      kind: "transient_failure",
      transient: true,
      message,
    }),
  ).toBeUndefined();
});

it.each([["/messages"], ["/messages/stream"]] as const)(
  "delivers a transient model failure as provider_issue on %s",
  async (route) => {
    const directory = await mkdtemp(path.join(tmpdir(), "transient-turn-"));
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_TOKEN: randomUUID(),
      ELIZA_REQUIRE_LOCAL_AUTH: "1",
    }))
      vi.stubEnv(key, value);
    const runtime = createSQLiteTestRuntime({
      plugins: [createAssistantPlugin()],
      character: createCharacter({ name: "TransientTurn" }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    const calls: string[] = [];
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      await runtime.initialize();
      for (const type of [
        ModelType.RESPONSE_HANDLER,
        ModelType.TEXT_LARGE,
        ModelType.TEXT_SMALL,
      ] as const)
        runtime.registerModel(
          type,
          async (_runtime, params) => {
            const prompt = String(
              (params as { prompt?: unknown }).prompt ?? "",
            );
            if (prompt.includes(FAILURE_REPLY_PROMPT)) {
              calls.push(`${type}:failure-reply`);
              return APOLOGY;
            }
            calls.push(`${type}:turn`);
            // An upstream server error with no typed cause.
            throw Object.assign(new Error("Internal server error"), {
              status: 500,
            });
          },
          "syntheticProvider",
          100,
        );
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const headers = {
        Authorization: `Bearer ${process.env.ELIZA_API_TOKEN}`,
        "content-type": "application/json",
      };
      const create = await fetch(`${origin}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Transient failure" }),
      });
      const created = await create.json();
      expect(create.status, JSON.stringify(created)).toBe(200);
      const response = await fetch(
        `${origin}/api/conversations/${created.conversation.id}${route}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: "open example.com in the browser",
            clientMessageId: randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(200);
      let payload: Record<string, unknown>;
      if (route === "/messages") {
        payload = await response.json();
      } else {
        const events = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        const done = events.find((event) => event.type === "done");
        expect(done, JSON.stringify(events)).toBeDefined();
        payload = done as Record<string, unknown>;
      }
      // The turn failed, and the apology came from the later failure reply.
      expect(calls.some((call) => call.endsWith(":turn"))).toBe(true);
      expect(calls.some((call) => call.endsWith(":failure-reply"))).toBe(true);
      expect(payload.text ?? payload.fullText).toBe(APOLOGY);
      expect(payload.failureKind, JSON.stringify(payload)).toBe(
        "provider_issue",
      );
      expect(parseChatTerminalFailure(payload.terminalFailure)).toEqual({
        kind: "provider_issue",
        transient: true,
        message: APOLOGY,
      });
      expect(isRetryableChatFailureKind("provider_issue")).toBe(true);
      // The provider's own error text never reaches the client.
      expect(JSON.stringify(payload)).not.toContain("Internal server error");
    } finally {
      if (server) await server.close();
      await runtime.stop();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
