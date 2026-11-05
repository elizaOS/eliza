/**
 * Submits a form on a real AgentRuntime whose agent world was never created.
 * Submission and autofill records live in the agent's self room with
 * worldId = agentId; the runtime creates that room at start but not the world,
 * and the SQL adapter's components.world_id foreign key needs it. The other
 * real-runtime tests create that world in beforeAll, so they cannot see this.
 */
import assert from "node:assert/strict";
import {
  ChannelType,
  type Memory,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formEvaluator } from "./evaluators/extractor";
import formPlugin from "./index";
import { FormService } from "./service";
import { getAutofillData } from "./storage";

const state: State = { values: {}, data: {}, text: "" };

describe("form submission without an agent world", () => {
  let harness: Awaited<ReturnType<typeof createTestRuntime>>;
  let service: FormService;
  const userId = stringToUuid("form-agent-world-user");
  const worldId = stringToUuid("form-agent-world-guild");

  beforeAll(async () => {
    harness = await createTestRuntime({
      characterName: "FormAgentWorld",
      plugins: [formPlugin],
    });
    await harness.runtime.getServiceLoadPromise(FormService.serviceType);
    const formService = harness.runtime.getService<FormService>(
      FormService.serviceType,
    );
    assert(formService);
    service = formService;
    service.registerForm({
      id: "contact",
      name: "Contact",
      controls: [{ key: "name", label: "Name", type: "text", required: true }],
    });
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  }, 60_000);

  async function openRoom(name: string): Promise<UUID> {
    const roomId = stringToUuid(`form-agent-world-${name}`);
    await harness.runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      worldName: "Guild",
      userName: "ann",
      name: "Ann",
      source: "discord",
      type: ChannelType.GROUP,
      channelId: name,
      messageServerId: worldId,
    });
    await service.startSession("contact", userId, roomId);
    return roomId;
  }

  /** One user turn: model output -> evaluator parse -> processors. */
  async function turn(roomId: UUID, text: string, raw: unknown) {
    const { prepare, parse, processors = [] } = formEvaluator;
    assert(prepare && parse && processors.length > 0);
    const context = {
      runtime: harness.runtime,
      message: {
        id: stringToUuid(`${roomId}:${text}`),
        entityId: userId,
        agentId: harness.runtime.agentId,
        roomId,
        content: { text },
      } satisfies Memory,
      state,
      options: {},
    };
    const prepared = await prepare(context);
    const output = parse(raw as never, context as never);
    assert(output);
    for (const processor of processors) {
      await processor.process({
        ...context,
        prepared,
        output,
        evaluatorName: formEvaluator.name,
      });
    }
  }

  it("submits a completed form and records the submission and autofill", async () => {
    const runtime = harness.runtime;
    expect((await runtime.getRoom(runtime.agentId))?.worldId).toBe(
      runtime.agentId,
    );
    expect(await runtime.getWorld(runtime.agentId)).toBeNull();

    const roomId = await openRoom("first");
    await turn(roomId, "I'm Ann", {
      formIntent: "fill_form",
      formExtractions: [{ field: "name", value: "Ann", confidence: 0.95 }],
    });
    expect((await service.getActiveSession(userId, roomId))?.status).toBe(
      "ready",
    );

    await turn(roomId, "Submit it", {
      formIntent: "submit",
      formExtractions: [],
    });

    const submissions = await service.getSubmissions(userId, "contact");
    expect(submissions.map((submission) => submission.values)).toEqual([
      { name: "Ann" },
    ]);
    expect((await getAutofillData(runtime, userId, "contact"))?.values).toEqual(
      { name: "Ann" },
    );
    expect(await service.getActiveSession(userId, roomId)).toBeNull();
    expect((await runtime.getWorld(runtime.agentId))?.agentId).toBe(
      runtime.agentId,
    );
  }, 60_000);

  it("leaves an existing agent world as it is", async () => {
    const runtime = harness.runtime;
    // Create or rename the world here, so this case does not need the first.
    await runtime.ensureWorldExists({
      id: runtime.agentId,
      agentId: runtime.agentId,
      name: "Agent home",
    });
    const before = await service.getSubmissions(userId, "contact");

    const roomId = await openRoom("second");
    await turn(roomId, "Bo", {
      formIntent: "fill_form",
      formExtractions: [{ field: "name", value: "Bo", confidence: 0.95 }],
    });
    await turn(roomId, "Send it", {
      formIntent: "submit",
      formExtractions: [],
    });

    expect(await service.getSubmissions(userId, "contact")).toHaveLength(
      before.length + 1,
    );
    expect((await runtime.getWorld(runtime.agentId))?.name).toBe("Agent home");
  }, 60_000);
});
