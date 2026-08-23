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
    await user.click(screen.getByRole("button", { name: "Pair device" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onPair).toHaveBeenCalledWith("host:mac");
    expect(onRetry).toHaveBeenCalledWith("host:mac");
    expect(
      screen.getByRole("button", { name: "Pair device" }).className,
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
            qrPayload: "elizaos://remote/pair?session=session-1&code=420731",
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

  it("offers one-click activation only when pairing authority matches this Linux host", async () => {
    const user = userEvent.setup();
    const onActivateLinuxTarget = vi.fn();
    const pairing = {
      hostId: "linux-host",
      hostLabel: "This Linux computer",
      sessionId: "session-1",
      code: "123456",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      qrPayload: "elizaos://remote/pair?session=session-1&code=123456",
    };
    const view = render(
      <DevicesRuntimesSection
        {...props({
          pairing,
          linuxTarget: {
            hostId: "linux-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
          },
          onActivateLinuxTarget,
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Approve this pairing on this Linux computer",
      }),
    );
    expect(onActivateLinuxTarget).toHaveBeenCalledWith({
      sessionId: "session-1",
      code: "123456",
    });

    view.rerender(
      <DevicesRuntimesSection
        {...props({
          pairing: { ...pairing, hostId: "foreign-host" },
          linuxTarget: {
            hostId: "linux-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
          },
          onActivateLinuxTarget,
        })}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Approve this pairing on this Linux computer",
      }),
    ).toBeNull();
  });

  it("activates an enrolled Linux target from an independent six-digit code", async () => {
    const user = userEvent.setup();
    const onActivateLinuxTarget = vi.fn(async () => undefined);
    render(
      <DevicesRuntimesSection
        {...props({
          linuxTarget: {
            hostId: "linux-host",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
          },
          onActivateLinuxTarget,
        })}
      />,
    );
    const submit = screen.getByRole("button", { name: "Approve pairing" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("6-digit code"), "12a34567");
    expect(
      (screen.getByLabelText("6-digit code") as HTMLInputElement).value,
    ).toBe("123456");
    await user.click(submit);
    expect(onActivateLinuxTarget).toHaveBeenCalledWith({ code: "123456" });
    expect(screen.queryByLabelText("Pairing session ID")).toBeNull();
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
