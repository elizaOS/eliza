/** Real host HTTP, assistant planning, durable file effect and denied egress. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  createCharacter,
  EventType,
  ModelType,
  markOwnerExclusiveDisclosureUsed,
  PRIVACY_DENIED_TEXT,
  type RunEventPayload,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";

it.each([false, true])(
  "preserves denied delivery and committed receipts with provider failure=%s",
  async (providerFailure) => {
    const directory = await mkdtemp(path.join(tmpdir(), "eliza-denied-http-"));
    const filename = path.join(directory, "saved.txt");
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_BIND_HOST: "127.0.0.1",
      ELIZA_API_TOKEN: "",
      ELIZA_REQUIRE_LOCAL_AUTH: "0",
    }))
      vi.stubEnv(key, value);
    const runtime = createSQLiteTestRuntime({
      plugins: [createAssistantPlugin()],
      character: createCharacter({ name: "DeniedReceipt" }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    let writes = 0;
    const completedRuns: RunEventPayload[] = [];
    let handlerCalls = 0;
    let providerFailures = 0;
    try {
      await runtime.initialize();
      runtime.registerEvent(EventType.RUN_ENDED, async (event) => {
        completedRuns.push(event as RunEventPayload);
      });
      runtime.registerAction({
        name: "SAVE_RECEIPT_FIXTURE",
        description: "Save the requested test file.",
        contexts: ["files"],
        validate: async () => true,
        handler: async (_runtime, message) => {
          writes++;
          await writeFile(filename, "private saved value\n");
          // Genuine canonical attestation expires after the effect; no fake clock
          // or forged audience bypasses the runtime's fail-closed egress policy.
          await attestDeliveryAudienceFromCanonicalRoom(runtime, message, {
            nowMs: Date.now() - 600_000,
            ttlMs: 1,
          });
          markOwnerExclusiveDisclosureUsed(message);
          return {
            success: true,
            text: "private saved value",
            effectReceipts: [
              {
                receiptId: "saved-http-fixture",
                operation: "filesystem.write",
                outcome: "applied",
                resource: { kind: "file", id: filename },
                artifacts: [],
                idempotency: { key: null, replayed: false },
                observedAt: new Date().toISOString(),
                commit: {
                  kind: "durable",
                  id: filename,
                  committedAt: new Date().toISOString(),
                },
              },
            ],
          };
        },
      });
      runtime.registerModel(
        ModelType.RESPONSE_HANDLER,
        async () => {
          if (++handlerCalls === 1)
            return {
              text: "",
              toolCalls: [
                {
                  id: "route",
                  name: "HANDLE_RESPONSE",
                  arguments: {
                    shouldRespond: "RESPOND",
                    contexts: ["files"],
                    intents: providerFailure
                      ? ["Save the test file", "Read back and verify it"]
                      : ["Save the test file"],
                    candidateActionNames: ["SAVE_RECEIPT_FIXTURE"],
                    replyText: "",
                    replyEffectStatus: "pending",
                    facts: [],
                    relationships: [],
                    addressedTo: [],
                  },
                },
              ],
              finishReason: "tool_calls",
            };
          if (providerFailure) {
            providerFailures++;
            throw Object.assign(
              new Error("private saved value: provider rate limit"),
              { status: 429 },
            );
          }
          return JSON.stringify({
            thought: "The write committed.",
            decision: "FINISH",
            success: true,
            messageToUser: "private saved value",
          });
        },
        "denied-http",
        100,
      );
      runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async () => ({
          text: "",
          toolCalls: [
            {
              id: "save",
              name: "SAVE_RECEIPT_FIXTURE",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        }),
        "denied-http",
        100,
      );
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const post = async (route: string, body: object) => {
        const response = await fetch(
          `http://127.0.0.1:${server?.port}${route}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const data = await response.json();
        expect(response.status, JSON.stringify(data)).toBe(200);
        return data;
      };
      const { conversation } = await post("/api/conversations", {
        title: "Privacy receipt",
      });
      const request = {
        text: "Save the test file.",
        clientMessageId: randomUUID(),
      };
      const result = await post(
        `/api/conversations/${conversation.id}/messages`,
        request,
      );
      expect(JSON.stringify(result)).not.toContain(
        "No side effects were applied",
      );
      expect(JSON.stringify(result)).not.toContain(
        "Unexecuted actions: PRIVACY_DENIED",
      );
      expect(JSON.stringify(result)).toContain(PRIVACY_DENIED_TEXT);
      expect(result.text).toBe(PRIVACY_DENIED_TEXT);
      expect(result.actionResults).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("private saved value");
      expect(JSON.stringify(result)).not.toContain(filename);
      await vi.waitFor(() => expect(completedRuns.length).toBeGreaterThan(0));
      expect(
        completedRuns.flatMap((run) => run.outcome?.effects ?? []),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            receiptId: "saved-http-fixture",
            outcome: "applied",
            resource: { kind: "file", id: filename },
          }),
        ]),
      );
      expect(await readFile(filename, "utf8")).toBe("private saved value\n");
      expect(writes).toBe(1);
      if (providerFailure) {
        expect(providerFailures).toBeGreaterThan(0);
        expect(
          completedRuns.some((run) => run.outcome?.status === "failed"),
        ).toBe(true);
      }
      const duplicate = await post(
        `/api/conversations/${conversation.id}/messages`,
        request,
      );
      expect(duplicate.text).toBe(PRIVACY_DENIED_TEXT);
      expect(duplicate.actionResults).toBeUndefined();
      expect(JSON.stringify(duplicate)).not.toContain("private saved value");
      expect(JSON.stringify(duplicate)).not.toContain(filename);
      expect(writes).toBe(1);
      handlerCalls = 0;
      const streamRequest = { ...request, clientMessageId: randomUUID() };
      for (let attempt = 0; attempt < 2; attempt++) {
        const stream = await fetch(
          `http://127.0.0.1:${server.port}/api/conversations/${conversation.id}/messages/stream`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(streamRequest),
          },
        );
        expect(stream.status).toBe(200);
        const wire = await stream.text();
        expect(wire).toContain(PRIVACY_DENIED_TEXT);
        expect(wire).not.toContain("private saved value");
        expect(wire).not.toContain(filename);
        expect(wire).not.toContain("No side effects were applied");
        expect(writes).toBe(2);
      }
    } finally {
      await server?.close();
      await runtime.stop();
      await runtime.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
