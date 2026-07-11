/**
 * Round-trip coverage for the shared outbound sanitization boundary (#15888):
 * a model that drifts out of the eliza response grammar emits native tool-call
 * syntax (`<tool_call>`, `<function_call>`) as visible text, and the SHARED
 * post-model boundary in `@elizaos/core` — not any connector — must strip it.
 *
 * Three real seams are driven against a real PGLite-backed AgentRuntime:
 * `runtime.messageService.handleMessage` (the entrypoint every text connector
 * uses) with a RESPONSE_HANDLER fixture reproducing the observed drift,
 * `runtime.sendMessageToTarget` through a registered send-handler dispatch
 * shim (the proactive-send chokepoint), and the mandatory
 * `outgoing_before_deliver` pipeline phase. Nothing in the unit under test is
 * mocked — the fixture stands in for the remote model only.
 */
import {
  ChannelType,
  type Content,
  createMessageMemory,
  type HandlerCallback,
  type JsonValue,
  type Memory,
  ModelType,
  outgoingPipelineHookContext,
  type SendHandlerFunction,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

/**
 * A stage-1 HANDLE_RESPONSE args payload, JSON-stringified the way a model
 * that answers in plain JSON text does, carrying the caller's (deliberately
 * drifted) replyText — the reproduction of the live leak from #15812. Only the
 * fields the turn's HANDLE_RESPONSE tool schema requests may appear.
 */
function driftedHandleResponse(replyText: string): string {
  const args: Record<string, JsonValue> = {
    contexts: ["simple"],
    intents: [],
    replyText,
    candidateActionNames: [],
  };
  return JSON.stringify(args);
}

async function runDriftTurn(replyText: string): Promise<{
  delivered: Content[];
  responseText: string | undefined;
}> {
  const harness = track(
    await withMockLlmRuntime({
      strict: false,
      fixtures: [
        {
          name: "drifted-stage1",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          response: driftedHandleResponse(replyText),
        },
      ],
    }),
  );
  const { runtime } = harness;

  const worldId = stringToUuid("sanitize-loop-world") as UUID;
  const roomId = stringToUuid("sanitize-loop-room") as UUID;
  const userId = stringToUuid("sanitize-loop-user") as UUID;

  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "Tester",
    source: "test-connector",
    channelId: roomId,
    type: ChannelType.DM,
  });

  const inbound: Memory = createMessageMemory({
    id: stringToUuid(`sanitize-loop-msg-${stringToUuid(replyText)}`) as UUID,
    entityId: userId,
    roomId,
    content: {
      text: "What's the weather like?",
      source: "test-connector",
      channelType: ChannelType.DM,
    },
  });

  const delivered: Content[] = [];
  const callback: HandlerCallback = async (content) => {
    delivered.push(content);
    return [];
  };

  const service = runtime.messageService;
  if (!service) {
    throw new Error("runtime.messageService is not initialized");
  }
  const result = await service.handleMessage(runtime, inbound, callback, {});
  return { delivered, responseText: result.responseContent?.text };
}

describe("shared outbound sanitization (#15888)", () => {
  it("strips a drifted native tool_call before the connector callback fires", async () => {
    const { delivered, responseText } = await runDriftTurn(
      'The forecast looks clear.<tool_call>get_weather\n{"city":"Lisbon"}',
    );

    const texts = delivered
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string");
    expect(
      texts.length,
      "the turn delivered at least one text reply",
    ).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text, "no delivered text carries native tool syntax").not.toMatch(
        /<\/?(?:tool_call|function_call)\b/i,
      );
    }
    expect(texts).toContain("The forecast looks clear.");
    // The persisted response row went through `outgoing_before_deliver`, so
    // stored history matches the wire text instead of keeping the leak.
    expect(responseText).toBe("The forecast looks clear.");
  }, 120_000);

  it("preserves fenced documentation examples while stripping unfenced syntax", async () => {
    // The fenced example uses <function_call>: paired <tool_call> markup is
    // already removed upstream by the stage-1 replyText junk-stripper
    // (`stripJsonStructuralJunkReply`, #11712), which has no fence protection
    // — only text that survives stage-1 parsing reaches the shared boundary.
    const fencedExample =
      "Native syntax looks like:\n```xml\n<function_call>lookup(x)</function_call>\n```";
    const { delivered } = await runDriftTurn(
      `${fencedExample}\nRunning it now.<function_call>lookup(x)</function_call>`,
    );

    const texts = delivered
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string");
    expect(texts).toContain(`${fencedExample}\nRunning it now.`);
  }, 120_000);

  it("sanitizes agent-initiated sends at the sendMessageToTarget dispatch shim", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const dispatched: Content[] = [];
    const sendHandler: SendHandlerFunction = async (
      _runtime,
      _target,
      content,
    ) => {
      dispatched.push(content);
      return undefined;
    };
    runtime.registerSendHandler("sanitize-probe", sendHandler);

    const target: TargetInfo = {
      source: "sanitize-probe",
      channelId: "sanitize-probe-channel",
      roomId: stringToUuid("sanitize-probe-room") as UUID,
    };
    // `agentVoiced: true` marks the text as already model-voiced so the
    // humanness voice gate passes it through instead of rephrasing — the
    // sanitizer must still fire after the gate.
    await runtime.sendMessageToTarget(target, {
      text: "Reminder sent.<tool_call>schedule_next</tool_call><|im_end|>",
      agentVoiced: true,
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].text).toBe("Reminder sent.");
    expect(dispatched[0].agentVoiced).toBe(true);
  }, 120_000);

  it("sanitizes content at the outgoing_before_deliver phase before persistence", async () => {
    const harness = track(await withMockLlmRuntime({ strict: false }));
    const { runtime } = harness;

    const content: Content = {
      text: "Saved your note.<thinking>should I add more",
    };
    await runtime.applyPipelineHooks(
      "outgoing_before_deliver",
      outgoingPipelineHookContext(content, {
        source: "simple",
        roomId: stringToUuid("sanitize-phase-room") as UUID,
      }),
    );

    expect(content.text).toBe("Saved your note.");
  }, 120_000);
});
