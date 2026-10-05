/** Real HTTP turns, assistant planning, file-backed SQLite and durable file effects. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionResult,
  AgentRuntime,
  createCharacter,
  ModelType,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { startApiServer } from "../src/api/server.ts";

it.each([
  { approved: true, uncertain: false, mutation: true },
  { approved: false, uncertain: false, mutation: true },
  { approved: true, uncertain: true, mutation: true },
  { approved: true, uncertain: false, mutation: false },
])(
  "preserves recovery authority through real HTTP: %j",
  async ({ approved, uncertain, mutation }) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "eliza-recovery-http-"),
    );
    const filename = path.join(directory, "saved.txt");
    const originalText = "Keep two  spaces.\nOriginal Ω🙂 record.\n";
    await writeFile(filename, originalText);
    for (const [key, value] of Object.entries({
      ELIZA_STATE_DIR: directory,
      ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
      ELIZA_API_BIND_HOST: "127.0.0.1",
      ELIZA_API_TOKEN: "",
      ELIZA_REQUIRE_LOCAL_AUTH: "0",
    }))
      vi.stubEnv(key, value);
    const runtime = new AgentRuntime({
      plugins: [createAssistantPlugin()],
      character: createCharacter({ name: "RecoveryProjection" }),
      logLevel: "fatal",
      enableAutonomy: false,
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(directory, "agent.sqlite"),
        runtime.agentId,
      ),
    );
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    let executions = 0;
    let handlerCalls = 0;
    let rewriteAllowed = false;
    let recoveryModelCalls = 0;
    let originalResult: ActionResult | undefined;
    const component = () => {
      throw new Error("Executable handle must never run");
    };
    const fail = () => {
      throw Object.assign(
        new Error("Controlled answer-provider failure after file execution"),
        { status: 400 },
      );
    };
    try {
      await runtime.initialize();
      runtime.registerAction({
        name: "RECOVERY_FILE_FIXTURE",
        description: "Save or read the requested acceptance-test file.",
        contexts: ["files"],
        validate: async () => true,
        handler: async () => {
          executions++;
          if (mutation) await writeFile(filename, originalText);
          const text = await readFile(filename, "utf8");
          const now = new Date().toISOString();
          originalResult = {
            success: true,
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            text,
            values: { observedFile: filename },
            data: {
              filename,
              text,
              component,
              ...(uncertain ? { committed: "unknown" } : {}),
              ...(!mutation ? { readOnlyOperation: true } : {}),
            },
            ...(approved
              ? {
                  promptDataMode: "replace-data",
                  promptData: { filename, text },
                }
              : {}),
            effectReceipts: mutation
              ? [
                  {
                    receiptId: "saved-recovery-http",
                    operation: "filesystem.write",
                    resource: { kind: "file", id: filename },
                    artifacts: [],
                    idempotency: { key: null, replayed: false },
                    observedAt: now,
                    outcome: "applied",
                    commit: { kind: "durable", id: filename, committedAt: now },
                  },
                ]
              : [],
          };
          return originalResult;
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
                    intents: [
                      mutation ? "Save the test file" : "Read the test file",
                    ],
                    candidateActionNames: ["RECOVERY_FILE_FIXTURE"],
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
          return fail();
        },
        "recovery-http",
        100,
      );
      runtime.registerModel(
        ModelType.ACTION_PLANNER,
        async () => ({
          text: "",
          toolCalls: [
            {
              id: "file",
              name: "RECOVERY_FILE_FIXTURE",
              arguments: { eliza_turn_scope: "final" },
            },
          ],
        }),
        "recovery-http",
        100,
      );
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        async (_runtime, params) => {
          if (!rewriteAllowed) return fail();
          if (typeof params.prompt !== "string")
            throw new Error("Recovery model requires a text prompt");
          recoveryModelCalls++;
          expect(params.prompt).toContain("Keep two  spaces.");
          expect(params.prompt).toContain("Original Ω🙂 record.");
          if (params.prompt.startsWith("Review recovered reply grounding."))
            return JSON.stringify({
              grounded: true,
              completedChangeClaim: true,
              reason:
                "The saved file commit receipt supports this exact write.",
            });
          return JSON.stringify({
            response: "The test file was saved with its original contents.",
            effectReceiptIds: ["saved-recovery-http"],
          });
        },
        "recovery-http",
        100,
      );
      runtime.registerModel(
        ModelType.TEXT_LARGE,
        async () => fail(),
        "recovery-http",
        100,
      );
      server = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const origin = `http://127.0.0.1:${server.port}`;
      const post = async (route: string, body: object) => {
        const response = await fetch(`${origin}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const created = await post("/api/conversations", {
        title: "Projection recovery",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const conversation = created.body.conversation;
      const request = {
        text: mutation
          ? "Save the test file, preserving its exact original contents."
          : "Read the test file and preserve exact original contents.",
        clientMessageId: randomUUID(),
      };
      const initial = await post(
        `/api/conversations/${conversation.id}/messages`,
        request,
      );
      expect(initial.status, JSON.stringify(initial.body)).toBe(200);
      expect(executions).toBe(1);
      expect(await readFile(filename, "utf8")).toBe(originalText);
      expect(originalResult?.data?.component).toBe(component);
      const messages = await runtime.getMemories({
        tableName: "messages",
        roomId: conversation.roomId,
        count: 20,
      });
      const user = messages.find((message) => message.content.chatIdempotency);
      const marker = user?.content.chatIdempotency as
        | { replyRecoveryJson?: string; outcomeJson?: string }
        | undefined;
      const eligible = approved && mutation && !uncertain;
      if (!approved || !mutation)
        expect(marker?.replyRecoveryJson).toBeUndefined();
      else {
        expect(marker?.replyRecoveryJson).toBeTruthy();
        const saved = JSON.parse(marker?.replyRecoveryJson ?? "{}");
        const action = saved.actionResults.find(
          (result: ActionResult) => result.values?.observedFile === filename,
        );
        expect(action.data).toEqual({
          actionName: "RECOVERY_FILE_FIXTURE",
          filename,
          text: originalText,
          values: originalResult?.values,
          ...(uncertain ? { committed: "unknown" } : {}),
        });
        expect(action.values).toEqual(originalResult?.values);
        expect(action.text).toBe(originalText);
        expect(action.effectReceipts).toEqual(
          originalResult?.effectReceipts?.map((receipt) => ({
            ...receipt,
            // The real runtime applies its existing diagnostic key redaction.
            // Commit proof and replay state must survive that boundary exactly.
            idempotency: { ...receipt.idempotency, key: "[REDACTED]" },
          })),
        );
        expect(originalResult?.effectReceipts?.[0].idempotency.key).toBeNull();
      }
      expect(initial.body.replyRecoveryAvailable === true).toBe(eligible);
      const outcome = JSON.parse(marker?.outcomeJson ?? "{}");
      expect(outcome.messageId).toBeTruthy();
      rewriteAllowed = true;
      const retryPath = `/api/conversations/${conversation.id}/messages/${outcome.messageId}/retry-reply`;
      const retry = await post(retryPath, {});
      if (eligible) {
        expect(retry.status, JSON.stringify(retry.body)).toBe(200);
        expect(JSON.stringify(retry.body)).toContain("The test file was saved");
        expect(recoveryModelCalls).toBe(2);
        const duplicate = await post(retryPath, {});
        expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(200);
        expect(recoveryModelCalls).toBe(2);
      } else {
        expect(retry.status, JSON.stringify(retry.body)).toBe(409);
        expect(recoveryModelCalls).toBe(0);
      }
      expect(executions).toBe(1);
      expect(await readFile(filename, "utf8")).toBe(originalText);
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
