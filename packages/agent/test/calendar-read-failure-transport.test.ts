/** Real HTTP/SQLite transport of a settled Calendar coverage failure; no provider calls. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRetryableChatFailureKind,
  parseChatTerminalFailure,
} from "@elizaos/contracts";
import {
  AgentRuntime,
  type IMessageService,
  type State,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createV5ReplyStrategyResult } from "../../../plugins/plugin-assistant/src/services/message/reply-policy.ts";
import { startApiServer } from "../src/api/server.ts";

it("keeps one unchanged Calendar answer and fixed diagnostic on JSON, SSE and saved history", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "calendar-failure-transport-"),
  );
  const token = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Calendar fixture", bio: [] },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      runtime.agentId,
    ),
  );
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let handled = 0;
  const text = "I couldn't confirm that Calendar request.";
  const failure = {
    kind: "reply_generation_error" as const,
    code: "CALENDAR_READ_RECEIPT_MISMATCH",
    transient: false,
    message: text,
  };
  try {
    await runtime.init();
    runtime.messageService = {
      handleMessage: async (_runtime, message) => {
        handled++;
        const strategy = createV5ReplyStrategyResult({
          runtime,
          message,
          state: {} as State,
          responseId: randomUUID() as UUID,
          text,
          thought: "",
          terminalFailure: failure,
        });
        return {
          ...strategy,
          didRespond: true,
          outcome: { status: "failed", error: failure, effects: [] },
        };
      },
    } as IMessageService;
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Calendar failure" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = await created.json();
    const ids: string[] = [];
    for (const route of ["messages", "messages/stream"]) {
      const response = await fetch(
        `${base}/api/conversations/${conversation.id}/${route}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: "Check the fixture interval",
            clientMessageId: randomUUID(),
          }),
        },
      );
      expect(response.status).toBe(200);
      const payload =
        route === "messages"
          ? await response.json()
          : (await response.text())
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)))
              .find((event) => event.type === "done");
      expect(payload).toBeDefined();
      expect(payload.text ?? payload.fullText).toBe(text);
      expect(payload.failureKind).toBe(failure.kind);
      expect(parseChatTerminalFailure(payload.terminalFailure)).toEqual(
        failure,
      );
      expect(isRetryableChatFailureKind(payload.failureKind)).toBe(false);
      ids.push(payload.messageId);
    }
    expect(handled).toBe(2);
    const history = await (
      await fetch(`${base}/api/conversations/${conversation.id}/messages`, {
        headers,
      })
    ).json();
    for (const id of ids) {
      const rows = history.messages.filter(
        (row: { id: string }) => row.id === id,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        text,
        failureKind: failure.kind,
        terminalFailure: failure,
      });
      const [stored] = await runtime.getMemoriesByIds([id as UUID], "messages");
      expect(stored.content.text).toBe(text);
      expect(stored.content.terminalFailure).toEqual(failure);
    }
  } finally {
    await server?.close();
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
