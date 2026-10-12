/**
 * ENTITY log_interaction name resolution: a whole-word name match must win
 * over a substring match, mirroring the whole-word contract merged for
 * notes (#35741) and voice-call contact resolution (#35729).
 * "Ann" is a whole word of "Zoe Ann" but only a substring of "Bethann Cole"
 * (and of the email "bethann@example.com"), and "Bethann Cole" sorts and is
 * inserted first, so a substring-first resolver picks the wrong person.
 * A fragment like "Beth" keeps resolving through the substring fallback.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { TaskService } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import { entityAction } from "./entity.js";

describe("ENTITY name resolution whole-word preference (real PGlite)", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let service: LifeOpsService;
  let zoeId: string;
  let bethannId: string;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    await TaskService.stop(runtime);
    service = new LifeOpsService(runtime, {
      ownerEntityId: runtime.agentId,
    });
    const bethann = await service.upsertRelationship({
      name: "Bethann Cole",
      primaryChannel: "email",
      primaryHandle: "bethann@example.com",
      email: "bethann@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    bethannId = bethann.id;
    const zoe = await service.upsertRelationship({
      name: "Zoe Ann",
      primaryChannel: "email",
      primaryHandle: "zoe@example.com",
      email: "zoe@example.com",
      phone: null,
      notes: "",
      tags: [],
      relationshipType: "contact",
      lastContactedAt: null,
      metadata: {},
    });
    zoeId = zoe.id;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  function message(text: string): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      content: { source: "autonomy", text },
    } as Memory;
  }

  async function logInteraction(name: string) {
    return entityAction.handler(
      runtime,
      message(`Log that I talked to ${name}`),
      undefined,
      {
        parameters: {
          subaction: "log_interaction",
          name,
          notes: "whole-word probe",
        },
      },
      undefined,
    );
  }

  it("resolves 'Ann' to Zoe Ann, not the substring match Bethann Cole", async () => {
    const result = await logInteraction("Ann");
    expect(result.success).toBe(true);
    const data = result.data as { interaction?: { relationshipId?: string } };
    expect(data.interaction?.relationshipId).toBe(zoeId);
    expect(data.interaction?.relationshipId).not.toBe(bethannId);
  });

  it("still resolves the fragment 'Beth' to Bethann Cole via fallback", async () => {
    const result = await logInteraction("Beth");
    expect(result.success).toBe(true);
    const data = result.data as { interaction?: { relationshipId?: string } };
    expect(data.interaction?.relationshipId).toBe(bethannId);
  });

  it("still resolves the whole word 'Cole' to Bethann Cole", async () => {
    const result = await logInteraction("Cole");
    expect(result.success).toBe(true);
    const data = result.data as { interaction?: { relationshipId?: string } };
    expect(data.interaction?.relationshipId).toBe(bethannId);
  });
});
