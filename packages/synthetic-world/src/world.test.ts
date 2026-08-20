/**
 * Verifies deterministic world lifecycle, typed evidence, named fault behavior,
 * authoritative readback, reset equivalence, and namespace isolation.
 */
import { describe, expect, it } from "vitest";
import { bootInProcessWorld } from "./adapters.ts";
import { SyntheticFaultError } from "./faults.ts";
import type { FaultEffect } from "./manifest.ts";
import { NamespaceInUseError } from "./namespace.ts";
import { testManifest } from "./test-fixture.ts";

describe("SyntheticWorld", () => {
  it("restores snapshots and reset state while clearing every observation", () => {
    const world = bootInProcessWorld(testManifest(), {
      namespace: "world:lifecycle:one",
    });
    const initialHash = world.stateHash;
    const initialRandom = world.random.next();
    const snapshot = world.snapshot();
    world.updateData((data) => {
      data.tasks[0].status = "completed";
    });
    expect(world.stateHash).not.toBe(initialHash);
    expect(world.ledger.byKind("state-transition")).toHaveLength(1);
    world.restore(snapshot);
    expect(world.stateHash).toBe(initialHash);
    expect(world.ledger.all()).toHaveLength(0);
    expect(world.random.next()).toBe(initialRandom);
    world.updateData((data) => {
      data.notifications[0].status = "delivered";
    });
    world.reset();
    expect(world.stateHash).toBe(initialHash);
    expect(world.ledger.all()).toHaveLength(0);
    world.teardown();
  });

  it("rejects namespace sharing until teardown releases the lease", () => {
    const first = bootInProcessWorld(testManifest(), {
      namespace: "world:isolation:one",
    });
    expect(() =>
      bootInProcessWorld(testManifest(), { namespace: "world:isolation:one" }),
    ).toThrow(NamespaceInUseError);
    const second = bootInProcessWorld(testManifest(), {
      namespace: "world:isolation:two",
    });
    second.updateData((data) => {
      data.tasks[0].status = "completed";
    });
    expect(first.data.tasks[0].status).toBe("pending");
    first.teardown();
    const replacement = bootInProcessWorld(testManifest(), {
      namespace: "world:isolation:one",
    });
    replacement.teardown();
    second.teardown();
  });

  it("records request, response, idempotency, transition, and authoritative readback evidence", async () => {
    const world = bootInProcessWorld(testManifest(), {
      namespace: "world:ledger:one",
    });
    const output = await world.executeBoundary("mail.send", {
      input: { to: "morgan@example.invalid", body: "Hello" },
      idempotencyKey: "synthetic-send-one",
      execute: () => ({ accepted: true }),
      authoritativeReadback: () => ({ delivered: true }),
    });
    expect(output).toEqual({ accepted: true });
    expect(world.ledger.byKind("request")[0]).toMatchObject({
      target: "mail.send",
      attempt: 1,
      idempotencyKey: "synthetic-send-one",
    });
    expect(world.ledger.byKind("response")[0]).toMatchObject({
      output: { accepted: true },
      authoritativeReadback: { delivered: true },
    });
    expect(world.ledger.byKind("readback")).toHaveLength(1);
    world.teardown();
  });

  it("keeps nested ledger evidence immutable across append and read boundaries", () => {
    const world = bootInProcessWorld(testManifest(), {
      namespace: "world:ledger:immutability",
    });
    const input = { nested: { value: "original" } };
    const appended = world.ledger.append({
      kind: "model",
      status: "observed",
      target: "model.generate",
      input,
      payloadHash: "synthetic-hash",
      attempt: 1,
    });
    input.nested.value = "mutated-after-append";
    if (
      appended.input &&
      !Array.isArray(appended.input) &&
      typeof appended.input === "object"
    ) {
      const nested = appended.input.nested;
      if (nested && !Array.isArray(nested) && typeof nested === "object")
        nested.value = "mutated-return";
    }
    const firstRead = world.ledger.byKind("model");
    expect(firstRead[0].input).toEqual({ nested: { value: "original" } });
    const readInput = firstRead[0].input;
    if (
      readInput &&
      !Array.isArray(readInput) &&
      typeof readInput === "object"
    ) {
      const nested = readInput.nested;
      if (nested && !Array.isArray(nested) && typeof nested === "object")
        nested.value = "mutated-read";
    }
    expect(world.ledger.byKind("model")[0].input).toEqual({
      nested: { value: "original" },
    });
    world.teardown();
  });

  it("defines restore as state-and-clock restoration with execution progression reset", async () => {
    const manifest = testManifest();
    manifest.faults = [
      {
        id: "fault-reset-proof",
        boundary: "reset-proof",
        steps: [{ onAttempt: 1, effect: { kind: "disconnect" } }],
      },
    ];
    const world = bootInProcessWorld(manifest, {
      namespace: "world:restore:semantics",
    });
    const snapshot = world.snapshot();
    expect(snapshot.semantics).toBe("state-and-clock-reset-execution");
    await expect(
      world.executeBoundary("reset-proof", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(SyntheticFaultError);
    await expect(
      world.executeBoundary("reset-proof", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });
    world.clock.setTimeout(() => undefined, 10);
    world.restore(snapshot);
    expect(world.clock.pendingTimerCount).toBe(0);
    await expect(
      world.executeBoundary("reset-proof", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).rejects.toBeInstanceOf(SyntheticFaultError);
    world.teardown();
  });

  it.each([
    { kind: "timeout", durationMs: 50 },
    { kind: "disconnect" },
    { kind: "authExpired" },
    { kind: "rateLimit", retryAfterMs: 100 },
    { kind: "retry", retryAfterMs: 10 },
  ] satisfies FaultEffect[])(
    "injects and records $kind failures",
    async (effect) => {
      const manifest = testManifest();
      manifest.faults = [
        {
          id: `fault-${effect.kind}`,
          boundary: "provider.call",
          steps: [{ onAttempt: 1, effect }],
        },
      ];
      const world = bootInProcessWorld(manifest, {
        namespace: `world:fault:${effect.kind}`,
      });
      await expect(
        world.executeBoundary("provider.call", {
          input: {},
          execute: () => ({ ok: true }),
        }),
      ).rejects.toBeInstanceOf(SyntheticFaultError);
      expect(world.ledger.byKind("fault")).toHaveLength(1);
      expect(world.ledger.all().at(-1)?.status).toBe("failed");
      world.teardown();
    },
  );

  it("supports latency, malformed, partial, ambiguous commit, and recovery", async () => {
    const manifest = testManifest();
    manifest.faults = [
      {
        id: "fault-latency",
        boundary: "latency",
        steps: [{ onAttempt: 1, effect: { kind: "latency", durationMs: 25 } }],
      },
      {
        id: "fault-malformed",
        boundary: "malformed",
        steps: [
          {
            onAttempt: 1,
            effect: { kind: "malformedData", value: { broken: true } },
          },
        ],
      },
      {
        id: "fault-partial",
        boundary: "partial",
        steps: [
          {
            onAttempt: 1,
            effect: { kind: "partialResponse", omitFields: ["secret"] },
          },
        ],
      },
      {
        id: "fault-ambiguous",
        boundary: "ambiguous",
        steps: [{ onAttempt: 1, effect: { kind: "ambiguousCommit" } }],
      },
      {
        id: "fault-recovery",
        boundary: "recovery",
        steps: [{ onAttempt: 1, effect: { kind: "recovery" } }],
      },
    ];
    const world = bootInProcessWorld(manifest, {
      namespace: "world:fault:matrix",
    });
    await expect(
      world.executeBoundary("latency", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });
    expect(world.clock.nowIso()).toBe("2030-01-01T08:00:00.025Z");
    await expect(
      world.executeBoundary("malformed", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).resolves.toEqual({ broken: true });
    await expect(
      world.executeBoundary("partial", {
        input: {},
        execute: () => ({ ok: true, secret: "remove" }),
      }),
    ).resolves.toEqual({ ok: true });
    let committed = false;
    await expect(
      world.executeBoundary("ambiguous", {
        input: {},
        execute: () => {
          committed = true;
          return { ok: true };
        },
      }),
    ).rejects.toBeInstanceOf(SyntheticFaultError);
    expect(committed).toBe(true);
    await expect(
      world.executeBoundary("recovery", {
        input: {},
        execute: () => ({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true });
    world.teardown();
  });
});
