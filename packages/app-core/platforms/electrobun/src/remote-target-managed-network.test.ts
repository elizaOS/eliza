import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  remoteTargetManagedNetworkInternals,
  TailscaleCliManagedNetworkJoiner,
} from "./remote-target-managed-network";

class FakeChild extends EventEmitter {
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("native managed-network enrollment", () => {
  it("passes a one-use key through a mode-0600 file and never process arguments", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-managed-network-test-"),
    );
    try {
      let observedArgs: readonly string[] = [];
      let observedKey = "";
      let observedMode = 0;
      const joiner = new TailscaleCliManagedNetworkJoiner(
        async () => "/test/tailscale",
        (_command, args) => {
          observedArgs = args;
          const authArgument = args.find((arg) =>
            arg.startsWith("--auth-key=file:"),
          );
          const authPath = authArgument?.slice("--auth-key=file:".length);
          if (!authPath) throw new Error("missing auth key file");
          const child = new FakeChild();
          void (async () => {
            observedKey = await fs.readFile(authPath, "utf8");
            observedMode = (await fs.stat(authPath)).mode & 0o777;
            child.emit("close", 0);
          })();
          return child as unknown as ChildProcess;
        },
        temporaryRoot,
        () => 2_000_000_000_000,
        async () => undefined,
      );
      const authKey = "hskey-auth-one-use-secret";
      await joiner.join({
        loginServer: "https://headscale-staging.example",
        authKey,
        hostname: "eliza-host-one",
        expiresAt: 2_000_000_030_000,
      });
      expect(observedKey).toBe(authKey);
      expect(observedMode).toBe(0o600);
      expect(observedArgs.join(" ")).not.toContain(authKey);
      expect(observedArgs).toContain("--shields-up");
      expect(observedArgs).not.toContain("--reset");
      await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects expired or unsafe enrollment before spawning", async () => {
    let spawned = false;
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
    );
    await expect(
      joiner.join({
        loginServer: "http://attacker.example",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: 2_000_000_030_000,
      }),
    ).rejects.toThrow("login server is invalid");
    await expect(
      joiner.join({
        loginServer: "https://headscale.example",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: 1_999_999_999_999,
      }),
    ).rejects.toThrow("expired");
    expect(spawned).toBe(false);
  });

  it("refuses to switch an existing personal tailnet before spawning up", async () => {
    let spawned = false;
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
      async () =>
        remoteTargetManagedNetworkInternals.assertVacantTailscaleStatus(
          JSON.stringify({
            BackendState: "Running",
            CurrentTailnet: { Name: "personal.example" },
            Self: { HostName: "personal-laptop" },
            TailscaleIPs: ["100.64.0.1"],
          }),
        ),
    );

    await expect(
      joiner.join({
        loginServer: "https://headscale.example",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: 2_000_000_030_000,
      }),
    ).rejects.toThrow("cannot replace an existing Tailscale tailnet");
    expect(spawned).toBe(false);
  });

  it("accepts only a vacant daemon status", () => {
    expect(() =>
      remoteTargetManagedNetworkInternals.assertVacantTailscaleStatus(
        JSON.stringify({ BackendState: "NeedsLogin", TailscaleIPs: [] }),
      ),
    ).not.toThrow();
    expect(() =>
      remoteTargetManagedNetworkInternals.assertVacantTailscaleStatus(
        "not-json",
      ),
    ).toThrow("could not be verified safely");
  });

  it("logs out only the durable managed hostname", async () => {
    let observedArgs: readonly string[] = [];
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      (_command, args) => {
        observedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
      async () => undefined,
      async () =>
        JSON.stringify({
          BackendState: "Running",
          Self: { HostName: "eliza-host-one-cafebabe" },
        }),
    );

    await joiner.leave({ hostname: "eliza-host-one" });
    expect(observedArgs).toEqual(["logout"]);
  });

  it("does not log out a profile that no longer matches the managed host", async () => {
    let spawned = false;
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
      async () => undefined,
      async () =>
        JSON.stringify({
          BackendState: "Running",
          Self: { HostName: "personal-laptop" },
        }),
    );

    await expect(joiner.leave({ hostname: "eliza-host-one" })).rejects.toThrow(
      "not the managed Eliza membership",
    );
    expect(spawned).toBe(false);
  });

  it("treats an already-vacant daemon as idempotently left", async () => {
    let spawned = false;
    const joiner = new TailscaleCliManagedNetworkJoiner(
      async () => "/test/tailscale",
      () => {
        spawned = true;
        return new FakeChild() as unknown as ChildProcess;
      },
      os.tmpdir(),
      () => 2_000_000_000_000,
      async () => undefined,
      async () =>
        JSON.stringify({ BackendState: "NeedsLogin", TailscaleIPs: [] }),
    );

    await joiner.leave({ hostname: "eliza-host-one" });
    expect(spawned).toBe(false);
  });
});
