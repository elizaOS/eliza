// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifeOpsClient = vi.hoisted(() => ({
  checkAppBlockerPermissions: vi.fn(),
  getAppBlockerStatus: vi.fn(),
  getInstalledAppsToBlock: vi.fn(),
  requestAppBlockerPermissions: vi.fn(),
  selectAppBlockerApps: vi.fn(),
  startAppBlock: vi.fn(),
  stopAppBlock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  Badge: ({ children, variant }: { children: ReactNode; variant?: string }) => (
    <span data-variant={variant}>{children}</span>
  ),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  client: lifeOpsClient,
  useApp: () => ({
    t: (_key: string) => _key,
  }),
}));

import { AppBlockerSettingsCard } from "./AppBlockerSettingsCard.js";
import { WebsiteBlockerSettingsCard } from "./WebsiteBlockerSettingsCard.js";

describe("blocker settings cards", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lifeOpsClient.checkAppBlockerPermissions.mockResolvedValue({
      status: "granted",
    });
    lifeOpsClient.getAppBlockerStatus.mockResolvedValue({
      active: false,
      blockedCount: 0,
      endsAt: null,
      platform: "android",
    });
    lifeOpsClient.getInstalledAppsToBlock.mockResolvedValue({
      apps: [
        {
          displayName: "Arc",
          packageName: "company.arc",
        },
      ],
    });
  });

  it("renders app blocking as a compact mobile-only surface off mobile", () => {
    render(<AppBlockerSettingsCard mode="desktop" />);

    expect(screen.getByText("App Blocking")).toBeTruthy();
    expect(screen.getByText("Mobile only")).toBeTruthy();
    expect(
      screen.getByText(
        "Open on iPhone or Android to choose apps and start a focus shield.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/App blocking is a mobile feature/i)).toBeNull();
  });

  it("loads Android app blocker controls with icon-led status and actions", async () => {
    render(<AppBlockerSettingsCard mode="mobile" />);

    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText("ANDROID")).toBeTruthy();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();
    expect(screen.getByText("0 apps")).toBeTruthy();
    expect(await screen.findByText("Arc")).toBeTruthy();
  });

  it("starts an Android block from the selected app list", async () => {
    lifeOpsClient.startAppBlock.mockResolvedValue({ success: true });

    render(<AppBlockerSettingsCard mode="mobile" />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Arc/ }));
    fireEvent.click(screen.getByText("Start Block"));

    await waitFor(() => {
      expect(lifeOpsClient.startAppBlock).toHaveBeenCalledWith({
        durationMinutes: 30,
        packageNames: ["company.arc"],
      });
    });
  });

  it("renders website blocking as a compact desktop-only surface off desktop", () => {
    render(<WebsiteBlockerSettingsCard mode="mobile" />);

    expect(screen.getByText("Website Blocking")).toBeTruthy();
    expect(screen.getByText("Desktop only")).toBeTruthy();
    expect(
      screen.getByText("Install the desktop build to manage blocked sites."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/system hosts file is a desktop feature/i),
    ).toBeNull();
  });

  it("renders desktop website blocker status with a platform badge and settings action", () => {
    const onOpenPermissionSettings = vi.fn();

    render(
      <WebsiteBlockerSettingsCard
        mode="desktop"
        permission={{
          canRequest: false,
          reason: "Needs admin access",
          status: "denied",
        }}
        platform="darwin"
        onOpenPermissionSettings={onOpenPermissionSettings}
      />,
    );

    expect(screen.getByText("Needs Admin")).toBeTruthy();
    expect(screen.getByText("darwin")).toBeTruthy();
    expect(screen.getByText("Needs admin access")).toBeTruthy();

    fireEvent.click(screen.getByText("Open Hosts File"));
    expect(onOpenPermissionSettings).toHaveBeenCalledTimes(1);
  });
});
