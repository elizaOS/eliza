// External-API contract test for the 'scape operator telemetry pipeline.
//
// The view's extractTelemetry (+ its 10 extract* helpers in
// ScapeOperatorSurface.tsx) is the PARSER for telemetry produced by
// buildScapeSessionState() (src/routes.ts) from the REAL xRSPS PerceptionSnapshot
// wire type (src/sdk/types.ts). This test runs a real-shaped PerceptionSnapshot
// through the REAL producer (refreshRunSession -> buildScapeSessionState) and
// feeds the emitted session.telemetry back through the REAL consumer parser,
// asserting the round-trip is contract-valid: distance computed + nearest-first
// sort, position {x,z} mapping, weight/null handling, goal mapping, newest-first
// journal ordering. This proves the parser matches the producer's shape rather
// than a hand-written fixture.

import type { AppSessionJsonValue } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { extractTelemetry } from "./ui/ScapeOperatorSurface";
import { buildRealScapeSession, makeScapePerception } from "./ui/test-support";

describe("'scape telemetry parser contract (producer -> consumer)", () => {
  it("buildScapeSessionState emits a session the views can render", async () => {
    const session = await buildRealScapeSession();

    expect(session.appName).toBe("@elizaos/plugin-scape");
    expect(session.displayName).toBe("'scape");
    expect(session.mode).toBe("spectate-and-steer");
    // connected (not paused) -> ready.
    expect(session.status).toBe("ready");
    expect(session.canSendCommands).toBe(true);
    expect(session.controls).toEqual(["pause"]);
    expect(session.suggestedPrompts.length).toBeGreaterThan(0);
    expect(session.telemetry).toBeTruthy();
  });

  it("round-trips the real PerceptionSnapshot through extractTelemetry", async () => {
    const session = await buildRealScapeSession();
    const telemetry = extractTelemetry(
      session.telemetry as Record<string, AppSessionJsonValue>,
    );

    // Connection + agent self mapped from PerceptionSelf.
    expect(telemetry.connectionStatus).toBe("connected");
    expect(telemetry.agent).toMatchObject({
      name: "LumbridgeRanger",
      combatLevel: 4,
      hp: 8,
      maxHp: 10,
      runEnergy: 91,
      inCombat: false,
      tick: 128,
    });
    // self.x/self.z became a {x,z} position.
    expect(telemetry.agent?.position).toEqual({ x: 3225, z: 3265 });

    // Active goal mapped from the JournalGoal (operator source, 0.25 progress).
    expect(telemetry.activeGoal).toMatchObject({
      id: "goal-1",
      title: "Train attack on cows",
      status: "active",
      source: "operator",
      progress: 0.25,
    });
    expect(telemetry.activeGoal?.notes).toContain("Lumbridge cow field");

    // Journal memory: weight survives, position {x,z}, kind/text preserved.
    const memories = telemetry.journal?.recent ?? [];
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: "mem-1",
      kind: "goal",
      weight: 4,
      position: { x: 3225, z: 3265 },
    });
    expect(memories[0].text).toContain("cow");
  });

  it("computes Chebyshev distance and sorts nearby NPCs nearest-first", async () => {
    const session = await buildRealScapeSession();
    const telemetry = extractTelemetry(
      session.telemetry as Record<string, AppSessionJsonValue>,
    );

    const npcs = telemetry.nearby?.npcs ?? [];
    // Source array is Goblin (2 tiles), Cow (1 tile); producer reorders to
    // nearest-first -> Cow then Goblin, each with its tile distance.
    expect(npcs.map((n) => n.name)).toEqual(["Cow", "Goblin"]);
    expect(npcs[0]).toMatchObject({
      name: "Cow",
      distance: 1,
      position: { x: 3226, z: 3265 },
    });
    expect(npcs[1]).toMatchObject({ name: "Goblin", distance: 2 });

    // Player + ground item also carry distance + position.
    const players = telemetry.nearby?.players ?? [];
    expect(players[0]).toMatchObject({
      name: "Zezima",
      distance: 5,
      position: { x: 3230, z: 3266 },
    });
    const items = telemetry.nearby?.items ?? [];
    expect(items[0]).toMatchObject({
      name: "Bones",
      count: 1,
      distance: 2,
    });
  });

  it("maps skills (priority-sorted) and inventory through the producer", async () => {
    const session = await buildRealScapeSession();
    const telemetry = extractTelemetry(
      session.telemetry as Record<string, AppSessionJsonValue>,
    );

    const skills = telemetry.skills ?? [];
    // Producer mapSkills() priority-sorts Hitpoints/Attack/Strength ahead.
    expect(skills.map((s) => s.name)).toEqual([
      "Hitpoints",
      "Attack",
      "Strength",
    ]);
    expect(skills[1]).toMatchObject({ name: "Attack", level: 4 });

    const inventory = telemetry.inventory ?? [];
    expect(inventory).toEqual([
      expect.objectContaining({ name: "Shrimps", count: 3, slot: 0 }),
      expect.objectContaining({ name: "Bronze dagger", count: 1, slot: 1 }),
    ]);
  });

  it("emits an empty/idle telemetry shape when the service has no perception", async () => {
    // No service at all -> idle connection, no agent, empty nearby/journal.
    const session = await buildRealScapeSession({ withService: false });
    const telemetry = extractTelemetry(
      session.telemetry as Record<string, AppSessionJsonValue>,
    );

    expect(telemetry.connectionStatus).toBe("idle");
    expect(telemetry.agent).toBeNull();
    expect(telemetry.activeGoal).toBeNull();
    expect(telemetry.journal?.recent ?? []).toHaveLength(0);
    expect(telemetry.nearby?.npcs ?? []).toHaveLength(0);
    expect(telemetry.skills ?? []).toHaveLength(0);
  });

  it("the source perception fixture matches the xRSPS wire shape", () => {
    // Guard the fixture against drift from src/sdk/types.ts PerceptionSnapshot.
    const snap = makeScapePerception();
    expect(snap.self).toMatchObject({
      x: expect.any(Number),
      z: expect.any(Number),
      hp: expect.any(Number),
      maxHp: expect.any(Number),
      runEnergy: expect.any(Number),
      inCombat: expect.any(Boolean),
    });
    expect(snap.nearbyNpcs[0]).toMatchObject({
      id: expect.any(Number),
      defId: expect.any(Number),
      x: expect.any(Number),
      z: expect.any(Number),
    });
  });
});
