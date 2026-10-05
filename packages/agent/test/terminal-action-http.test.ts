/** Real terminal HTTP/action execution, rejection recovery and persisted output evidence. */
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionResult,
  ChannelType,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { captureHostExecutionBaseline } from "@elizaos/host";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { projectToolResultForModel } from "../../../plugins/plugin-assistant/src/runtime/planner-rendering.ts";
import { terminalAction } from "../src/actions/terminal.ts";
import { startApiServer } from "../src/api/server.ts";

let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let message: Memory;
const terminalToken = randomUUID();
const apiToken = randomUUID();

beforeAll(async () => {
  captureHostExecutionBaseline();
  directory = await mkdtemp(path.join(tmpdir(), "eliza-terminal-http-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
    ELIZA_TERMINAL_RUN_TOKEN: terminalToken,
    ELIZA_RUNTIME_MODE: "local-yolo",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "TerminalHttpAcceptance",
  });
  const owner = randomUUID() as UUID;
  const room = randomUUID() as UUID;
  await fixture.runtime.ensureConnection({
    entityId: owner,
    roomId: room,
    worldId: randomUUID() as UUID,
    worldName: "Synthetic terminal acceptance",
    userName: "Owner",
    name: "Owner",
    source: "test",
    type: ChannelType.DM,
  });
  message = {
    id: randomUUID() as UUID,
    entityId: owner,
    roomId: room,
    agentId: fixture.runtime.agentId,
    content: { text: "Execute the supplied development test command" },
  };
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
  vi.stubEnv("ELIZA_PORT", String(server.port));
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

async function execute(command: string): Promise<ActionResult> {
  const result = await terminalAction.handler(
    fixture.runtime,
    message,
    undefined,
    { parameters: { command } },
  );
  if (!result || typeof result !== "object")
    throw new Error("Terminal result missing");
  return result;
}

it("rejects multiline input before execution, then preserves complete successful output once on the model wire", async () => {
  const filename = path.join(directory, "result.txt");
  const rejected = await execute(`printf never > '${filename}'\nprintf second`);
  expect(rejected).toMatchObject({
    success: false,
    error: "TERMINAL_COMMAND_SINGLE_LINE_REQUIRED",
    failureProvenance: { retryable: true },
    data: { acceptance: "rejected", executionStatus: "not_started" },
  });
  await expect(access(filename)).rejects.toThrow();
  const result = await execute(
    `printf 'first\\nsecond\\n' > '${filename}' && cat '${filename}'`,
  );
  expect(result.success, result.text).toBe(true);
  expect(await readFile(filename, "utf8")).toBe("first\nsecond\n");
  expect(result.effectReceipts?.[0]?.outcome).toBe("applied");
  const recorded = JSON.stringify(result);
  const projected = projectToolResultForModel({
    ...result,
    success: result.success === true,
  });
  expect(projected.text).toBe(result.text);
  expect(projected.effectReceipts).toEqual(result.effectReceipts);
  expect(projected.data).toEqual(result.promptData);
  expect(projected.data).not.toHaveProperty("outputAttachment");
  expect(projected.text).toContain("first\nsecond");
  expect(JSON.stringify(projected).length).toBeLessThan(recorded.length);
  expect(JSON.stringify(result)).toBe(recorded);
  const memoryId = result.data?.outputAttachmentMemoryId;
  expect(typeof memoryId).toBe("string");
  const memory = await fixture.runtime.getMemoryById(memoryId as UUID);
  expect(memory?.content.attachments?.[0]?.text).toBe(result.text);
}, 120_000);

it("keeps terminal authorization failures nonretryable and never executes the command", async () => {
  const filename = path.join(directory, "unauthorized.txt");
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/terminal/run`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
        "X-Eliza-Terminal-Token": "invalid-synthetic-token",
      },
      body: JSON.stringify({
        command: `touch '${filename}'`,
        clientId: "terminal-acceptance",
        captureOutput: true,
      }),
    },
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    code: "TERMINAL_AUTHORIZATION_REQUIRED",
    acceptance: "rejected",
    executionStatus: "not_started",
    retryable: false,
  });
  await expect(access(filename)).rejects.toThrow();
});
