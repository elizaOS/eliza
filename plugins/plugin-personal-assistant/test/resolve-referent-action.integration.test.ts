/**
 * `RESOLVE_REFERENT` action — real end-to-end integration test.
 *
 * Boots a real PGLite-backed runtime (real `facts` memory table, real cache)
 * and drives the real action handler — no resolver mock. Proves the live path:
 * candidate gathering from the fact memory table + OwnerFactStore, ranking by
 * `resolveImplicitReferent`, a confident resolution returning the confirmation
 * preview, and an ambiguous ask writing a real disambiguating pending prompt
 * into the (cache-backed) PendingPromptsStore. Owner access is satisfied by the
 * agent-as-owner message (`entityId === agentId`, i.e. `isAgentSelf`).
 *
 * The runtime is deliberately minimal (no PA plugin barrel) so the store-backed
 * resolution path is exercised without booting the connector/React graph; the
 * OwnerFactStore and PendingPromptsStore both fall back to the same cache the
 * production services use, so behavior is identical.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChannelType,
  type HandlerOptions,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { resolveReferentAction } from "../src/actions/resolve-referent.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import { resolvePendingPromptsStore } from "../src/lifeops/pending-prompts/store.js";

let testRuntime: RealTestRuntimeResult;
let runtime: RealTestRuntimeResult["runtime"];
let stateDir: string;
let previousStateDir: string | undefined;

const ROOM_ID = "00000000-0000-4000-8000-00000000c0de" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-0000000000d1" as UUID;

function ownerMessage(text: string): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: runtime.agentId as UUID,
    roomId: ROOM_ID,
    content: { text },
  } as Memory;
}

async function seedFact(
  text: string,
  metadata: { confidence?: number; keywords?: string[]; validAt?: string },
): Promise<void> {
  await runtime.createMemory(
    {
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId as UUID,
      agentId: runtime.agentId as UUID,
      roomId: ROOM_ID,
      content: { text },
      metadata: {
        type: "custom",
        source: "test_seed",
        kind: "durable",
        category: "preference",
        ...metadata,
      },
    } as unknown as Memory,
    "facts",
  );
}

async function runHandler(text: string) {
  return resolveReferentAction.handler(
    runtime,
    ownerMessage(text),
    undefined,
    { parameters: {} } as unknown as HandlerOptions,
    async () => undefined,
  );
}

beforeAll(async () => {
  previousStateDir = process.env.ELIZA_STATE_DIR;
  stateDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "resolve-referent-"),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
  testRuntime = await createRealTestRuntime({
    characterName: "resolve-referent-test-agent",
  });
  runtime = testRuntime.runtime;
  await runtime.ensureWorldExists({
    id: WORLD_ID,
    name: "resolve-referent-world",
    agentId: runtime.agentId,
  } as Parameters<typeof runtime.ensureWorldExists>[0]);
  await runtime.ensureConnection({
    entityId: runtime.agentId,
    roomId: ROOM_ID,
    worldId: WORLD_ID,
    userName: "owner",
    name: "owner",
    source: "test",
    channelId: "resolve-referent-room",
    type: ChannelType.DM,
  });
}, 180_000);

afterAll(async () => {
  await testRuntime?.cleanup();
  await fs.promises.rm(stateDir, { recursive: true, force: true });
  if (previousStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = previousStateDir;
  }
});

describe("RESOLVE_REFERENT action (real runtime)", () => {
  it("validates only for under-specified asks", async () => {
    await expect(
      resolveReferentAction.validate(runtime, ownerMessage("Book the usual.")),
    ).resolves.toBe(true);
    await expect(
      resolveReferentAction.validate(
        runtime,
        ownerMessage("Book a table at Osteria for 7pm."),
      ),
    ).resolves.toBe(false);
  });

  it("resolves 'the usual' against a high-confidence owner fact and previews it", async () => {
    // One clearly-dominant fact (high confidence prior + lexical 'usual') and a
    // weak distractor. The resolver must confidently pick the strong one.
    await seedFact(
      "Owner's usual dinner is the corner table at Osteria at 7pm.",
      { confidence: 0.95, keywords: ["usual", "dinner", "osteria"] },
    );
    await seedFact("Owner sometimes grabs coffee.", {
      confidence: 0.1,
      keywords: ["coffee"],
    });

    const result = await runHandler("Book the usual.");
    expect(result?.success).toBe(true);
    expect(result?.data?.decision).toBe("resolved");
    expect(String(result?.text)).toContain("Osteria");
  });

  it("records a real disambiguating pending prompt when it must ask", async () => {
    // Two near-identical owner facts leave the resolver unable to choose, so it
    // asks — and must persist that open question to the PendingPromptsStore.
    await seedFact(
      "Owner's usual is the board prep block on Thursday afternoon.",
      { confidence: 0.6, keywords: ["usual", "board", "thursday"] },
    );
    await seedFact(
      "Owner's usual is the investor prep block on Thursday afternoon.",
      { confidence: 0.6, keywords: ["usual", "investor", "thursday"] },
    );

    const before = await resolvePendingPromptsStore(runtime).list(ROOM_ID);
    const result = await runHandler("Clear the usual for Thursday.");
    expect(result?.success).toBe(true);
    // Two equally-weighted facts force a tie the resolver cannot break, so it
    // asks — and the open question must land as a real pending prompt.
    expect(result?.data?.decision).toBe("ask");
    expect(String(result?.text).length).toBeGreaterThan(0);
    const after = await resolvePendingPromptsStore(runtime).list(ROOM_ID);
    expect(after.length).toBeGreaterThan(before.length);
    expect(
      after.some((prompt) => prompt.taskId.startsWith("implicit-referent:")),
    ).toBe(true);
  });

  it("gathers OwnerFactStore preferences as candidates without crashing on empty stores", async () => {
    await resolveOwnerFactStore(runtime).update(
      { travelBookingPreferences: "aisle seat, red-eye, TSA-pre" },
      { source: "profile_save", recordedAt: new Date().toISOString() },
    );
    const result = await runHandler("Book the usual travel for me.");
    expect(result?.success).toBe(true);
    expect(["resolved", "ask"]).toContain(result?.data?.decision);
  });
});
