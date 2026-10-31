/** A planner "0" entity filter is omitted when the user never wrote 0, even
 * when the hardened-connector envelope metadata carries a standalone 0. */

import {
  type ActionResult,
  ChannelType,
  type HandlerOptions,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { wrapExternalContent } from "../../../../../packages/core/src/security/external-content.ts";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { documentAction } from "./actions.ts";
import { DocumentService } from "./service.ts";

const owner = "f4350000-0000-4000-8000-000000000001" as UUID;
const room = "f4350000-0000-4000-8000-000000000002" as UUID;
const world = "f4350000-0000-4000-8000-000000000003" as UUID;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  fixture = await createTestRuntime({
    characterName: "DocumentListZeroFilterEnvelope",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner, LOAD_DOCS_ON_STARTUP: false },
    plugins: [
      {
        name: "document-list-zero-filter-envelope-fixture",
        description: "Real document service",
        services: [DocumentService],
      },
    ],
  });
  await fixture.runtime.ensureConnection({
    entityId: owner,
    roomId: room,
    worldId: world,
    worldName: "Synthetic document list",
    userName: "Owner",
    name: "Synthetic",
    source: "test",
    type: ChannelType.DM,
  });
}, 120_000);
afterAll(async () => {
  if (fixture) await fixture.cleanup();
}, 120_000);

async function dispatchList(
  message: Memory,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const output = await documentAction.handler(
    fixture.runtime,
    message,
    undefined,
    { parameters: { action: "list", ...parameters } } as HandlerOptions,
  );
  if (!output || typeof output !== "object" || !("success" in output))
    throw new Error("Missing action result");
  return output;
}

it("drops a planner 0 filter when only the envelope subject carries a 0", async () => {
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: owner,
    agentId: fixture.runtime.agentId,
    roomId: room,
    worldId: world,
    content: {
      text: wrapExternalContent("list my documents", {
        source: "email",
        sender: "teammate@example.com",
        subject: "release 2.0 notes",
        purpose: "incoming_message",
      }),
      metadata: { externalContentWrapped: true },
    },
  };
  const output = await dispatchList(message, { scopedToEntityId: "0" });
  expect(output.success).toBe(true);
});
