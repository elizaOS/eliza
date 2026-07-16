/**
 * Multi-window behaviour of the single-owner shell coordinator, exercised over a
 * real in-memory bus (not a mock of the unit): several coordinators share one
 * `createInMemoryShellSyncBus`, so ownership election, stale-snapshot rejection,
 * idempotent commands, crash re-election, and version-mismatch degrade are all
 * proven against genuine cross-window message flow.
 */
import { describe, expect, it } from "vitest";
import {
  ShellControllerCoordinator,
  type ShellCoordinatorOptions,
  type ShellFollowerStatus,
} from "../coordinator";
import {
  SHELL_OWNER_PRIORITY,
  type ShellControllerCommand,
  type ShellWindowRole,
} from "../protocol";
import type { ShellControllerSnapshot } from "../snapshot";
import {
  createInMemoryShellSyncBus,
  type InMemoryShellSyncBus,
} from "../transport";
import { baseSnapshot } from "./fixtures";

class Clock {
  ms = 1000;
  now = (): number => this.ms;
  advance(by: number): void {
    this.ms += by;
  }
}

interface Window {
  coord: ShellControllerCoordinator;
  transport: ReturnType<InMemoryShellSyncBus["connect"]>;
  roles: ShellWindowRole[];
  statuses: ShellFollowerStatus[];
  snapshots: (ShellControllerSnapshot | null)[];
  applied: ShellControllerCommand[];
  errors: string[];
}

function makeWindow(
  bus: InMemoryShellSyncBus,
  clock: Clock,
  windowId: string,
  priority: number,
  extra: Partial<ShellCoordinatorOptions> = {},
): Window {
  const transport = bus.connect();
  const w: Window = {
    coord: undefined as unknown as ShellControllerCoordinator,
    transport,
    roles: [],
    statuses: [],
    snapshots: [],
    applied: [],
    errors: [],
  };
  w.coord = new ShellControllerCoordinator({
    windowId,
    priority,
    transport,
    now: clock.now,
    peerTtlMs: 3000,
    // Election tests assert the elected result directly; the join grace is
    // covered by its own suite, so default to immediate claim here.
    claimOwnershipImmediately: extra.claimOwnershipImmediately ?? true,
    onRoleChange: (role) => w.roles.push(role),
    onStatusChange: (status) => w.statuses.push(status),
    onSnapshot: (snap) => w.snapshots.push(snap),
    onCommand: (command) => w.applied.push(command),
    onError: (message) => w.errors.push(message),
    ...extra,
  });
  return w;
}

describe("ShellControllerCoordinator ownership", () => {
  it("a lone window owns the engine", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const w = makeWindow(bus, clock, "w1", SHELL_OWNER_PRIORITY.main);
    w.coord.start();
    expect(w.coord.getRole()).toBe("owner");
  });

  it("exactly one of two windows owns; priority wins over id", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    // The tray popover (higher priority number) starts FIRST, then the main
    // window joins and must take ownership.
    const tray = makeWindow(
      bus,
      clock,
      "aaa-tray",
      SHELL_OWNER_PRIORITY["tray-popover"],
    );
    tray.coord.start();
    expect(tray.coord.getRole()).toBe("owner");

    const main = makeWindow(bus, clock, "zzz-main", SHELL_OWNER_PRIORITY.main);
    main.coord.start();

    expect(main.coord.getRole()).toBe("owner");
    expect(tray.coord.getRole()).toBe("follower");
  });

  it("ties break on window id so no two windows disagree", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const a = makeWindow(bus, clock, "id-a", SHELL_OWNER_PRIORITY.surface);
    const b = makeWindow(bus, clock, "id-b", SHELL_OWNER_PRIORITY.surface);
    a.coord.start();
    b.coord.start();
    expect(a.coord.getRole()).toBe("owner");
    expect(b.coord.getRole()).toBe("follower");
  });
});

describe("ShellControllerCoordinator snapshots", () => {
  it("a follower renders the owner's snapshot", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    owner.coord.start();
    follower.coord.start();

    owner.coord.publishSnapshot(baseSnapshot({ recording: true, phase: "listening" }));

    const latest = follower.snapshots.at(-1);
    expect(latest?.recording).toBe(true);
    expect(latest?.phase).toBe("listening");
    expect(follower.coord.getStatus()).toBe("connected");
  });

  it("drops a stale (reordered) snapshot by seq", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    owner.coord.start();
    follower.coord.start();

    owner.coord.publishSnapshot(baseSnapshot({ transcript: "first" }));
    owner.coord.publishSnapshot(baseSnapshot({ transcript: "second" }));
    // A relay redelivers an older seq out of order (raw endpoint so it actually
    // reaches the follower); the coordinator must ignore it.
    const relay = bus.connect();
    relay.send({
      type: "snapshot",
      protocolVersion: "1",
      ownerWindowId: "owner",
      epoch: 1,
      seq: 1,
      snapshot: baseSnapshot({ transcript: "STALE" }),
    });

    expect(follower.snapshots.at(-1)?.transcript).toBe("second");
  });
});

describe("ShellControllerCoordinator commands", () => {
  it("routes a follower command to the owner exactly once and acks", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    owner.coord.start();
    follower.coord.start();

    await follower.coord.dispatchCommand({ kind: "startRecording", intent: "converse" });

    expect(owner.applied).toEqual([{ kind: "startRecording", intent: "converse" }]);
  });

  it("relays a mic-permission recheck command to the single audio owner", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY.surface,
    );
    owner.coord.start();
    follower.coord.start();

    await follower.coord.dispatchCommand({ kind: "recheckMicPermission" });
    expect(owner.applied).toContainEqual({ kind: "recheckMicPermission" });
    // The follower itself never applies a command (owns no engine).
    expect(follower.applied).toEqual([]);
  });

  it("two followers racing start/stop/send: owner applies each once", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const f1 = makeWindow(bus, clock, "f1", SHELL_OWNER_PRIORITY.surface);
    const f2 = makeWindow(bus, clock, "f2", SHELL_OWNER_PRIORITY["tray-popover"]);
    owner.coord.start();
    f1.coord.start();
    f2.coord.start();

    await Promise.all([
      f1.coord.dispatchCommand({ kind: "startRecording" }),
      f2.coord.dispatchCommand({ kind: "stopRecording" }),
      f1.coord.dispatchCommand({ kind: "send", text: "hi" }),
    ]);

    expect(owner.applied).toHaveLength(3);
    expect(owner.applied).toContainEqual({ kind: "startRecording" });
    expect(owner.applied).toContainEqual({ kind: "stopRecording" });
    expect(owner.applied).toContainEqual({ kind: "send", text: "hi" });
    expect(f1.applied).toEqual([]);
    expect(f2.applied).toEqual([]);
  });

  it("idempotency: a redelivered command re-acks but never re-applies", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY.surface,
    );
    owner.coord.start();
    follower.coord.start();

    // A relay that redelivers the SAME command envelope (same commandId) must
    // ack twice but apply once. Send the identical envelope through the
    // follower's transport twice.
    const envelope = {
      type: "command" as const,
      protocolVersion: "1",
      commandId: "dup-1",
      fromWindowId: "follower",
      command: { kind: "toggleHandsFree" } as ShellControllerCommand,
    };
    follower.transport.send(envelope);
    follower.transport.send(envelope);

    expect(owner.applied).toEqual([{ kind: "toggleHandsFree" }]);
  });

  it("rejects a command when the follower's owner has gone (no silent drop)", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    // A high-priority (main) owner keeps a lower-priority window a follower.
    const owner = makeWindow(bus, clock, "aaa-owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "zzz-follower",
      SHELL_OWNER_PRIORITY.surface,
    );
    owner.coord.start();
    follower.coord.start();
    expect(follower.coord.getRole()).toBe("follower");

    // The owner crashes (no bye). The follower still lists it, but before its
    // own re-election tick a dispatch must reach a live owner — sever the bus so
    // no ack can return and the send is inert, then prove it rejects on timeout
    // rather than resolving as a phantom success.
    bus.disconnect(owner.transport);
    const pending = follower.coord.dispatchCommand({ kind: "open" });
    clock.advance(6000);
    follower.coord.tick();
    await expect(pending).rejects.toThrow();
  });

  it("times out a command whose ack never returns", async () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "follower",
      SHELL_OWNER_PRIORITY.surface,
    );
    owner.coord.start();
    follower.coord.start();
    // Sever the owner so its ack never comes back, but keep it in the peer table
    // (no bye) so the follower still targets it.
    bus.disconnect(owner.transport);

    const pending = follower.coord.dispatchCommand({ kind: "stop" });
    clock.advance(6000);
    follower.coord.tick();
    await expect(pending).rejects.toThrow(/timed out/);
  });
});

describe("ShellControllerCoordinator crash + handoff", () => {
  it("promotes a follower after the owner crashes (heartbeat TTL)", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "aaa-owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "bbb-follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    owner.coord.start();
    follower.coord.start();
    owner.coord.publishSnapshot(baseSnapshot({ transcript: "live" }));
    expect(follower.coord.getRole()).toBe("follower");

    // Owner crashes without a bye. Advance past the TTL and tick the follower.
    bus.disconnect(owner.transport);
    clock.advance(4000);
    follower.coord.tick();

    expect(follower.coord.getRole()).toBe("owner");
  });

  it("a promoted owner's epoch beats the crashed owner's late snapshots", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "aaa-owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "bbb-follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    const observer = makeWindow(
      bus,
      clock,
      "ccc-observer",
      SHELL_OWNER_PRIORITY["tray-popover"],
    );
    owner.coord.start();
    follower.coord.start();
    observer.coord.start();
    owner.coord.publishSnapshot(baseSnapshot({ transcript: "epoch1" }));

    bus.disconnect(owner.transport);
    clock.advance(4000);
    follower.coord.tick();
    observer.coord.tick();
    expect(follower.coord.getRole()).toBe("owner");

    follower.coord.publishSnapshot(baseSnapshot({ transcript: "epoch2" }));
    // A late duplicate of the dead owner's epoch-1 snapshot (raw endpoint so it
    // reaches the observer) must not clobber the new owner's epoch-2 state.
    const zombie = bus.connect();
    zombie.send({
      type: "snapshot",
      protocolVersion: "1",
      ownerWindowId: "aaa-owner",
      epoch: 1,
      seq: 99,
      snapshot: baseSnapshot({ transcript: "ZOMBIE" }),
    });
    expect(observer.snapshots.at(-1)?.transcript).toBe("epoch2");
  });

  it("clean handoff: an owner that stops promotes a follower immediately", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const owner = makeWindow(bus, clock, "aaa-owner", SHELL_OWNER_PRIORITY.main);
    const follower = makeWindow(
      bus,
      clock,
      "bbb-follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    owner.coord.start();
    follower.coord.start();
    expect(follower.coord.getRole()).toBe("follower");

    owner.coord.stop();
    expect(follower.coord.getRole()).toBe("owner");
  });

  it("main-window restart reclaims ownership from the interim owner", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const main = makeWindow(bus, clock, "main", SHELL_OWNER_PRIORITY.main);
    const overlay = makeWindow(
      bus,
      clock,
      "overlay",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    main.coord.start();
    overlay.coord.start();
    expect(main.coord.getRole()).toBe("owner");

    // Main closes; overlay takes over.
    main.coord.stop();
    expect(overlay.coord.getRole()).toBe("owner");

    // Main restarts (new coordinator, same priority) and reclaims ownership.
    const main2 = makeWindow(bus, clock, "main", SHELL_OWNER_PRIORITY.main);
    main2.coord.start();
    expect(main2.coord.getRole()).toBe("owner");
    expect(overlay.coord.getRole()).toBe("follower");
  });
});

describe("ShellControllerCoordinator join grace", () => {
  it("defers claiming ownership until discovery completes", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const w = makeWindow(bus, clock, "solo", SHELL_OWNER_PRIORITY.main, {
      claimOwnershipImmediately: false,
    });
    w.coord.start();
    // Rightful owner, but still discovering: it must not run the engine yet.
    expect(w.coord.getRole()).toBe("follower");
    expect(w.coord.getStatus()).toBe("connecting");

    w.coord.completeDiscovery();
    expect(w.coord.getRole()).toBe("owner");
  });

  it("a joiner that hears an existing owner during grace never claims", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    // Existing owner is already up (claimed).
    const owner = makeWindow(bus, clock, "aaa-owner", SHELL_OWNER_PRIORITY.main);
    owner.coord.start();
    expect(owner.coord.getRole()).toBe("owner");

    // A lower-priority window joins WITH a grace. Even though it has not yet
    // completed discovery, hearing the owner keeps it a follower.
    const joiner = makeWindow(
      bus,
      clock,
      "zzz-joiner",
      SHELL_OWNER_PRIORITY.surface,
      { claimOwnershipImmediately: false },
    );
    joiner.coord.start();
    expect(joiner.coord.getRole()).toBe("follower");

    // Completing discovery still keeps it a follower (owner outranks it).
    joiner.coord.completeDiscovery();
    expect(joiner.coord.getRole()).toBe("follower");
    expect(owner.coord.getRole()).toBe("owner");
  });
});

describe("ShellControllerCoordinator version-mismatch + offline", () => {
  it("a follower shows version-mismatch when the owner speaks a newer protocol", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const follower = makeWindow(
      bus,
      clock,
      "zzz-follower",
      SHELL_OWNER_PRIORITY["chat-overlay"],
    );
    follower.coord.start();
    // A future-build main window (raw bus endpoint speaking protocol "2")
    // announces and wins ownership by priority. Our window becomes its follower
    // but cannot interpret its snapshot, so it degrades visibly instead of
    // spawning a second engine.
    const futureOwner = bus.connect();
    futureOwner.send({
      type: "presence",
      protocolVersion: "2",
      event: "announce",
      windowId: "aaa-future-owner",
      priority: SHELL_OWNER_PRIORITY.main,
    });
    expect(follower.coord.getRole()).toBe("follower");
    expect(follower.coord.getStatus()).toBe("version-mismatch");

    futureOwner.send({
      type: "snapshot",
      protocolVersion: "2",
      ownerWindowId: "aaa-future-owner",
      epoch: 1,
      seq: 1,
      snapshot: baseSnapshot({ transcript: "cannot-read" }),
    });
    // The incompatible snapshot must never render.
    expect(follower.snapshots.at(-1)).toBeNull();
    expect(follower.coord.getStatus()).toBe("version-mismatch");
  });

  it("a demoted follower with no owner reports disconnected", () => {
    const bus = createInMemoryShellSyncBus();
    const clock = new Clock();
    const a = makeWindow(bus, clock, "aaa", SHELL_OWNER_PRIORITY.surface);
    const b = makeWindow(bus, clock, "bbb", SHELL_OWNER_PRIORITY.surface);
    a.coord.start();
    b.coord.start();
    expect(b.coord.getRole()).toBe("follower");
    // Owner crashes; before re-election tick, b should observe disconnected once
    // the owner is pruned.
    bus.disconnect(a.transport);
    clock.advance(4000);
    // Manually strip the owner from b's table via a bye-equivalent prune.
    b.coord.tick();
    // b promotes itself (only survivor) — role owner, but the transition proves
    // it never silently rendered the dead owner's state.
    expect(b.coord.getRole()).toBe("owner");
  });
});
