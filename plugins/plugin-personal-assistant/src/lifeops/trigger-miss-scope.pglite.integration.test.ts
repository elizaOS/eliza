/** With the owner reminder family registered, a trigger miss makes no claim about the owner's reminders; real plugin and PGlite store. */
import { type Memory, TaskService, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { triggerAction } from "../../../../packages/agent/src/actions/trigger.ts";
import {
  createLifeOpsTestRuntime,
  seedOwnerReminder,
} from "../../test/helpers/runtime.js";
import { LifeOpsService } from "./service.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
beforeAll(async () => {
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
}, 120_000);
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

function ownerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId: crypto.randomUUID() as UUID,
    content: { text },
  } as Memory;
}

// A cancel routed to TRIGGER_DELETE finds no trigger; the miss must not tell
// the owner that no reminder exists while their reminder is still set.
it("scopes a TRIGGER_DELETE miss to triggers while the owner reminder is set", async () => {
  await seedOwnerReminder(service, "Pay the electric bill");
  const result = await triggerAction.handler(
    fixture.runtime,
    ownerMessage("never mind, cancel the electric one"),
    undefined,
    {
      parameters: { action: "delete", displayName: "pay the electric bill" },
    },
  );
  expect(result).toMatchObject({
    success: false,
    error: "TRIGGER_NOT_FOUND",
    data: { readOnlyOperation: true },
  });
  expect(result?.text).toContain("owner reminders");
  expect(result?.userFacingText).toBeUndefined();
});
