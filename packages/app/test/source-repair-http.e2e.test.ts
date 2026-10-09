/** Real HTTP + AgentRuntime + PGlite; only inference is deterministic. */
import { randomUUID } from "node:crypto";
import { ModelType, type Plugin } from "@elizaos/core";
import {
  createConversation,
  postConversationMessage,
} from "@elizaos/testing/runtime";
import { expect, test } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import { createRealTestRuntime } from "./helpers/real-runtime.ts";

const original = "SOURCE-REPAIR fixture: preserve  two spaces and punctuation.";
const corrected =
  "The invalid quote was discarded; this is the repaired reply.";
for (const scenario of ["repair", "repeat-invalid", "valid-quote"] as const) {
  test(`HTTP source integrity: ${scenario}`, async () => {
    const prior = new Map(
      [
        "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
        "ELIZA_DISABLE_PROACTIVE_AGENT",
        "ELIZA_STAGE1_TERMINAL_REASK",
      ].map((k) => [k, process.env[k]]),
    );
    process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS = "1";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
    process.env.ELIZA_STAGE1_TERMINAL_REASK = "false";
    let seed = true;
    const calls: Array<{ messages: unknown; tools: unknown }> = [];
    const plugin: Plugin = {
      name: "source-repair-deterministic-inference",
      description: "No external provider calls",
      models: {
        [ModelType.RESPONSE_HANDLER]: async (_runtime, params) => {
          const p = params as { messages: unknown; tools: unknown };
          if (
            !Array.isArray(p.tools) ||
            !p.tools.some(
              (tool: { name?: string }) => tool.name === "HANDLE_RESPONSE",
            )
          )
            throw new Error(
              "Fixture supports Stage1 only; use the ordinary non-generative failure fallback",
            );
          if (!seed) calls.push({ messages: p.messages, tools: p.tools });
          const quote =
            scenario === "valid-quote"
              ? original
              : `INVALID-UNSUPPLIED-QUOTE-${randomUUID()}`;
          const replyText = seed
            ? "Fixture stored."
            : scenario === "repair" && calls.length === 2
              ? [{ kind: "text", value: corrected }]
              : [{ kind: "source", value: quote }];
          return {
            text: Promise.resolve(""),
            textStream: (async function* () {})(),
            usage: Promise.resolve(undefined),
            toolCalls: [
              {
                id: randomUUID(),
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  contexts: ["simple"],
                  contextRequests: [],
                  intents: [],
                  replyText,
                  replyEffectStatus: "none",
                  facts: [],
                  relationships: [],
                  addressedTo: [],
                  emotion: "none",
                },
              },
            ],
            finishReason: Promise.resolve("tool-calls"),
          };
        },
      },
    };
    let real: Awaited<ReturnType<typeof createRealTestRuntime>> | undefined;
    let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
    try {
      real = await createRealTestRuntime({
        withLLM: false,
        plugins: [plugin],
        characterName: "SourceRepairHTTP",
      });
      server = await startApiServer({
        port: 0,
        runtime: real.runtime,
        skipDeferredStartupWork: true,
      });
      const conversation = await createConversation(server.port, {
        title: "Source repair HTTP",
        includeGreeting: false,
      });
      expect(conversation.status).toBe(200);
      const seeded = await postConversationMessage(
        server.port,
        conversation.conversationId,
        { text: original, channelType: "DM" },
      );
      expect(seeded.status).toBe(200);
      expect(seeded.data.text).toBe("Fixture stored.");
      seed = false;
      const response = await postConversationMessage(
        server.port,
        conversation.conversationId,
        {
          text: "Quote the original fixture message exactly; do not perform actions.",
          channelType: "DM",
        },
      );
      expect(response.status).toBe(200);
      // This must be the source-enabled real request, never a mock snapshot.
      expect(JSON.stringify(calls[0].tools)).toContain("source");
      expect(JSON.stringify(calls[0].messages)).toContain(original);
      if (scenario === "repair") {
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls[1].messages)).toContain(
          "invalid source quote",
        );
        expect(response.data.text).toBe(corrected);
        expect(response.data.assistantEphemeral).not.toBe(true);
      } else if (scenario === "repeat-invalid") {
        expect(calls).toHaveLength(2);
        expect(response.data.assistantEphemeral).toBe(true);
        expect(String(response.data.text)).not.toContain(
          "INVALID-UNSUPPLIED-QUOTE",
        );
      } else {
        expect(calls).toHaveLength(1);
        expect(response.data.text).toBe(original);
        expect(response.data.assistantEphemeral).not.toBe(true);
      }
      const history = await fetch(
        `http://127.0.0.1:${server.port}/api/conversations/${conversation.conversationId}/messages`,
      ).then((r) => r.json());
      expect(JSON.stringify(history)).not.toContain("INVALID-UNSUPPLIED-QUOTE");
      if (scenario === "repair")
        expect(JSON.stringify(history)).toContain(corrected);
    } finally {
      await server?.close();
      await real?.cleanup();
      for (const [k, v] of prior)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  }, 120000);
}

test("HTTP repaired source decision creates one real pending Maps proposal without poisoned facts", async () => {
  const { authStoreForRuntime } = await import("../src/services/auth-store.ts");
  const { installAgentHostBridge } = await import(
    "../src/runtime/install-agent-host-bridge.ts"
  );
  const { _resetAgentHostBridge } = await import(
    "@elizaos/agent/runtime/host-bridge"
  );
  const { createMachineSession } = await import("../src/api/auth/sessions.ts");
  const { DeviceActionService } = await import(
    "../../../plugins/plugin-assistant/src/services/device-actions/service.ts"
  );
  const { ApprovalService, APPROVAL_SERVICE } = await import(
    "../../../plugins/plugin-assistant/src/services/approval/service.ts"
  );
  const owner = randomUUID(),
    installationId = randomUUID(),
    deviceKey = "d".repeat(64),
    operationKey = randomUUID();
  const target = {
    kind: "map-route",
    id: `maps_${randomUUID()}`,
    revision: "1",
  };
  const poison = `POISONED_SOURCE_FACT_${randomUUID()}`;
  let seed = true,
    stage1 = 0,
    planner = 0,
    proposalSent = false,
    factValidation = 0;
  const call = (name: string, args: unknown) => ({
    text: Promise.resolve(""),
    textStream: (async function* () {})(),
    usage: Promise.resolve(undefined),
    toolCalls: [{ id: randomUUID(), name, arguments: args }],
    finishReason: Promise.resolve("tool-calls"),
  });
  const plugin: Plugin = {
    name: "source-repair-device-model",
    description: "Deterministic inference, real effects",
    models: {
      [ModelType.RESPONSE_HANDLER]: async (_runtime, params) => {
        const p = params as { tools?: Array<{ name: string }> };
        if (
          p.tools?.some((t) => t.name === "FACTS_AND_RELATIONSHIPS_VALIDATE")
        ) {
          factValidation++;
          throw Error("Poisoned facts must never reach validation");
        }
        if (p.tools?.some((t) => t.name === "HANDLE_RESPONSE")) {
          if (!seed) stage1++;
          return call("HANDLE_RESPONSE", {
            shouldRespond: "RESPOND",
            contexts: [seed ? "simple" : "general"],
            contextRequests: [],
            intents: seed
              ? []
              : [
                  "Propose the selected Maps route read and await owner approval.",
                ],
            replyText: seed
              ? "Fixture stored."
              : stage1 === 1
                ? [{ kind: "source", value: "NOT_A_SUPPLIED_ORIGINAL" }]
                : [
                    {
                      kind: "text",
                      value: "I will propose the read for approval.",
                    },
                  ],
            replyEffectStatus: seed ? "none" : "pending",
            facts: !seed && stage1 === 1 ? [poison] : [],
            relationships: [],
            addressedTo: [],
            emotion: "none",
          });
        }
        return JSON.stringify({
          thought: "Awaiting explicit owner review.",
          decision: proposalSent ? "FINISH" : "CONTINUE",
          success: proposalSent,
          requestFullyCovered: proposalSent,
          outcomeCoverage: proposalSent
            ? [
                {
                  intentId: "intent:1",
                  status: "completed",
                  evidenceStepIds: ["step:1"],
                },
              ]
            : [],
          messageToUser: proposalSent
            ? "The read proposal is pending your approval."
            : "",
          replyEffectStatus: "pending",
          effectReceiptIds: [],
        });
      },
      [ModelType.ACTION_PLANNER]: async (_runtime, params) => {
        planner++;
        if (planner > 5) throw Error("Unexpected repeated planner execution");
        const p = params as { tools?: Array<{ name: string }> };
        if (
          !proposalSent &&
          !p.tools?.some((t) => t.name === "PROPOSE_DEVICE_ACTION")
        )
          return call("DISCOVER_ACTIONS", {
            names: ["PROPOSE_DEVICE_ACTION"],
            mode: "load",
            eliza_turn_scope: "more_work_pending",
          });
        if (!proposalSent) {
          proposalSent = true;
          return call("PROPOSE_DEVICE_ACTION", {
            operation: { type: "maps_read_selected", target },
            operationKey,
            reason: "Synthetic selected route review",
            eliza_turn_scope: "final",
          });
        }
        return call("REPLY", {
          text: "The read proposal is pending your approval.",
          eliza_turn_scope: "final",
        });
      },
    },
  };
  const real = await createRealTestRuntime({
    withLLM: false,
    plugins: [plugin],
    characterName: "SourceRepairDeviceHTTP",
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    installAgentHostBridge();
    await real.runtime.registerService(ApprovalService);
    await real.runtime.getServiceLoadPromise(APPROVAL_SERVICE);
    const store = authStoreForRuntime(real.runtime);
    if (!store) throw Error("Actual runtime auth store unavailable");
    await store.createIdentity({
      id: owner,
      kind: "machine",
      displayName: "Fixture owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    const session = await createMachineSession(store, {
      identityId: owner,
      scopes: [],
    });
    const headers = {
      Authorization: `Bearer ${session.session.id}`,
      "X-Eliza-Device-Id": installationId,
      "X-Eliza-Device-Key": deviceKey,
      "X-Eliza-Device-Capabilities":
        "calendar.local-event.v1,notes.local-record.v1,reminders.local-record.v1,maps.selected-read.v1",
    };
    server = await startApiServer({
      port: 0,
      runtime: real.runtime,
      skipDeferredStartupWork: true,
    });
    const register = await fetch(
      `http://127.0.0.1:${server.port}/api/client-devices/register`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Synthetic phone", workflowProtocol: 1 }),
      },
    );
    expect(register.status).toBe(200);
    const conversation = await createConversation(
      server.port,
      { title: "Device source repair", includeGreeting: false },
      headers,
    );
    expect(conversation.status).toBe(200);
    const seeded = await postConversationMessage(
      server.port,
      conversation.conversationId,
      { text: original, channelType: "DM" },
      headers,
    );
    expect(seeded.data.text).toBe("Fixture stored.");
    seed = false;
    const context = {
      revision: 1,
      view: "maps",
      sensitive: false,
      selectedObject: target,
    };
    const response = await postConversationMessage(
      server.port,
      conversation.conversationId,
      {
        text: "Propose exactly one read of the selected Maps route. Do not execute it; await approval.",
        channelType: "DM",
        metadata: { clientDevice: { context }, alphaPhone: { context } },
      },
      headers,
    );
    expect(response.status).toBe(200);
    expect(response.data.assistantEphemeral).not.toBe(true);
    expect(stage1).toBe(2);
    const proposals = await new DeviceActionService(real.runtime).list({
      subjectUserId: owner,
      installationId,
      deviceKey,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].state).toBe("pending");
    if (!("operation" in proposals[0].payload))
      throw new Error("Expected device action payload");
    expect(proposals[0].payload.operation).toEqual({
      type: "maps_read_selected",
      target,
    });
    expect(proposals[0].execution?.providerReceipt).toBeUndefined();
    expect(factValidation).toBe(0);
    const roomId = (conversation.data.conversation as { roomId: string })
      .roomId;
    const facts = await real.runtime.getMemories({
      tableName: "facts",
      roomId: roomId as Parameters<
        typeof real.runtime.getMemories
      >[0]["roomId"],
      count: 100,
    });
    expect(JSON.stringify(facts)).not.toContain(poison);
  } finally {
    await server?.close();
    _resetAgentHostBridge();
    await real.cleanup();
  }
}, 120000);
