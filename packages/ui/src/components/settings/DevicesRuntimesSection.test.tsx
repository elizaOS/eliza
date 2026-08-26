/** Interaction and accessibility coverage for the Devices & Runtimes surface. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SshHostInspection } from "../../platform/ssh-runtime";
import {
  DevicesRuntimesSection,
  type DevicesRuntimesSectionProps,
} from "./DevicesRuntimesSection";

afterEach(cleanup);

function props(
  overrides: Partial<DevicesRuntimesSectionProps> = {},
): DevicesRuntimesSectionProps {
  return {
    targets: [
      {
        id: "local",
        label: "This Linux device",
        detail: "This device · private local runtime",
        kind: "local",
        status: "connected",
        selected: true,
        activity: "Currently in use",
      },
      {
        id: "host:mac",
        label: "Studio Mac",
        detail: "Mac · Cloud relay",
        kind: "relay",
        status: "offline",
        selected: false,
        activity: "Last seen yesterday",
        canPair: true,
      },
    ],
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    onPair: vi.fn(),
    onRevoke: vi.fn(),
    onRemove: vi.fn(),
    onInspectSsh: vi.fn(),
    onConnectSsh: vi.fn(),
    ...overrides,
  };
}

describe("DevicesRuntimesSection", () => {
  it("announces target state and exposes touch-sized retry and pairing actions", async () => {
    const user = userEvent.setup();
    const onPair = vi.fn();
    const onRetry = vi.fn();
    render(<DevicesRuntimesSection {...props({ onPair, onRetry })} />);

    expect(
      screen.getByRole("article", {
        name: "This Linux device, Connected, selected",
      }),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Mac's 6-digit code"), "123456");
    await user.click(screen.getByRole("button", { name: "Claim pairing" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onPair).toHaveBeenCalledWith("host:mac", "123456");
    expect(onRetry).toHaveBeenCalledWith("host:mac");
    expect(
      screen.getByRole("button", { name: "Claim pairing" }).className,
    ).toContain("min-h-11");
  });

  it("renders an independent six-digit code, real QR image, and expiry status", () => {
    render(
      <DevicesRuntimesSection
        {...props({
          pairing: {
            hostId: "host-mac",
            hostLabel: "Studio Mac",
            sessionId: "session-1",
            code: "420731",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            qrPayload:
              "elizaos://remote/control-claim?session=session-1&code=420731",
            capabilities: ["agent.status", "agent.request"],
            status: "pending",
          },
        })}
      />,
    );
    expect(screen.getByTestId("pairing-code").textContent).toBe("420731");
    expect(
      screen.getByRole("img", {
        name: "QR code for this one-use pairing session",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Expires in 5:00|Expires in 4:59/)).toBeTruthy();
  });

  it("shows the exact claimed controller and requires target-side confirm or deny", async () => {
    const user = userEvent.setup();
    const onConfirmTargetPairing = vi.fn();
    const onDenyTargetPairing = vi.fn();
    const pairing = {
      hostId: "mac-host",
      hostLabel: "This Mac",
      sessionId: "session-1",
      code: "123456",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      qrPayload: "elizaos://remote/control-claim?session=session-1&code=123456",
      capabilities: ["agent.status", "agent.request"],
      status: "claimed" as const,
      controller: {
        deviceId: "iphone-one",
        keyId: "controller-key-one",
        displayName: "Nubs's iPhone",
        platform: "ios",
      },
    };
    const view = render(
      <DevicesRuntimesSection
        {...props({
          pairing,
          linuxTarget: {
            hostId: "mac-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
            platform: "macos",
          },
          onConfirmTargetPairing,
          onDenyTargetPairing,
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm controller on this Mac",
      }),
    );
    expect(onConfirmTargetPairing).toHaveBeenCalledWith("session-1");
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDenyTargetPairing).toHaveBeenCalledWith("session-1");
    expect(screen.getByText("Confirm Nubs's iPhone")).toBeTruthy();
    expect(screen.getByText(/controller-key-one/)).toBeTruthy();

    view.rerender(
      <DevicesRuntimesSection
        {...props({
          pairing: { ...pairing, hostId: "foreign-host" },
          linuxTarget: {
            hostId: "mac-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
            platform: "macos",
          },
          onConfirmTargetPairing,
        })}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Confirm controller on this Mac",
      }),
    ).toBeNull();
  });

  it("lets an enrolled Mac create the controller challenge instead of consuming one", async () => {
    const user = userEvent.setup();
    const onCreateTargetPairing = vi.fn(async () => undefined);
    render(
      <DevicesRuntimesSection
        {...props({
          linuxTarget: {
            hostId: "mac-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
            platform: "macos",
          },
          onCreateTargetPairing,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    expect(onCreateTargetPairing).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("6-digit code")).toBeNull();
  });

  it("requires an explicit managed-network opt-in before native enrollment", async () => {
    const user = userEvent.setup();
    const onEnrollLinuxTarget = vi.fn();
    render(
      <DevicesRuntimesSection
        {...props({
          linuxTarget: {
            hostId: null,
            enrolled: false,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
            platform: "linux",
          },
          onEnrollLinuxTarget,
        })}
      />,
    );
    await user.click(
      screen.getByRole("switch", {
        name: "Use Eliza managed private network",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Enroll this computer" }),
    );
    expect(onEnrollLinuxTarget).toHaveBeenCalledWith(true);
  });

  it("requires inspection before connect and blocks a changed host key", async () => {
    const user = userEvent.setup();
    const onInspectSsh = vi.fn();
    const changed: SshHostInspection = {
      target: "eliza@vps.example",
      host: "vps.example",
      sshPort: 22,
      fingerprints: [
        { algorithm: "ssh-ed25519", fingerprint: `SHA256:${"A".repeat(43)}` },
      ],
      preferredFingerprint: `SHA256:${"A".repeat(43)}`,
      pinnedFingerprint: `SHA256:${"B".repeat(43)}`,
      changed: true,
    };
    const view = render(
      <DevicesRuntimesSection {...props({ onInspectSsh })} />,
    );
    await user.click(screen.getByText("Advanced SSH"));
    await user.type(screen.getByLabelText("Name"), "Production VPS");
    await user.type(screen.getByLabelText("SSH target"), "eliza@vps.example");
    await user.click(
      screen.getByRole("button", { name: "Inspect fingerprint" }),
    );
    expect(onInspectSsh).toHaveBeenCalledWith({
      target: "eliza@vps.example",
      sshPort: 22,
    });

    view.rerender(
      <DevicesRuntimesSection {...props({ sshInspection: changed })} />,
    );
    expect(
      screen.getByText("Host key changed: connection blocked"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Fingerprint verified, connect",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
