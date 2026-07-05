/**
 * Error-policy pins for `InMemoryComputeProvider` (#13415).
 *
 * The fake stands in for a real IaaS provider (Hetzner / DigitalOcean) in
 * warm-pool + autoscaler tests, so its failure semantics must match the
 * doctrine the real clients are held to: an *internal failure* of a
 * provisioning call PROPAGATES (throws / surfaces an explicit `errored`
 * action), and must stay distinguishable from a *legitimately empty* read
 * (an empty list from a healthy "200", a `null` from a not-found lookup).
 *
 * Deterministic in-memory harness — no network, no clock, no mocks — so this
 * drives the real exported class directly (mock.module / fetch stubbing would
 * add nothing: the fake has no I/O to intercept).
 */

import { describe, expect, test } from "bun:test";
import type { CreateServerInput, CreateVolumeInput } from "./compute-provider";
import {
  ACTION_STATUS_COMPLETED,
  ACTION_STATUS_ERRORED,
  ComputeFakeError,
  InMemoryComputeProvider,
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
  return { name: "vol-a", sizeGb: 50, location: "nyc1", ...over };
}

// ---------------------------------------------------------------------------
// Internal failures PROPAGATE — never fabricated into a fake success
// ---------------------------------------------------------------------------

describe("internal failure propagates (fail-closed)", () => {
  test("createServer at capacity throws no_capacity — no fabricated server", async () => {
    const p = new InMemoryComputeProvider({ maxServers: 1 });
    await p.createServer(serverInput({ name: "a" }));
    // A masked failure would return a ProvisionedServer here (reading as
    // "provisioned" to the autoscaler); the seam must throw instead.
    await expect(p.createServer(serverInput({ name: "b" }))).rejects.toBeInstanceOf(
      ComputeFakeError,
    );
    await expect(p.createServer(serverInput({ name: "b" }))).rejects.toMatchObject({
      code: "no_capacity",
    });
    // And no phantom server leaked into the live set.
    expect((await p.listServers()).length).toBe(1);
  });

  test("createVolume at capacity throws no_capacity — no fabricated volume", async () => {
    const p = new InMemoryComputeProvider({ maxVolumes: 1 });
    await p.createVolume(volumeInput({ name: "v1" }));
    await expect(p.createVolume(volumeInput({ name: "v2" }))).rejects.toMatchObject({
      code: "no_capacity",
    });
    expect((await p.listVolumes()).length).toBe(1);
  });

  test("mutating actions on a missing server/volume throw not_found — no no-op success action", async () => {
    const p = new InMemoryComputeProvider();
    await expect(p.powerOff(999)).rejects.toMatchObject({ code: "not_found" });
    await expect(p.powerOn(999)).rejects.toMatchObject({ code: "not_found" });
    await expect(p.detachVolume(999)).rejects.toMatchObject({ code: "not_found" });
    const { server } = await p.createServer(serverInput());
    await expect(p.attachVolume(999, server.id as number)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("waitForAction on an unknown id throws not_found — never fabricates `completed`", async () => {
    const p = new InMemoryComputeProvider();
    // The dangerous slop would be returning a synthesized `completed` action so
    // the caller believes an attach/power op that never existed succeeded.
    await expect(p.waitForAction(424242)).rejects.toMatchObject({ code: "not_found" });
  });

  test("waitForAction on a poisoned id surfaces `errored` observably — not fabricated `completed`", async () => {
    const p = new InMemoryComputeProvider();
    const { server } = await p.createServer(serverInput());
    const action = await p.powerOff(server.id as number);
    p.poisonAction(action.id as number);

    const done = await p.waitForAction(action.id as number);
    // Mirrors the real Hetzner client returning the error action (not throwing),
    // but the failure MUST remain observable: status errored + populated error.
    expect(done.status).toBe(ACTION_STATUS_ERRORED);
    expect(done.status).not.toBe(ACTION_STATUS_COMPLETED);
    expect(done.error).not.toBeNull();
    expect(done.error).toMatchObject({ code: "action_failed" });
  });

  test("tick with invalid input throws invalid_input — the clock never silently no-ops", () => {
    const p = new InMemoryComputeProvider();
    expect(() => p.tick(-1)).toThrow(ComputeFakeError);
    expect(() => p.tick(1.5)).toThrow(ComputeFakeError);
    // A rejected tick leaves the clock untouched rather than swallowing to a default.
    expect(p.now()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Legitimately-empty reads stay DISTINCT from internal failure
// ---------------------------------------------------------------------------

describe("designed-empty is distinguishable from failure", () => {
  test("getServer/getVolume return null for a genuinely-absent id — a designed miss, not a throw", async () => {
    const p = new InMemoryComputeProvider();
    // A not-found READ resolves null (a distinguishable "absent"); it does NOT
    // throw and does NOT fabricate a record. Contrast waitForAction/powerOff
    // above, where a missing id is an internal failure that throws.
    await expect(p.getServer(1)).resolves.toBeNull();
    await expect(p.getVolume(1)).resolves.toBeNull();
  });

  test("listServers/listVolumes on an empty store return [] — a healthy empty, not a masked failure", async () => {
    const p = new InMemoryComputeProvider();
    await expect(p.listServers()).resolves.toEqual([]);
    await expect(p.listServers({ role: "pool" })).resolves.toEqual([]);
    await expect(p.listVolumes()).resolves.toEqual([]);
  });

  test("a deleted server reads as absent (null + dropped from list), never as a failure", async () => {
    const p = new InMemoryComputeProvider();
    const { server } = await p.createServer(serverInput());
    const id = server.id as number;
    await expect(p.deleteServer(id)).resolves.toBeUndefined();
    // Idempotent delete is a designed 404==success no-op, distinct from a throw.
    await expect(p.deleteServer(id)).resolves.toBeUndefined();
    await expect(p.getServer(id)).resolves.toBeNull();
    await expect(p.listServers()).resolves.toEqual([]);
  });

  test("listImages snapshot filter returns a designed-empty [] — distinct from an errored catalog read", async () => {
    const p = new InMemoryComputeProvider();
    // Empty because the filter legitimately matches nothing (a 200 with 0 rows),
    // NOT because a catalog fetch failed and was swallowed to [].
    await expect(p.listImages({ type: "snapshot" })).resolves.toEqual([]);
    const all = await p.listImages();
    expect(all.length).toBeGreaterThan(0);
  });
});
