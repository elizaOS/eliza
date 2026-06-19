/**
 * Tests for `InMemoryComputeProvider` — the deterministic in-memory fake of the
 * `ComputeProvider` IaaS seam.
 *
 * These prove the simulated async lifecycle is faithful AND fully deterministic:
 *  - createServer returns a not-ready (`new`) server; getServer flips to
 *    `active` only after the injected tick counter is advanced (a PURE read —
 *    calling getServer repeatedly without advancing ticks never flips it).
 *  - createVolume is `creating` then `available` after ticks.
 *  - attach/detach/power actions go `in-progress`; waitForAction resolves them
 *    to `completed`, or `errored` for a poisoned id (without throwing).
 *  - deleteServer makes getServer null; a second delete is a 404==success no-op.
 *  - capacity / limits are configurable and enforced on both sides.
 *
 * A fresh provider is constructed per test for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { CreateServerInput, CreateVolumeInput } from "./compute-provider";
import {
  ACTION_STATUS_COMPLETED,
  ACTION_STATUS_ERRORED,
  ACTION_STATUS_IN_PROGRESS,
  ComputeFakeError,
  InMemoryComputeProvider,
  SERVER_STATUS_ACTIVE,
  SERVER_STATUS_NEW,
  VOLUME_STATUS_AVAILABLE,
  VOLUME_STATUS_CREATING,
} from "./compute-provider-fake";

function serverInput(over: Partial<CreateServerInput> = {}): CreateServerInput {
  return {
    name: "node-a",
    serverType: "s-2vcpu-2gb",
    location: "nyc1",
    image: "docker-24-04",
    userData: "#cloud-config\n",
    ...over,
  };
}

function volumeInput(over: Partial<CreateVolumeInput> = {}): CreateVolumeInput {
  return {
    name: "vol-a",
    sizeGb: 50,
    location: "nyc1",
    ...over,
  };
}

let provider: InMemoryComputeProvider;

beforeEach(() => {
  // serverActivateAfterTicks=3, volumeAvailableAfterTicks=1 by default.
  provider = new InMemoryComputeProvider();
});

// ---------------------------------------------------------------------------
// implements ComputeProvider — surface
// ---------------------------------------------------------------------------

describe("surface", () => {
  test("exposes all ComputeProvider methods", () => {
    const methods = [
      "listServers",
      "getServer",
      "createServer",
      "deleteServer",
      "powerOff",
      "powerOn",
      "listVolumes",
      "getVolume",
      "createVolume",
      "attachVolume",
      "detachVolume",
      "deleteVolume",
      "waitForAction",
      "listServerTypes",
      "listLocations",
      "listImages",
    ] as const;
    for (const m of methods) {
      expect(typeof (provider as unknown as Record<string, unknown>)[m]).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Server lifecycle: createServer returns not-ready; getServer flips on ticks
// ---------------------------------------------------------------------------

describe("server lifecycle", () => {
  test("createServer returns a not-ready (new) server", async () => {
    const { server, rootPassword } = await provider.createServer(serverInput());
    expect(server.status).toBe(SERVER_STATUS_NEW);
    expect(rootPassword).toBeNull();
    expect(typeof server.id).toBe("number");
  });

  test("getServer is a PURE read: repeated calls never flip status without ticks", async () => {
    const { server } = await provider.createServer(serverInput());
    for (let i = 0; i < 5; i++) {
      const s = await provider.getServer(server.id as number);
      expect(s?.status).toBe(SERVER_STATUS_NEW);
    }
    expect(provider.now()).toBe(0);
  });

  test("getServer flips new → active exactly when ticks reach activateAfterTicks", async () => {
    const { server } = await provider.createServer(serverInput());
    const id = server.id as number;

    provider.tick(2); // not yet (needs 3)
    expect((await provider.getServer(id))?.status).toBe(SERVER_STATUS_NEW);

    provider.tick(1); // now at tick 3 == activeAtTick
    expect((await provider.getServer(id))?.status).toBe(SERVER_STATUS_ACTIVE);
  });

  test("serverActivateAfterTicks=0 means active immediately", async () => {
    const p = new InMemoryComputeProvider({ serverActivateAfterTicks: 0 });
    const { server } = await p.createServer(serverInput());
    expect((await p.getServer(server.id as number))?.status).toBe(SERVER_STATUS_ACTIVE);
  });

  test("getServer returns null for an unknown id", async () => {
    expect(await provider.getServer(99999)).toBeNull();
  });

  test("listServers returns live servers and filters by labels", async () => {
    await provider.createServer(serverInput({ name: "a", labels: { role: "pool" } }));
    await provider.createServer(serverInput({ name: "b", labels: { role: "burst" } }));
    expect((await provider.listServers()).length).toBe(2);
    const pool = await provider.listServers({ role: "pool" });
    expect(pool.map((s) => s.name)).toEqual(["a"]);
  });

  test("ids and created timestamps are deterministic across instances", async () => {
    const p1 = new InMemoryComputeProvider();
    const p2 = new InMemoryComputeProvider();
    const a = (await p1.createServer(serverInput())).server;
    const b = (await p2.createServer(serverInput())).server;
    expect(a.id).toBe(b.id);
    expect(a.created).toBe(b.created);
  });
});

// ---------------------------------------------------------------------------
// Delete semantics: getServer null after delete; second delete = 404 success
// ---------------------------------------------------------------------------

describe("server delete", () => {
  test("deleteServer makes subsequent getServer null", async () => {
    const { server } = await provider.createServer(serverInput());
    const id = server.id as number;
    await provider.deleteServer(id);
    expect(await provider.getServer(id)).toBeNull();
  });

  test("a second delete resolves void (404 == success), never throws", async () => {
    const { server } = await provider.createServer(serverInput());
    const id = server.id as number;
    await provider.deleteServer(id);
    await expect(provider.deleteServer(id)).resolves.toBeUndefined();
  });

  test("deleting an id that never existed is a no-op success", async () => {
    await expect(provider.deleteServer(123456)).resolves.toBeUndefined();
  });

  test("deleted servers drop out of listServers", async () => {
    const { server } = await provider.createServer(serverInput());
    await provider.deleteServer(server.id as number);
    expect(await provider.listServers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Volume lifecycle: creating → available; attach/detach
// ---------------------------------------------------------------------------

describe("volume lifecycle", () => {
  test("createVolume is `creating` then `available` after ticks", async () => {
    const vol = await provider.createVolume(volumeInput());
    expect(vol.status).toBe(VOLUME_STATUS_CREATING);
    expect(vol.server).toBeNull();

    provider.tick(1); // volumeAvailableAfterTicks default = 1
    expect((await provider.getVolume(vol.id as number))?.status).toBe(VOLUME_STATUS_AVAILABLE);
  });

  test("volumeAvailableAfterTicks=0 means available immediately", async () => {
    const p = new InMemoryComputeProvider({ volumeAvailableAfterTicks: 0 });
    const vol = await p.createVolume(volumeInput());
    expect((await p.getVolume(vol.id as number))?.status).toBe(VOLUME_STATUS_AVAILABLE);
  });

  test("getVolume returns null for unknown id; null after delete", async () => {
    expect(await provider.getVolume(42)).toBeNull();
    const vol = await provider.createVolume(volumeInput());
    await provider.deleteVolume(vol.id as number);
    expect(await provider.getVolume(vol.id as number)).toBeNull();
  });

  test("listVolumes filters by location and label", async () => {
    await provider.createVolume(volumeInput({ name: "x", location: "nyc1", labels: { t: "d" } }));
    await provider.createVolume(volumeInput({ name: "y", location: "ams3" }));
    expect((await provider.listVolumes({ location: "nyc1" })).map((v) => v.name)).toEqual(["x"]);
    expect((await provider.listVolumes({ label: { t: "d" } })).map((v) => v.name)).toEqual(["x"]);
  });
});

// ---------------------------------------------------------------------------
// Action lifecycle: in-progress → completed via waitForAction
// ---------------------------------------------------------------------------

describe("actions", () => {
  test("attachVolume returns an in-progress action; waitForAction completes it", async () => {
    const { server } = await provider.createServer(serverInput());
    const vol = await provider.createVolume(volumeInput());
    const sid = server.id as number;

    const action = await provider.attachVolume(vol.id as number, sid);
    expect(action.status).toBe(ACTION_STATUS_IN_PROGRESS);
    expect(action.error).toBeNull();

    // The volume now points at the server.
    expect((await provider.getVolume(vol.id as number))?.server).toBe(sid);

    const done = await provider.waitForAction(action.id as number);
    expect(done.id).toBe(action.id);
    expect(done.status).toBe(ACTION_STATUS_COMPLETED);
    expect(done.error).toBeNull();
  });

  test("detachVolume clears the attachment and goes in-progress → completed", async () => {
    const { server } = await provider.createServer(serverInput());
    const vol = await provider.createVolume(volumeInput());
    await provider.attachVolume(vol.id as number, server.id as number);

    const action = await provider.detachVolume(vol.id as number);
    expect(action.status).toBe(ACTION_STATUS_IN_PROGRESS);
    expect((await provider.getVolume(vol.id as number))?.server).toBeNull();

    expect((await provider.waitForAction(action.id as number)).status).toBe(
      ACTION_STATUS_COMPLETED,
    );
  });

  test("powerOff / powerOn return in-progress actions that complete", async () => {
    const { server } = await provider.createServer(serverInput());
    const id = server.id as number;
    const off = await provider.powerOff(id);
    const on = await provider.powerOn(id);
    expect(off.status).toBe(ACTION_STATUS_IN_PROGRESS);
    expect(on.status).toBe(ACTION_STATUS_IN_PROGRESS);
    expect((await provider.waitForAction(off.id as number)).status).toBe(ACTION_STATUS_COMPLETED);
    expect((await provider.waitForAction(on.id as number)).status).toBe(ACTION_STATUS_COMPLETED);
  });

  test("waitForAction resolves a poisoned id to `errored` WITHOUT throwing", async () => {
    const { server } = await provider.createServer(serverInput());
    const vol = await provider.createVolume(volumeInput());
    const action = await provider.attachVolume(vol.id as number, server.id as number);

    provider.poisonAction(action.id as number);
    const done = await provider.waitForAction(action.id as number);
    expect(done.status).toBe(ACTION_STATUS_ERRORED);
    expect(done.error).toMatchObject({ code: "action_failed" });
  });

  test("pre-seeded poisonedActionIds also resolve errored", async () => {
    // First minted action id under default seeding is deterministic; create a
    // server (id 1) then an action — but rather than guess, poison by capture.
    const p = new InMemoryComputeProvider();
    const { server } = await p.createServer(serverInput());
    const vol = await p.createVolume(volumeInput());
    const action = await p.attachVolume(vol.id as number, server.id as number);
    const seeded = new InMemoryComputeProvider({ poisonedActionIds: [action.id as number] });
    // Re-mint the same deterministic id sequence in the seeded provider.
    const { server: s2 } = await seeded.createServer(serverInput());
    const v2 = await seeded.createVolume(volumeInput());
    const a2 = await seeded.attachVolume(v2.id as number, s2.id as number);
    expect(a2.id).toBe(action.id); // deterministic id reuse
    expect((await seeded.waitForAction(a2.id as number)).status).toBe(ACTION_STATUS_ERRORED);
  });

  test("waitForAction on an unknown action id throws not_found", async () => {
    await expect(provider.waitForAction(77777)).rejects.toMatchObject({ code: "not_found" });
  });

  test("waitForAction does not sleep (resolves synchronously fast)", async () => {
    const { server } = await provider.createServer(serverInput());
    const action = await provider.powerOff(server.id as number);
    const start = performance.now();
    await provider.waitForAction(action.id as number, 60_000);
    // No real timer: must return well under any plausible poll interval.
    expect(performance.now() - start).toBeLessThan(50);
  });

  test("attach/detach/power against a missing server or volume throw not_found", async () => {
    await expect(provider.powerOff(999)).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.detachVolume(999)).rejects.toMatchObject({ code: "not_found" });
    const { server } = await provider.createServer(serverInput());
    await expect(provider.attachVolume(999, server.id as number)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// Capacity / limits
// ---------------------------------------------------------------------------

describe("capacity", () => {
  test("createServer rejects with no_capacity once maxServers reached", async () => {
    const p = new InMemoryComputeProvider({ maxServers: 2 });
    await p.createServer(serverInput({ name: "a" }));
    await p.createServer(serverInput({ name: "b" }));
    await expect(p.createServer(serverInput({ name: "c" }))).rejects.toBeInstanceOf(
      ComputeFakeError,
    );
    await expect(p.createServer(serverInput({ name: "c" }))).rejects.toMatchObject({
      code: "no_capacity",
    });
  });

  test("deleting a server frees a capacity slot", async () => {
    const p = new InMemoryComputeProvider({ maxServers: 1 });
    const { server } = await p.createServer(serverInput({ name: "a" }));
    await expect(p.createServer(serverInput({ name: "b" }))).rejects.toMatchObject({
      code: "no_capacity",
    });
    await p.deleteServer(server.id as number);
    await expect(p.createServer(serverInput({ name: "b" }))).resolves.toBeDefined();
  });

  test("createVolume rejects with no_capacity once maxVolumes reached", async () => {
    const p = new InMemoryComputeProvider({ maxVolumes: 1 });
    await p.createVolume(volumeInput({ name: "v1" }));
    await expect(p.createVolume(volumeInput({ name: "v2" }))).rejects.toMatchObject({
      code: "no_capacity",
    });
  });

  test("unbounded by default: many servers create fine", async () => {
    for (let i = 0; i < 25; i++) await provider.createServer(serverInput({ name: `n${i}` }));
    expect((await provider.listServers()).length).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Injected clock
// ---------------------------------------------------------------------------

describe("injected clock", () => {
  test("startTick seeds the initial tick; tick(n) advances by n", () => {
    const p = new InMemoryComputeProvider({ startTick: 10 });
    expect(p.now()).toBe(10);
    expect(p.tick()).toBe(11);
    expect(p.tick(4)).toBe(15);
    expect(p.now()).toBe(15);
  });

  test("tick rejects non-integer / negative input", () => {
    expect(() => provider.tick(-1)).toThrow(ComputeFakeError);
    expect(() => provider.tick(1.5)).toThrow(ComputeFakeError);
  });

  test("full async lifecycle is reproducible end-to-end", async () => {
    // create server (new) → tick to active → create+attach volume → wait → power
    const { server } = await provider.createServer(serverInput());
    const sid = server.id as number;
    expect((await provider.getServer(sid))?.status).toBe(SERVER_STATUS_NEW);

    provider.tick(3);
    expect((await provider.getServer(sid))?.status).toBe(SERVER_STATUS_ACTIVE);

    const vol = await provider.createVolume(volumeInput());
    provider.tick(1);
    expect((await provider.getVolume(vol.id as number))?.status).toBe(VOLUME_STATUS_AVAILABLE);

    const attach = await provider.attachVolume(vol.id as number, sid);
    expect((await provider.waitForAction(attach.id as number)).status).toBe(
      ACTION_STATUS_COMPLETED,
    );

    await provider.deleteServer(sid);
    expect(await provider.getServer(sid)).toBeNull();
    // Deleting the server detached the volume.
    expect((await provider.getVolume(vol.id as number))?.server).toBeNull();
  });
});
