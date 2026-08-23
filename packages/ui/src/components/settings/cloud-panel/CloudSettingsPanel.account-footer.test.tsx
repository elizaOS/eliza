/** Exercises connected-account footer navigation in the real wide and narrow cloud-panel shells with stub section bodies. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  connected: true,
  handleInteractiveCloudLogin: vi.fn(async () => undefined),
  handleCloudSignOut: vi.fn(async () => undefined),
  setActionNotice: vi.fn(),
}));
const mediaState = vi.hoisted(() => ({ wide: true }));
const credentialState = vi.hoisted(() => ({ present: false }));

vi.mock("../../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaState.wide,
}));

vi.mock("../../../state", () => ({
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      elizaCloudConnected: appState.connected,
      handleInteractiveCloudLogin: appState.handleInteractiveCloudLogin,
      handleCloudSignOut: appState.handleCloudSignOut,
      setActionNotice: appState.setActionNotice,
    }),
}));

vi.mock("./cloud-management-auth", () => ({
  useHasCloudManagementCredential: () => credentialState.present,
}));

vi.mock("./cloud-panel-sections", () => {
  const Icon = () => <span aria-hidden="true" />;
  const primarySection = {
    id: "general",
    label: "General",
    subtitle: "Desktop behavior",
    icon: Icon,
    placement: "navigation",
    group: "general",
    order: 0,
    Component: () => <div data-testid="section-general">General section</div>,
  };
  const footerSections = [
    {
      id: "cloud-billing",
      label: "Billing & Credits",
      subtitle: "Plans, credits, and invoices",
      footerLabel: "Manage billing",
    },
    {
      id: "cloud-api-keys",
      label: "API Keys",
      subtitle: "Cloud API credentials",
      footerLabel: "API keys",
    },
    {
      id: "cloud-security",
      label: "Sessions & Privacy",
      subtitle: "Sessions, privacy, and audit",
      footerLabel: "Sessions & privacy",
    },
    {
      id: "cloud-organization",
      label: "Organization",
      subtitle: "Members and organization settings",
      footerLabel: "Organization",
    },
  ].map((section) => ({
    ...section,
    icon: Icon,
    placement: "account-footer",
    Component: () => (
      <div data-testid={`section-${section.id}`}>{section.label} section</div>
    ),
  }));
  const sections = [primarySection, ...footerSections];
  return {
    CLOUD_PANEL_SECTIONS: sections,
    cloudPanelAccountFooterSections: () => footerSections,
    groupedCloudPanelSections: () => ({ general: [primarySection] }),
    resolveCloudPanelSection: (id: string) =>
      sections.some((section) => section.id === id) ? id : "general",
  };
});

import { CloudSettingsPanel } from "./CloudSettingsPanel";

const ACCOUNT_DESTINATIONS = [
  ["Manage billing", "cloud-billing", "Billing & Credits"],
  ["API keys", "cloud-api-keys", "API Keys"],
  ["Sessions & privacy", "cloud-security", "Sessions & Privacy"],
  ["Organization", "cloud-organization", "Organization"],
] as const;

describe("CloudSettingsPanel account footer navigation", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    appState.connected = true;
    mediaState.wide = true;
    credentialState.present = false;
    appState.handleInteractiveCloudLogin.mockReset();
    appState.handleInteractiveCloudLogin.mockResolvedValue(undefined);
    appState.handleCloudSignOut.mockReset();
    appState.handleCloudSignOut.mockResolvedValue(undefined);
    appState.setActionNotice.mockClear();
    window.history.replaceState(null, "", "/settings");
  });

  it.each(ACCOUNT_DESTINATIONS)(
    "opens %s in its mounted canonical section on wide screens",
    (label, sectionId, sectionLabel) => {
      render(<CloudSettingsPanel />);

      const accountButton = screen.getByRole("button", { name: "Connected" });
      expect(accountButton.className).toContain("keyboard-focus-surface");
      expect(accountButton.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(accountButton);
      expect(accountButton.getAttribute("aria-expanded")).toBe("true");
      const link = screen.getByRole("link", { name: label });
      expect(link.className).toContain("keyboard-focus-surface");
      expect(link.getAttribute("href")).toBe(`#${sectionId}`);
      fireEvent.click(link);

      const sectionBody = screen.getByTestId(`section-${sectionId}`);
      expect(sectionBody).toBeTruthy();
      // Sections render directly on the shared Eliza theme — no scoped token
      // wrapper may reappear around an account-footer body.
      expect(sectionBody.closest("[data-cloud-section-theme]")).toBeNull();
      expect(
        screen.getByRole("heading", { level: 1, name: sectionLabel }),
      ).toBeTruthy();
      expect(window.location.hash).toBe(`#${sectionId}`);
      expect(link.getAttribute("aria-current")).toBe("page");
    },
  );

  it.each(ACCOUNT_DESTINATIONS)(
    "opens a direct narrow-screen deep link for %s and returns to the account hub",
    (_label, sectionId, sectionLabel) => {
      mediaState.wide = false;
      window.history.replaceState(null, "", `/settings#${sectionId}`);

      render(<CloudSettingsPanel />);

      expect(screen.getByTestId(`section-${sectionId}`)).toBeTruthy();
      expect(
        screen.getByRole("heading", { level: 1, name: sectionLabel }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Connected" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("button", { name: /General/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Connected" })).toBeTruthy();
    },
  );

  it.each(ACCOUNT_DESTINATIONS)(
    "opens %s from the narrow connected-account menu and returns to the hub",
    (label, sectionId) => {
      mediaState.wide = false;

      render(<CloudSettingsPanel />);

      fireEvent.click(screen.getByRole("button", { name: "Connected" }));
      fireEvent.click(screen.getByRole("link", { name: label }));
      expect(screen.getByTestId(`section-${sectionId}`)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("button", { name: "Connected" })).toBeTruthy();
    },
  );

  it.each([true, false])(
    "keeps account-only destinations hidden while disconnected in the %s layout",
    (wide) => {
      mediaState.wide = wide;
      appState.connected = false;

      render(<CloudSettingsPanel />);

      expect(
        screen.getByRole("button", { name: "Connect Cloud" }),
      ).toBeTruthy();
      for (const [label] of ACCOUNT_DESTINATIONS) {
        expect(screen.queryByRole("link", { name: label })).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Connect Cloud" }));
      expect(appState.handleInteractiveCloudLogin).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Connect Cloud" }).className,
      ).toContain("keyboard-focus-surface");
    },
  );

  it("replaces a disconnected account deep link with General before mounting it", async () => {
    appState.connected = false;
    window.history.replaceState(null, "", "/settings#cloud-security");

    render(<CloudSettingsPanel />);

    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-security")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "General" }),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#general"));
  });

  it("keeps prior account history entries gated after credentials disappear", async () => {
    const view = render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    fireEvent.click(screen.getByRole("link", { name: "Manage billing" }));
    fireEvent.click(screen.getByRole("link", { name: "API keys" }));
    expect(screen.getByTestId("section-cloud-api-keys")).toBeTruthy();

    appState.connected = false;
    view.rerender(<CloudSettingsPanel />);

    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-api-keys")).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe("#general"));

    const backNavigation = new Promise<void>((resolve) => {
      window.addEventListener("hashchange", () => resolve(), { once: true });
    });
    await act(async () => {
      window.history.back();
      await backNavigation;
    });
    await waitFor(() => expect(window.location.hash).toBe("#general"));
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-billing")).toBeNull();
  });

  it("unmounts an account destination when its sole credential disappears", async () => {
    appState.connected = false;
    credentialState.present = true;
    window.history.replaceState(null, "", "/settings#cloud-organization");
    const view = render(<CloudSettingsPanel />);

    expect(screen.getByTestId("section-cloud-organization")).toBeTruthy();

    credentialState.present = false;
    view.rerender(<CloudSettingsPanel />);

    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-organization")).toBeNull();
    await waitFor(() => expect(window.location.hash).toBe("#general"));
  });

  it("returns to General before a pending sign-out settles", async () => {
    let resolveSignOut: (() => void) | undefined;
    appState.handleCloudSignOut.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSignOut = () => resolve(undefined);
        }),
    );
    window.history.replaceState(null, "", "/settings#cloud-security");

    render(<CloudSettingsPanel />);

    expect(screen.getByTestId("section-cloud-security")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    const signOutButton = screen.getByRole("button", { name: "Sign out" });
    expect(signOutButton.className).toContain("keyboard-focus-surface");
    fireEvent.click(signOutButton);

    expect(appState.handleCloudSignOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(window.location.hash).toBe("#general");
    expect(screen.getByRole("status").textContent).toContain("Signing out");
    expect(screen.queryByRole("button", { name: "Connect Cloud" })).toBeNull();

    await act(async () => resolveSignOut?.());
  });

  it("keeps narrow sign-out status and recovery visible in the settings hub", async () => {
    mediaState.wide = false;
    let rejectSignOut: ((reason?: unknown) => void) | undefined;
    appState.handleCloudSignOut.mockImplementationOnce(
      () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectSignOut = reject;
        }),
    );

    render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByRole("status").textContent).toContain("Signing out");
    expect(screen.getByRole("button", { name: /General/ })).toBeTruthy();
    expect(screen.queryByTestId("section-general")).toBeNull();
    expect(window.location.hash).toBe("#general");

    await act(async () => {
      rejectSignOut?.(new Error("credential store unavailable"));
    });

    expect(
      await screen.findByRole("button", { name: "Retry sign out" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Cloud sign-out didn't finish.",
    );
  });

  it("keeps every prior account history entry gated while sign-out is pending", async () => {
    let resolveSignOut: (() => void) | undefined;
    appState.handleCloudSignOut.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSignOut = () => resolve(undefined);
        }),
    );

    render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    fireEvent.click(screen.getByRole("link", { name: "Manage billing" }));
    fireEvent.click(screen.getByRole("link", { name: "API keys" }));
    expect(screen.getByTestId("section-cloud-api-keys")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connected" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Signing out");
    expect(screen.queryByRole("button", { name: "Connect Cloud" })).toBeNull();

    const backNavigation = new Promise<void>((resolve) => {
      window.addEventListener("hashchange", () => resolve(), { once: true });
    });
    await act(async () => {
      window.history.back();
      await backNavigation;
    });

    await waitFor(() => expect(window.location.hash).toBe("#general"));
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-billing")).toBeNull();

    await act(async () => resolveSignOut?.());
  });

  it("keeps account data unmounted when sign-out fails", async () => {
    appState.handleCloudSignOut.mockRejectedValueOnce(
      new Error("credential store unavailable"),
    );
    window.history.replaceState(null, "", "/settings#cloud-security");

    render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(appState.setActionNotice).toHaveBeenCalledWith(
        "Could not sign out of Eliza Cloud.",
        "error",
        5000,
      );
    });
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByTestId("section-cloud-security")).toBeNull();
    expect(window.location.hash).toBe("#general");
    expect(screen.getByRole("alert").textContent).toContain(
      "Cloud sign-out didn't finish.",
    );
    expect(screen.getByRole("button", { name: "Retry sign out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Cloud" })).toBeNull();
  });

  it("offers retry when a resolved sign-out leaves the session observed", async () => {
    appState.handleCloudSignOut.mockResolvedValueOnce(undefined);

    render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("button", { name: "Retry sign out" }),
    ).toBeTruthy();
    expect(screen.getByTestId("section-general")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connected" })).toBeNull();
  });

  it("recovers from a rejected sign-out through retry once the session disappears", async () => {
    let resolveRetry: (() => void) | undefined;
    appState.handleCloudSignOut
      .mockRejectedValueOnce(new Error("credential store unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            resolveRetry = () => resolve(undefined);
          }),
      );
    const view = render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Connected" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry sign out" }),
    );

    expect(appState.handleCloudSignOut).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain("Signing out");
    expect(screen.queryByRole("button", { name: "Connected" })).toBeNull();

    appState.connected = false;
    view.rerender(<CloudSettingsPanel />);
    expect(screen.getByRole("button", { name: "Connect Cloud" })).toBeTruthy();

    await act(async () => resolveRetry?.());
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect Cloud" }),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Retry sign out" })).toBeNull();
    expect(screen.queryByTestId("section-cloud-billing")).toBeNull();
  });
});
