/** Verifies PrivacyPanel vision/trajectory toggles through SettingsSwitchRow. */
// @vitest-environment jsdom
/**
 * Renders PrivacyPanel with a mocked translator and consent store and asserts
 * the two labelled booleans are SettingsSwitchRow switches. jsdom, no backend.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../../cloud-ui", () => ({
  BrandButton: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  BrandCard: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  CornerBrackets: () => null,
}));

const consentMock = vi.hoisted(() => ({
  getTrajectoryLoggingEnabled: vi.fn(() => false),
  getVisionEnabled: vi.fn(() => false),
  setTrajectoryLoggingEnabled: vi.fn(),
  setVisionEnabled: vi.fn(),
}));

vi.mock("../data/audit-client", () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock("../data/consent-store", () => consentMock);
vi.mock("../data/account-deletion-client", () => ({
  submitAccountDeletion: vi.fn(),
  endLocalSessionAfterDeletion: vi.fn(),
}));

import { PrivacyPanel } from "./privacy-panel";

afterEach(() => {
  cleanup();
});

describe("PrivacyPanel", () => {
  it("routes vision and trajectory toggles through SettingsSwitchRow", () => {
    render(<PrivacyPanel />);
    const vision = screen.getByTestId("vision-toggle");
    const trajectory = screen.getByTestId("trajectory-toggle");
    expect(vision.getAttribute("role")).toBe("switch");
    expect(trajectory.getAttribute("role")).toBe("switch");
    expect(vision.getAttribute("data-agent-id")).toBe("cloud-privacy-vision");
    expect(trajectory.getAttribute("data-agent-id")).toBe(
      "cloud-privacy-trajectory",
    );
    expect(screen.getByLabelText("Allow vision / screen capture")).toBe(vision);
    fireEvent.click(vision);
    expect(consentMock.setVisionEnabled).toHaveBeenCalledWith(true);
  });

  it("routes DSR export and delete through labelled SettingsRows", () => {
    render(<PrivacyPanel />);
    expect(screen.getByText("Download my data")).toBeTruthy();
    const del = screen.getByTestId(
      "delete-account-trigger",
    ) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    expect(del.textContent).toContain("Delete account");
    expect(screen.getByText("Export unavailable")).toBeTruthy();
  });
});
