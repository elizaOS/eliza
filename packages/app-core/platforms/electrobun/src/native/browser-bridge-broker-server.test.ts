/** Exercises bounded Unix broker client/server IPC with a real authenticated enrollment broker. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBrowserBridgeBrokerServer } from "./browser-bridge-broker-server";
import {
  createUnixBrokerTransportDescriptor,
  createWindowsBrokerTransportDescriptor,
  NodeBrowserBridgeBrokerTransport,
} from "./browser-bridge-broker-transport";
import { BrowserBridgeEnrollmentBroker } from "./browser-bridge-enrollment-broker";
import {
  BROWSER_BRIDGE_BROKER_PROTOCOL,
  signBrokerEnvelope,
} from "./browser-bridge-native-protocol";

const roots: string[] = [];

describe("browser bridge broker IPC", () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("round-trips one authenticated bounded frame over a mode-0600 Unix socket", async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-broker-ipc-"),
    );
    roots.push(stateDir);
    const descriptor = createUnixBrokerTransportDescriptor(
      { ELIZA_STATE_DIR: stateDir },
      process.getuid?.() ?? 501,
    );
    const secret = Buffer.alloc(32, 14);
    const nowMs = 1_800_000_000_000;
    const extensionId = "abcdefghijklmnopabcdefghijklmnop";
    const profileId = "123e4567-e89b-42d3-a456-426614174001";
    const broker = new BrowserBridgeEnrollmentBroker({
      apiBase: "http://127.0.0.1:31337",
      ownerSession: async () => ({
        sessionId: "owner-session",
        csrfToken: "owner-csrf",
        expiresAt: Date.now() + 60_000,
      }),
      brokerSecret: secret,
      callerAllowlist: {
        chromeExtensionIds: [extensionId],
        firefoxExtensionIds: [],
        safariExtensionIds: [],
      },
      now: () => nowMs,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            companion: {
              id: "companion-1",
              browser: "chrome",
              profileId,
              profileLabel: "Personal",
              label: "Chrome Personal",
            },
            pairingToken: "pairing-secret",
            pairingTokenExpiresAt: null,
          }),
          { status: 201 },
        ),
    });
    const server = await startBrowserBridgeBrokerServer({ descriptor, broker });
    try {
      expect(fs.statSync(descriptor.socketPath).mode & 0o777).toBe(0o600);
      const envelope = signBrokerEnvelope(
        {
          protocol: BROWSER_BRIDGE_BROKER_PROTOCOL,
          timestampMs: nowMs,
          caller: { browser: "chrome", id: extensionId },
          request: {
            v: 1,
            type: "browser_bridge.enroll",
            requestId: "123e4567-e89b-42d3-a456-426614174000",
            nonce: Buffer.alloc(32, 2).toString("base64url"),
            browser: "chrome",
            extensionId,
            extensionVersion: "1.2.3",
            profileId,
          },
        },
        secret,
      );
      const response = await new NodeBrowserBridgeBrokerTransport(
        descriptor,
      ).request(Buffer.from(JSON.stringify(envelope), "utf8"));
      expect(JSON.parse(Buffer.from(response).toString("utf8"))).toMatchObject({
        type: "browser_bridge.enroll_result",
        config: { companionId: "companion-1" },
      });
    } finally {
      await server.close();
    }
    expect(fs.existsSync(descriptor.socketPath)).toBe(false);
  });

  it("creates Windows pipes with an at-creation DACL and remote-client rejection", async () => {
    const descriptor = createWindowsBrokerTransportDescriptor(
      "S-1-5-21-111-222-333-1001",
      Buffer.alloc(32, 9),
    );
    const { windowsSecurePipeHostInvocation } = await import(
      "./browser-bridge-broker-server"
    );
    const helperPath = "C:\\Program Files\\Eliza\\browser-bridge-pipe-host.ps1";
    const invocation = windowsSecurePipeHostInvocation(descriptor, helperPath);
    expect(invocation.command).toBe("powershell.exe");
    expect(invocation.args).toContain(helperPath);
    expect(invocation.args).toContain(
      descriptor.pipePath.replace(/^\\\\\.\\pipe\\/, ""),
    );
    const helper = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../scripts/browser-bridge-pipe-host.ps1",
      ),
      "utf8",
    );
    expect(helper).not.toContain(
      "[System.IO.Pipes.PipeOptions]::CurrentUserOnly",
    );
    expect(helper).toContain("PIPE_REJECT_REMOTE_CLIENTS = 0x00000008");
    expect(helper).toContain("FILE_FLAG_FIRST_PIPE_INSTANCE");
    expect(helper).toContain("CreateNamedPipeW(");
    expect(helper).toContain('sid.Value.StartsWith("S-1-5-5-"');
    expect(helper).toContain('"D:P(A;;GA;;;SY)(A;;GA;;;"');
    expect(helper).toContain("new NamedPipeServerStream(");
    const executableProbe = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../scripts/test-browser-bridge-windows-security.ps1",
      ),
      "utf8",
    );
    expect(executableProbe).toContain("NamedPipeClientStream");
    expect(executableProbe).toContain("Invoke-SecurePipeRoundTrip");
    expect(executableProbe).toContain("StandardOutput.BaseStream");
    expect(executableProbe).toContain("StandardInput.BaseStream");
  });
});
