import { describe, expect, it, vi } from "vitest";
import {
  type LogindCommandRunner,
  SystemdLogindSessionResolver,
} from "./linux-logind";

function handle(liveness: boolean[] = Array(8).fill(true)) {
  return {
    pid: 4321,
    isAlive: vi.fn(async () => liveness.shift() ?? false),
    close: vi.fn(),
  };
}

function runner(outputs: string[]): LogindCommandRunner {
  return {
    run: vi.fn(async () => {
      const output = outputs.shift();
      if (output === undefined) throw new Error("unexpected lookup");
      return output;
    }),
  };
}

function snapshot(
  overrides: Record<string, { type: string; data: unknown }> = {},
): string {
  return JSON.stringify({
    type: "a{sv}",
    data: {
      Id: { type: "s", data: "32" },
      User: {
        type: "(uo)",
        data: [1000, "/org/freedesktop/login1/user/_1000"],
      },
      Active: { type: "b", data: true },
      LockedHint: { type: "b", data: false },
      Remote: { type: "b", data: false },
      Seat: {
        type: "(so)",
        data: ["seat0", "/org/freedesktop/login1/seat/seat0"],
      },
      Class: { type: "s", data: "user" },
      State: { type: "s", data: "active" },
      ...overrides,
    },
  });
}

const sessionPath = 'o "/org/freedesktop/login1/session/_32"';

describe("systemd-logind session resolver", () => {
  it("binds the pidfd-backed process to one coherent active-seat snapshot", async () => {
    const commands = runner([sessionPath, snapshot(), sessionPath]);
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `local-owner-${uid}`,
      runner: commands,
    });
    const process = handle();

    await expect(resolver.inspectForProcess(process, 1000)).resolves.toEqual({
      ownerId: "local-owner-1000",
      uid: 1000,
      sessionId: "32",
      active: true,
      locked: false,
    });
    expect(process.isAlive).toHaveBeenCalledTimes(6);
    expect(commands.run).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(["GetSessionByPID", "u", "4321"]),
    );
    expect(commands.run).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining(["GetSessionByPID", "u", "4321"]),
    );
    expect(commands.run).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        "--json=short",
        "org.freedesktop.DBus.Properties",
        "GetAll",
        "s",
        "org.freedesktop.login1.Session",
      ]),
    );
  });

  it.each([
    ["remote", { Remote: { type: "b", data: true } }],
    ["inactive", { Active: { type: "b", data: false } }],
    ["locked", { LockedHint: { type: "b", data: true } }],
    ["seatless", { Seat: { type: "(so)", data: ["", "/"] } }],
    ["non-user", { Class: { type: "s", data: "greeter" } }],
    ["non-active-state", { State: { type: "s", data: "online" } }],
  ])("rejects a %s session snapshot", async (_name, overrides) => {
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: runner([sessionPath, snapshot(overrides)]),
    });
    await expect(
      resolver.inspectForProcess(handle(), 1000),
    ).resolves.toBeNull();
  });

  it("rejects a session whose snapshot uid differs from SO_PEERCRED", async () => {
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: runner([
        sessionPath,
        snapshot({
          User: {
            type: "(uo)",
            data: [1001, "/org/freedesktop/login1/user/_1001"],
          },
        }),
      ]),
    });
    await expect(
      resolver.inspectForProcess(handle(), 1000),
    ).resolves.toBeNull();
  });

  it("fails closed when the pidfd becomes dead during a lookup", async () => {
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: runner([sessionPath, snapshot()]),
    });
    await expect(
      resolver.inspectForProcess(handle([true, false]), 1000),
    ).resolves.toBeNull();
  });

  it("rejects when the live process changes sessions around the snapshot", async () => {
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: runner([
        sessionPath,
        snapshot(),
        'o "/org/freedesktop/login1/session/_33"',
      ]),
    });
    await expect(
      resolver.inspectForProcess(handle(), 1000),
    ).resolves.toBeNull();
  });

  it("cannot authorize a session assembled across a property transition", async () => {
    const run = vi.fn(async (argv: readonly string[]) => {
      if (argv.includes("GetSessionByPID")) return sessionPath;
      if (argv.includes("GetAll")) {
        // One authoritative post-transition snapshot is inactive and must fail.
        return snapshot({ Active: { type: "b", data: false } });
      }
      // A legacy per-property implementation could combine pre-transition
      // Active=true with post-transition LockedHint=false and authorize a
      // session that is now inactive.
      if (argv.includes("Id")) return 's "32"';
      if (argv.includes("User")) {
        return '(uo) 1000 "/org/freedesktop/login1/user/_1000"';
      }
      if (argv.includes("Active")) return "b true";
      if (argv.includes("LockedHint")) return "b false";
      if (argv.includes("Remote")) return "b false";
      throw new Error("unexpected lookup");
    });
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: { run },
    });

    await expect(
      resolver.inspectForProcess(handle(), 1000),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or type-confused property snapshots", async () => {
    const resolver = new SystemdLogindSessionResolver({
      ownerIdForUid: (uid) => `owner-${uid}`,
      runner: runner([
        sessionPath,
        snapshot({ Active: { type: "s", data: "true" } }),
      ]),
    });
    await expect(
      resolver.inspectForProcess(handle(), 1000),
    ).resolves.toBeNull();
  });
});
