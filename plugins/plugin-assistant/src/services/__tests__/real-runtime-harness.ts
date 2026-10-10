/** A real AgentRuntime on in-memory SQLite with one DM room; only Stage 1 is a deterministic model. */

import {
  type AgentRuntime,
  asUUID,
  ChannelType,
  createCharacter,
  type Memory,
  ModelType,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { v4 } from "uuid";
import { afterEach } from "vitest";
import { createAssistantPlugin } from "../../index.ts";
import { DefaultMessageService } from "../message.ts";

const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

export async function createRealRuntimeHarness(stage1: () => object) {
  const runtime = createSQLiteTestRuntime({
    plugins: [createAssistantPlugin()],
    character: createCharacter({ name: `Harness${v4().slice(0, 8)}` }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize();
  runtime.registerModel(
    ModelType.RESPONSE_HANDLER,
    async () => stage1(),
    "deterministic-test",
  );
  const roomId = asUUID(v4());
  const entityId = asUUID(v4());
  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId: asUUID(v4()),
    userName: "tester",
    name: "tester",
    source: "test",
    type: ChannelType.DM,
  });
  const service = new DefaultMessageService();
  runtime.messageService = service;
  const makeMessage = (text: string): Memory => ({
    id: asUUID(v4()),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text, source: "test", channelType: ChannelType.DM },
    createdAt: Date.now(),
  });
  return { runtime, service, makeMessage };
}
