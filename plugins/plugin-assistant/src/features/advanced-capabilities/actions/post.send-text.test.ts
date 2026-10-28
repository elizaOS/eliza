/** POST action=send against a real runtime post-connector registry. */
import {
  type AgentRuntime,
  type Content,
  createCharacter,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { postAction } from "./post.ts";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function runtimeWithXConnector() {
  const posted: Content[] = [];
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "PostSend" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize({ skipMigrations: true });
  runtime.registerPostConnector({
    source: "x",
    label: "X",
    capabilities: ["post"],
    contexts: ["social"],
    postHandler: async (_runtime, content) => {
      posted.push(content);
      return undefined;
    },
  });
  return { runtime, posted };
}

function ownerMessage(runtime: AgentRuntime, text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { text, source: "client_chat" },
  };
}

describe("POST action=send text", () => {
  it("does not publish the owner's chat message when the call has no text", async () => {
    const { runtime, posted } = await runtimeWithXConnector();
    const result = await postAction.handler(
      runtime,
      ownerMessage(runtime, "post this on X"),
      undefined,
      { parameters: { action: "send", source: "x" } },
    );

    expect(posted).toEqual([]);
    expect(result).toMatchObject({ success: false });
  });

  it("publishes the text the call supplies", async () => {
    const { runtime, posted } = await runtimeWithXConnector();
    await postAction.handler(
      runtime,
      ownerMessage(runtime, "post this on X"),
      undefined,
      { parameters: { action: "send", source: "x", text: "shipping today" } },
    );

    expect(posted.map((content) => content.text)).toEqual(["shipping today"]);
  });
});
