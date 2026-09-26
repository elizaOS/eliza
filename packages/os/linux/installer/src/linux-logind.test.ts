import { describe, expect, it, vi } from "vitest";
import { SystemdLogindSessionResolver } from "./linux-logind";

const path = "/org/freedesktop/login1/session/_31";
function fixture() {
  const properties = {
    Id: { type: "s", data: "1" },
    User: { type: "(uo)", data: [1000, "/org/freedesktop/login1/user/_1000"] },
    Seat: {
      type: "(so)",
      data: ["seat0", "/org/freedesktop/login1/seat/seat0"],
    },
    Class: { type: "s", data: "user" },
    State: { type: "s", data: "active" },
    Remote: { type: "b", data: false },
    Active: { type: "b", data: true },
    LockedHint: { type: "b", data: false },
  };
  const run = vi.fn(async (args: readonly string[]) =>
    args.includes("GetAll")
      ? JSON.stringify({ type: "a{sv}", data: [properties] })
      : `o "${path}"`,
  );
  const owner = vi.fn(() => "owner-1");
  const process = {
    pid: 123,
    isAlive: vi.fn(async () => true),
    close: vi.fn(),
  };
  return {
    properties,
    run,
    owner,
    process,
    resolver: new SystemdLogindSessionResolver({
      ownerIdForUid: owner,
      runner: { run },
    }),
  };
}

describe("system logind session snapshots", () => {
  it("accepts the real busctl GetAll array envelope and binds owner, UID and session", async () => {
    const f = fixture();
    await expect(
      f.resolver.inspectForProcess(f.process, 1000),
    ).resolves.toEqual({
      ownerId: "owner-1",
      uid: 1000,
      sessionId: "1",
      active: true,
      locked: false,
    });
    expect(f.owner).toHaveBeenCalledWith(1000);
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.process.close).not.toHaveBeenCalled();
  });

  it("rejects invalid envelopes rather than silently treating them as absent sessions", async () => {
    for (const document of [
      null,
      [],
      { type: "a{sv}", data: {} },
      { type: "a{sv}", data: [] },
      { type: "a{sv}", data: [{}, {}] },
      { type: "a{sv}", data: [null] },
      { type: "s", data: [{}] },
    ]) {
      const f = fixture();
      f.run
        .mockResolvedValueOnce(`o "${path}"`)
        .mockResolvedValueOnce(JSON.stringify(document));
      await expect(
        f.resolver.inspectForProcess(f.process, 1000),
      ).rejects.toThrow("invalid session property snapshot");
      expect(f.owner).not.toHaveBeenCalled();
    }
  });

  it("refuses locked, inactive, remote, mismatched and non-user sessions", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.properties.LockedHint.data = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.properties.Active.data = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.properties.Remote.data = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.properties.Class.data = "greeter";
      },
      (f: ReturnType<typeof fixture>) => {
        f.properties.State.data = "closing";
      },
    ]) {
      const f = fixture();
      mutate(f);
      await expect(
        f.resolver.inspectForProcess(f.process, 1000),
      ).resolves.toBeNull();
      expect(f.owner).not.toHaveBeenCalled();
    }
    const f = fixture();
    await expect(
      f.resolver.inspectForProcess(f.process, 1001),
    ).resolves.toBeNull();
  });

  it("retains peer liveness and membership checks around the property snapshot", async () => {
    const dead = fixture();
    dead.process.isAlive.mockResolvedValue(false);
    await expect(
      dead.resolver.inspectForProcess(dead.process, 1000),
    ).rejects.toThrow("peer exited");
    expect(dead.run).not.toHaveBeenCalled();
    const moved = fixture();
    moved.run
      .mockResolvedValueOnce(`o "${path}"`)
      .mockResolvedValueOnce(
        JSON.stringify({ type: "a{sv}", data: [moved.properties] }),
      )
      .mockResolvedValueOnce('o "/org/freedesktop/login1/session/_32"');
    await expect(
      moved.resolver.inspectForProcess(moved.process, 1000),
    ).resolves.toBeNull();
    expect(moved.owner).not.toHaveBeenCalled();
  });

  it("rejects wrong property signatures and invalid owner mappings", async () => {
    const f = fixture();
    f.properties.Active.type = "s";
    await expect(f.resolver.inspectForProcess(f.process, 1000)).rejects.toThrow(
      "invalid Active property",
    );
    const invalidOwner = fixture();
    invalidOwner.owner.mockReturnValue(" ");
    await expect(
      invalidOwner.resolver.inspectForProcess(invalidOwner.process, 1000),
    ).rejects.toThrow("invalid owner id");
  });
});
