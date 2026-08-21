/** Exercises deterministic current-user broker endpoint and ACL contracts without registering a host. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertUnixSocketPathLength,
  createMacAppGroupBrokerTransportDescriptor,
  createUnixBrokerTransportDescriptor,
  createWindowsBrokerTransportDescriptor,
  defaultBrokerTransportDescriptor,
  prepareUnixBrokerSocketDirectory,
  resolveWindowsCurrentUserSid,
  UnixSocketPathTooLongError,
} from "./browser-bridge-broker-transport";

const tempRoots: string[] = [];

describe("browser bridge broker transport contracts", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0))
      fs.rmSync(root, { force: true, recursive: true });
  });

  it("creates a private current-user Unix endpoint directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-broker-"));
    tempRoots.push(stateDir);
    const descriptor = createUnixBrokerTransportDescriptor(
      { ELIZA_STATE_DIR: stateDir },
      process.getuid?.() ?? 501,
    );

    prepareUnixBrokerSocketDirectory(descriptor);

    expect(descriptor).toMatchObject({
      kind: "unix",
      directoryMode: 0o700,
      socketMode: 0o600,
    });
    expect(descriptor.socketPath).toBe(path.join(stateDir, "bb", "b.sock"));
    expect(fs.statSync(path.dirname(descriptor.socketPath)).mode & 0o777).toBe(
      0o700,
    );
  });

  it("pins a Windows named pipe to SYSTEM and the exact current-user SID", () => {
    const descriptor = createWindowsBrokerTransportDescriptor(
      "S-1-5-21-111-222-333-1001",
      Buffer.alloc(32, 4),
    );

    expect(descriptor.kind).toBe("windows_named_pipe");
    expect(descriptor.pipePath).toMatch(
      /^\\\\\.\\pipe\\ai\.elizaos\.browserbridge-/,
    );
    expect(descriptor.sddl).toBe(
      "O:S-1-5-21-111-222-333-1001D:P(A;;GA;;;SY)(A;;GA;;;S-1-5-21-111-222-333-1001)",
    );
    expect(descriptor.rejectRemoteClients).toBe(true);
  });

  it("resolves and validates the exact current-user SID on Windows", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: '"DESKTOP\\\\owner","S-1-5-21-111-222-333-1001"',
    }));
    expect(resolveWindowsCurrentUserSid(run)).toBe("S-1-5-21-111-222-333-1001");
    expect(run).toHaveBeenCalledWith(
      "whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(
      defaultBrokerTransportDescriptor({
        platform: "win32",
        windowsSidResolver: () => "S-1-5-21-111-222-333-1001",
        brokerSecret: Buffer.alloc(32, 4),
      }),
    ).toMatchObject({ currentUserSid: "S-1-5-21-111-222-333-1001" });
    expect(() =>
      resolveWindowsCurrentUserSid(() => ({ status: 0, stdout: "invalid" })),
    ).toThrow("returned no SID");
    expect(() =>
      createWindowsBrokerTransportDescriptor("Everyone", Buffer.alloc(32, 4)),
    ).toThrow("SID is invalid");
  });

  it("binds the Windows pipe name to the per-install broker secret", () => {
    const sid = "S-1-5-21-111-222-333-1001";
    const first = createWindowsBrokerTransportDescriptor(
      sid,
      Buffer.alloc(32, 1),
    );
    const second = createWindowsBrokerTransportDescriptor(
      sid,
      Buffer.alloc(32, 2),
    );
    expect(first.pipePath).not.toBe(second.pipePath);
    expect(first.currentUserSid).toBe(second.currentUserSid);
  });

  it("enforces Darwin Unix socket byte limits before listen or connect", () => {
    const maximum = `/${"a".repeat(102)}`;
    const overlong = `/${"a".repeat(103)}`;
    expect(Buffer.byteLength(maximum, "utf8")).toBe(103);
    expect(() => assertUnixSocketPathLength(maximum, "darwin")).not.toThrow();
    expect(() => assertUnixSocketPathLength(overlong, "darwin")).toThrow(
      UnixSocketPathTooLongError,
    );
  });

  it("keeps the macOS app-group endpoint within Darwin sun_path", () => {
    const container = path.join(
      "/Users/owner/Library/Group Containers",
      "group.ai.elizaos.browserbridge",
    );
    const descriptor = createMacAppGroupBrokerTransportDescriptor(
      container,
      501,
    );
    expect(descriptor.socketPath).toBe(path.join(container, "b.sock"));
    expect(
      Buffer.byteLength(descriptor.socketPath, "utf8"),
    ).toBeLessThanOrEqual(103);
  });
});
