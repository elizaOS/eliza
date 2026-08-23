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
    expect(screen.getByText("Connected").className).toContain(
      "text-txt-strong",
    );
    expect(screen.getByText("Connected").className).not.toContain("text-ok");
  });

  it("keeps error state legible without relying on destructive theme color", () => {
    render(
      <DevicesRuntimesSection
        {...props({
          targets: [
            {
              id: "host:error",
              label: "Studio Mac",
              detail: "Mac · Cloud relay",
              kind: "relay",
              status: "error",
              selected: false,
              activity: "Connection failed",
              error: "Relay unavailable. Retry when the host is online.",
              canRemove: true,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Needs attention").className).toContain(
      "text-txt-strong",
    );
    expect(screen.getByRole("alert").className).toContain("text-txt-strong");
    expect(screen.getByRole("alert").className).not.toContain(
      "text-destructive",
    );
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain(
      "text-txt-strong",
    );
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

  it("offers one-click activation only when pairing authority matches this desktop host", async () => {
    const user = userEvent.setup();
    const onActivateDesktopTarget = vi.fn();
    const pairing = {
      hostId: "linux-host",
      hostLabel: "This Mac",
      sessionId: "session-1",
      code: "123456",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      qrPayload: "elizaos://remote/pair?session=session-1&code=123456",
    };
    const view = render(
      <DevicesRuntimesSection
        {...props({
          pairing,
          desktopTarget: {
            hostId: "linux-host",
            platform: "macos",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
          },
          onActivateDesktopTarget,
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Approve this pairing on this computer",
      }),
    );
    expect(onActivateDesktopTarget).toHaveBeenCalledWith({
      sessionId: "session-1",
      code: "123456",
    });

    view.rerender(
      <DevicesRuntimesSection
        {...props({
          pairing: { ...pairing, hostId: "foreign-host" },
          desktopTarget: {
            hostId: "linux-host",
            platform: "macos",
            enrolled: true,
            running: false,
            activeSessions: 0,
            lastErrorCode: null,
          },
          onActivateDesktopTarget,
        })}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "Approve this pairing on this computer",
      }),
    ).toBeNull();
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
      screen.getByText("Host key changed — connection blocked"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "I verified this fingerprint — connect",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("restores the trust-gated direct private runtime flow", async () => {
    const user = userEvent.setup();
    const onAddDirectRuntime = vi.fn();
    render(
      <DevicesRuntimesSection
        {...props({ onAddDirectRuntime, cloudState: "signed-out" })}
      />,
    );

    await user.click(screen.getByText("Advanced direct runtime"));
    await user.type(screen.getByLabelText("Runtime name"), "Home VPS");
    await user.type(
      screen.getByLabelText("Private runtime URL"),
      "http://100.64.0.10:3000",
    );
    await user.type(
      screen.getByLabelText("Direct runtime token (optional)"),
      "private-token",
    );
    const add = screen.getByRole("button", { name: "Add private runtime" });
    expect(add.className).toContain("min-h-11");
    await user.click(add);
    expect(onAddDirectRuntime).toHaveBeenCalledWith({
      label: "Home VPS",
      apiBase: "http://100.64.0.10:3000",
      accessToken: "private-token",
    });
  });
});
