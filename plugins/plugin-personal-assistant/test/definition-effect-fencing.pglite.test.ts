/**
 * Adversarial controls for third-party-effect fencing on definition mutations,
 * against the production LifeOps repository on real PGlite.
 *
 * The control these tests exist to satisfy is the one raised in review of
 * `724faa7fcb54c36cd318de91573ae7536e9c11fa`:
 *
 *   "A lease renewed before a native side effect can expire while the side
 *    effect is blocked. In a real PGlite control, executor A paused inside
 *    native sync, B took over and completed, then A resumed; observed effects
 *    were ["winner", "stale"]."
 *
 * The structural claim under test is that a wall-clock lease can never be the
 * thing that authorizes an third-party effect, because elapsed time cannot
 * distinguish "the holder is dead" from "the holder is blocked inside the
 * provider call". These tests therefore drive the effect-claim API the same
 * way a real executor does, with a provider stub that records every call, and
 * assert on the recorded call list rather than on return values.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTaskDefinition,
  type LifeOpsDefinitionScope,
  LifeOpsRepository,
} from "../src/lifeops/repository.ts";
import type { RealTestRuntimeResult } from "./helpers/runtime.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const OWNER_A = "00000000-0000-0000-0000-0000000000a1";
const EFFECT_KEY = "native.apple_reminders";

function ownerScope(agentId: string, ownerId: string): LifeOpsDefinitionScope {
  return {
    agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: ownerId,
  };
}

function definitionInput(scope: LifeOpsDefinitionScope, title: string) {
  return createLifeOpsTaskDefinition({
    ...scope,
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    kind: "reminder",
    title,
    description: `${title} description`,
    originalIntent: `Remind me about ${title}`,
    timezone: "America/Denver",
    status: "active",
    priority: 3,
    cadence: { kind: "once", dueAt: "2026-12-24T18:00:00.000Z" },
    windowPolicy: {
      timezone: "America/Denver",
      windows: [
        { name: "morning", label: "Morning", startMinute: 480, endMinute: 720 },
      ],
    },
    progressionRule: { kind: "none" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "test",
    metadata: {},
  });
}

/**
 * Stand-in for the native provider. Every entry in `calls` is an irreversible
 * third-party action that a real user would observe (a reminder actually created
 * on the device). Assertions are made on this array because it is the only
 * honest measure of "exactly once".
 */
function createProviderStub() {
  const calls: string[] = [];
  return {
    calls,
    async invoke(label: string, gate?: Promise<void>): Promise<string> {
      calls.push(label);
      if (gate) {
        // Model an executor blocked *inside* the provider call: the effect has
        // begun, the provider has not returned, and no amount of elapsed wall
        // clock makes it safe for anyone else to call the provider.
        await gate;
      }
      return `provider-ref-${label}`;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("definition third-party-effect fencing", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("executes exactly once when executor A is blocked inside the effect and B takes over", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Fenced reminder"),
    );
    const provider = createProviderStub();
    const gate = deferred();

    // Executor A acquires the claim and enters the provider call.
    const grantA = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    expect(grantA.disposition).toBe("granted");
    if (grantA.disposition !== "granted") {
      throw new Error("executor A did not acquire the effect claim");
    }
    const executorA = provider.invoke("winner", gate.promise);

    // Age the claim past ANY plausible lease horizon while A is still blocked
    // inside the provider call. This is the precise condition from the report:
    // the lease has lapsed, but the side effect it was protecting is still
    // running. Backdating rather than sleeping keeps the control deterministic
    // and independent of whatever lease duration an implementation picks.
    await repository.markDefinitionEffectClaimedAtForTest({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      claimedAt: "1999-01-01T00:00:00.000Z",
    });

    // Executor B arrives while A is still inside the provider call. In the
    // reported failure this is where a lapsed wall-clock lease handed B
    // permission to call the provider a second time.
    const grantB = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    if (grantB.disposition === "granted") {
      // Only reachable on a regressed build. Perform the effect B was told it
      // was allowed to perform, so the assertion below reports the original
      // ["winner", "stale"] signature rather than an abstract disposition.
      await repository.completeDefinitionEffect({
        entry: grantB.entry,
        providerRef: await provider.invoke("stale"),
      });
    }

    // A finally returns from the provider.
    gate.resolve();
    const providerRef = await executorA;

    // The invariant, stated in terms of real-world effects rather than
    // dispositions. A regressed build reports ["winner", "stale"] here, which
    // is the exact signature from the review of 724faa7.
    expect(provider.calls).toEqual(["winner"]);
    expect(grantB.disposition).toBe("in_flight");

    // A commits under its fencing token, which is still current.
    const committed = await repository.completeDefinitionEffect({
      entry: grantA.entry,
      providerRef,
    });
    expect(committed).not.toBeNull();
    expect(committed?.phase).toBe("completed");

    const persisted = await repository.getDefinitionEffectClaim({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
    });
    expect(persisted).toMatchObject({
      phase: "completed",
      providerRef: "provider-ref-winner",
      fencingSequence: 1,
    });
  });

  it("never releases an in-flight claim on elapsed time alone", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Long effect reminder"),
    );

    const grant = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    expect(grant.disposition).toBe("granted");

    // Backdate the claim far beyond any plausible lease horizon. A time-based
    // implementation would consider this claim abandoned and reissue it.
    await repository.markDefinitionEffectClaimedAtForTest({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      claimedAt: "1999-01-01T00:00:00.000Z",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await repository.beginDefinitionEffect({
        scope,
        definitionId: definition.id,
        effectKey: EFFECT_KEY,
        definitionRevision: definition.revision,
      });
      expect(retry.disposition).toBe("in_flight");
    }
  });

  it("rejects a fenced-out executor's commit after another claimant replaced it", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Fenced-out reminder"),
    );

    const grantA = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    if (grantA.disposition !== "granted") {
      throw new Error("executor A did not acquire the effect claim");
    }

    // A is presumed dead and the effect is reconciled against the provider,
    // which reports that nothing was created. That releases the claim.
    const reconciled = await repository.reconcileDefinitionEffectClaim({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      observedProviderRef: null,
    });
    expect(reconciled?.phase).toBe("failed");

    // B legitimately re-acquires and completes at a higher fencing sequence.
    const grantB = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    expect(grantB.disposition).toBe("granted");
    if (grantB.disposition !== "granted") {
      throw new Error("executor B did not re-acquire the effect claim");
    }
    expect(grantB.entry.fencingSequence).toBeGreaterThan(
      grantA.entry.fencingSequence,
    );
    await repository.completeDefinitionEffect({
      entry: grantB.entry,
      providerRef: "provider-ref-b",
    });

    // A now wakes up and tries to commit. Its write must be rejected at the
    // database boundary even though A believed it held the effect.
    const staleCommit = await repository.completeDefinitionEffect({
      entry: grantA.entry,
      providerRef: "provider-ref-a",
    });
    expect(staleCommit).toBeNull();

    expect(
      await repository.getDefinitionEffectClaim({
        scope,
        definitionId: definition.id,
        effectKey: EFFECT_KEY,
      }),
    ).toMatchObject({
      phase: "completed",
      providerRef: "provider-ref-b",
      fencingSequence: grantB.entry.fencingSequence,
    });
  });

  it("supersedes a stale revision so adjacent revisions cannot reorder their effects", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Reordered reminder"),
    );
    const provider = createProviderStub();

    // Revision 2 opens and completes its effect first.
    const grantR2 = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: 2,
    });
    if (grantR2.disposition !== "granted") {
      throw new Error("revision 2 did not acquire the effect claim");
    }
    await repository.completeDefinitionEffect({
      entry: grantR2.entry,
      providerRef: await provider.invoke("revision-2"),
    });

    // Revision 3 supersedes it normally.
    const grantR3 = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: 3,
    });
    expect(grantR3.disposition).toBe("granted");
    if (grantR3.disposition !== "granted") {
      throw new Error("revision 3 did not acquire the effect claim");
    }
    await repository.completeDefinitionEffect({
      entry: grantR3.entry,
      providerRef: await provider.invoke("revision-3"),
    });

    // A delayed revision-2 executor now wakes up. It must not perform its
    // provider call after revision 3 has already landed.
    const lateR2 = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: 2,
    });
    expect(lateR2.disposition).toBe("superseded");
    if (lateR2.disposition === "granted") {
      await provider.invoke("revision-2-late");
    }

    expect(provider.calls).toEqual(["revision-2", "revision-3"]);
  });

  it("replays a completed effect without touching the provider again", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Replayed reminder"),
    );
    const provider = createProviderStub();

    const grant = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    if (grant.disposition !== "granted") {
      throw new Error("initial effect claim was not acquired");
    }
    await repository.completeDefinitionEffect({
      entry: grant.entry,
      providerRef: await provider.invoke("only-once"),
    });

    // A crash-and-retry of the same revision must reuse the recorded provider
    // reference rather than creating a second reminder on the device.
    const restarted = new LifeOpsRepository(runtime);
    const replay = await restarted.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    expect(replay).toMatchObject({
      disposition: "replayed",
      entry: { providerRef: "provider-ref-only-once", phase: "completed" },
    });
    if (replay.disposition === "granted") {
      await provider.invoke("duplicate");
    }

    expect(provider.calls).toEqual(["only-once"]);
  });

  it("keeps a crashed create recoverable instead of silently duplicating", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Crashed create reminder"),
    );
    const provider = createProviderStub();

    // Executor creates the native item, then crashes before persisting the id.
    const grant = await repository.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    if (grant.disposition !== "granted") {
      throw new Error("effect claim was not acquired");
    }
    await provider.invoke("orphaned-create");

    // After restart the claim is still in_flight, so nothing may call create
    // again on the strength of a timeout.
    const restarted = new LifeOpsRepository(runtime);
    const afterCrash = await restarted.beginDefinitionEffect({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      definitionRevision: definition.revision,
    });
    expect(afterCrash.disposition).toBe("in_flight");
    if (afterCrash.disposition === "granted") {
      await provider.invoke("duplicate-create");
    }

    // Recovery requires an observation of what the provider actually did. The
    // orphaned item is adopted rather than re-created.
    const reconciled = await restarted.reconcileDefinitionEffectClaim({
      scope,
      definitionId: definition.id,
      effectKey: EFFECT_KEY,
      observedProviderRef: "provider-ref-orphaned-create",
    });
    expect(reconciled).toMatchObject({
      phase: "completed",
      providerRef: "provider-ref-orphaned-create",
    });
    expect(provider.calls).toEqual(["orphaned-create"]);
  });
});
