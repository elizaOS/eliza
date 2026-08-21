/**
 * Exercises deterministic native-host lifecycle, permissions, faults,
 * cancellation, idempotency, event delivery, reset, and teardown semantics.
 */
import { describe, expect, it, vi } from "vitest";
import { bootInProcessWorld } from "./adapters.ts";
import type { WorldManifest } from "./manifest.ts";
import {
  SyntheticNativePlatform,
  SyntheticNativePlatformError,
} from "./native-platform.ts";
import {
  assertNativePlatformOwnership,
  NATIVE_PLATFORM_SURFACE_IDS,
} from "./native-platform-ownership.ts";
import { testManifest } from "./test-fixture.ts";

function boot(namespace: string, faults: WorldManifest["faults"] = []) {
  const manifest = testManifest();
  manifest.faults = faults;
  const world = bootInProcessWorld(manifest, { namespace });
  const platform = new SyntheticNativePlatform(world, [
    {
      id: "@elizaos/capacitor-messages:native-bridge:elizamessages",
      initialState: { sent: [] },
      handlers: {
        send: async (input, context) => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            typeof input.body !== "string"
          ) {
            throw new SyntheticNativePlatformError(
              "invalid-input",
              "message body is required",
            );
          }
          await context.sleep(50);
          const state = context.state as { sent: JsonValue[] };
          const next = { sent: [...state.sent, input] };
          context.setState(next);
          context.emit("messageSent", input);
          return { accepted: true, count: next.sent.length };
        },
      },
    },
  ]);
  return { world, platform };
}

type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

describe("SyntheticNativePlatform", () => {
  it("pins the exact canonical platform-deferred ownership set", () => {
    expect(NATIVE_PLATFORM_SURFACE_IDS).toHaveLength(37);
    expect(() =>
      assertNativePlatformOwnership(NATIVE_PLATFORM_SURFACE_IDS),
    ).not.toThrow();
    expect(() =>
      assertNativePlatformOwnership(NATIVE_PLATFORM_SURFACE_IDS.slice(1)),
    ).toThrow(/missing/);
    expect(() =>
      assertNativePlatformOwnership([...NATIVE_PLATFORM_SURFACE_IDS, "new"]),
    ).toThrow(/unexpected/);
  });

  it("commits once, emits readback evidence, and survives process restart", async () => {
    const { world, platform } = boot("native:success");
    const event = vi.fn();
    platform.subscribe(
      "@elizaos/capacitor-messages:native-bridge:elizamessages",
      "messageSent",
      event,
    );
    const call = platform.invoke({
      surfaceId: "@elizaos/capacitor-messages:native-bridge:elizamessages",
      method: "send",
      input: { body: "synthetic hello" },
      idempotencyKey: "message-one",
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await world.clock.advanceBy(50);
    await expect(call).resolves.toEqual({ accepted: true, count: 1 });
    await expect(
      platform.invoke({
        surfaceId: "@elizaos/capacitor-messages:native-bridge:elizamessages",
        method: "send",
        input: { body: "synthetic hello" },
        idempotencyKey: "message-one",
      }),
    ).resolves.toEqual({ accepted: true, count: 1 });
    expect(platform.flushEvents()).toBe(1);
    expect(event).toHaveBeenCalledWith({ body: "synthetic hello" });
    expect(world.ledger.byKind("readback")).toHaveLength(2);
    const beforeRestart = platform.readback();
    const restarted = platform.restart();
    expect(restarted.generation).toBe(2);
    expect(restarted.stateHash).toBe(beforeRestart.stateHash);
    expect(restarted.idempotentResults).toBe(1);
    platform.teardown();
    world.teardown();
  });

  it("fails closed for availability, permission, invalid input, and cancellation", async () => {
    const { world, platform } = boot("native:failures");
    const surface = "@elizaos/capacitor-messages:native-bridge:elizamessages";
    platform.setAvailable(surface, false);
    await expect(
      platform.invoke({ surfaceId: surface, method: "send", input: {} }),
    ).rejects.toMatchObject({ code: "platform-unavailable" });
    platform.setAvailable(surface, true);
    platform.setPermission(surface, "denied");
    await expect(
      platform.invoke({ surfaceId: surface, method: "send", input: {} }),
    ).rejects.toMatchObject({ code: "permission-denied" });
    platform.setPermission(surface, "granted");
    await expect(
      platform.invoke({ surfaceId: surface, method: "send", input: {} }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const controller = new AbortController();
    const call = platform.invoke({
      surfaceId: surface,
      method: "send",
      input: { body: "cancel me" },
      signal: controller.signal,
    });
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "aborted" });
    expect(world.clock.pendingTimerCount).toBe(0);
    expect(platform.readback().inFlight).toBe(0);
    platform.teardown();
    world.teardown();
  });

  it("records deterministic timeout and recovery attempts", async () => {
    const surface = "@elizaos/capacitor-messages:native-bridge:elizamessages";
    const { world, platform } = boot("native:timeout", [
      {
        id: "native-timeout",
        boundary: `native.${surface}.send`,
        steps: [{ onAttempt: 1, effect: { kind: "timeout", durationMs: 100 } }],
      },
    ]);
    await expect(
      platform.invoke({
        surfaceId: surface,
        method: "send",
        input: { body: "retry me" },
      }),
    ).rejects.toMatchObject({ effect: { kind: "timeout" }, attempt: 1 });
    expect(world.clock.nowIso()).toBe("2030-01-01T08:00:00.100Z");
    expect(world.ledger.byKind("fault")).toHaveLength(1);
    const recovered = platform.invoke({
      surfaceId: surface,
      method: "send",
      input: { body: "retry me" },
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await world.clock.advanceBy(50);
    await expect(recovered).resolves.toEqual({ accepted: true, count: 1 });
    platform.teardown();
    world.teardown();
  });

  it("restores the exact seed and clears queues, callbacks, and receipts", async () => {
    const { world, platform } = boot("native:reset");
    const initial = platform.readback();
    const call = platform.invoke({
      surfaceId: "@elizaos/capacitor-messages:native-bridge:elizamessages",
      method: "send",
      input: { body: "reset me" },
      idempotencyKey: "reset-message",
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await world.clock.advanceBy(50);
    await call;
    expect(platform.readback().stateHash).not.toBe(initial.stateHash);
    const reset = platform.reset();
    expect(reset).toEqual(initial);
    expect(world.ledger.all()).toEqual([]);
    platform.teardown();
    expect(() => platform.readback()).toThrow(/torn down/);
    world.teardown();
  });
});
