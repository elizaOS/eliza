/** Real HTTP/SQLite transport of turn status: one model acknowledgement, then one content-free status per activity. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("streams the acknowledgement once and each activity label in order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-activity-status-"));
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
    character: { name: "Activity fixture", bio: [] },
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
  const text = "Two meetings and one note.";
  try {
    await runtime.init();
    runtime.messageService = {
      handleMessage: async (_runtime, message, _callback, options) => {
        await options?.onPlanningAcknowledgment?.("Let me have a look.");
        await options?.onActivityStatus?.({
          actionName: "CALENDAR",
          label: "Using Calendar",
        });
        // The structured tool step of the same activity adds no second status.
        await options?.onStreamChunk?.(
          JSON.stringify({
            type: "tool_call",
            toolCall: { id: "calendar-1", name: "CALENDAR", arguments: {} },
          }),
        );
        await options?.onActivityStatus?.({
          actionName: "NOTES",
          label: "Using Notes",
        });
        const strategy = createV5ReplyStrategyResult({
          runtime,
          message,
          state: {} as State,
          responseId: randomUUID() as UUID,
          text,
          thought: "",
        });
        return {
          ...strategy,
          didRespond: true,
          outcome: { status: "completed", effects: [] },
        };
      },
      shouldRespond: () => {
        throw new Error("Unexpected response decision in transport fixture");
      },
      deleteMessage: async () => {
        throw new Error("Unexpected message deletion in transport fixture");
      },
      clearChannel: async () => {
        throw new Error("Unexpected channel clearing in transport fixture");
      },
    } satisfies IMessageService;
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
      body: JSON.stringify({ title: "Activity status" }),
    });
    expect(created.status).toBe(200);
    const { conversation } = await created.json();
    const response = await fetch(
      `${base}/api/conversations/${conversation.id}/messages/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "What's on my calendar, and do I have any notes?",
          clientMessageId: randomUUID(),
        }),
      },
    );
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", kind: "thinking" },
      { type: "status", kind: "thinking", label: "Let me have a look." },
      {
        type: "status",
        kind: "running_tool",
        toolName: "CALENDAR",
        label: "Using Calendar",
      },
      {
        type: "status",
        kind: "running_tool",
        toolName: "NOTES",
        label: "Using Notes",
      },
    ]);
    const done = events.find((event) => event.type === "done");
    expect(done?.fullText ?? done?.text).toBe(text);
  } finally {
    await server?.close();
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
