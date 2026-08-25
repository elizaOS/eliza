/**
 * Verifies the cloud Advanced section waits for Cache Storage deletion,
 * reports incomplete or rejected deletion as a visible failure, and scopes
 * both reset and cache clearing to elizaOS-owned keys so unrelated
 * same-origin state survives. Runs in jsdom.
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setActionNotice, handleCloudSignOut } = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
  handleCloudSignOut: vi.fn(async () => {}),
}));

vi.mock("../../../../state", () => ({
  setDeveloperMode: vi.fn(),
  setPreviewMode: vi.fn(),
  useAppSelectorShallow: (selector: (state: unknown) => unknown) =>
    selector({ setActionNotice, handleCloudSignOut }),
  useIsDeveloperMode: () => false,
  useIsPreviewMode: () => false,
}));

vi.mock("../cloud-settings-primitives", () => ({
  CloudActionButton: ({
    buttonLabel,
    onActivate,
  }: {
    buttonLabel: ReactNode;
    onActivate: () => void;
  }) => (
    <button type="button" onClick={onActivate}>
      {buttonLabel}
    </button>
  ),
  CloudSwitchRow: () => null,
  SettingsGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SettingsStack: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { AdvancedSection } from "./AdvancedSection";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cloud AdvancedSection cache clearing", () => {
  beforeEach(() => {
    setActionNotice.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("reports success only after every cache deletion completes", async () => {
    let finishDelete: ((value: boolean) => void) | undefined;
    const pendingDelete = new Promise<boolean>((resolve) => {
      finishDelete = resolve;
    });
    const keys = vi.fn(async () => ["eliza:assets"]);
    const deleteCache = vi.fn(() => pendingDelete);
    vi.stubGlobal("caches", { keys, delete: deleteCache });

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    await waitFor(() =>
      expect(deleteCache).toHaveBeenCalledWith("eliza:assets"),
    );
    expect(setActionNotice).not.toHaveBeenCalled();
    finishDelete?.(true);

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Cache cleared.",
        "success",
        4000,
      ),
    );
  });

  it.each([
    ["rejected deletion", () => Promise.reject(new Error("storage failure"))],
    ["incomplete deletion", () => Promise.resolve(false)],
  ])("reports failure for %s", async (_label, deleteResult) => {
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["eliza:assets"]),
      delete: vi.fn(deleteResult),
    });

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Could not clear cache.",
        "error",
        4000,
      ),
    );
    expect(setActionNotice).not.toHaveBeenCalledWith(
      "Cache cleared.",
      "success",
      4000,
    );
  });

  it("leaves caches that are not elizaOS-owned untouched", async () => {
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => [
        "eliza:assets",
        "elizaos-runtime",
        "workbox-precache-v2",
        "external-app",
      ]),
      delete: deleteCache,
    });

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Cache cleared.",
        "success",
        4000,
      ),
    );
    expect(deleteCache).toHaveBeenCalledWith("eliza:assets");
    expect(deleteCache).toHaveBeenCalledWith("elizaos-runtime");
    expect(deleteCache).not.toHaveBeenCalledWith("workbox-precache-v2");
    expect(deleteCache).not.toHaveBeenCalledWith("external-app");
  });
});

describe("cloud AdvancedSection app-state reset scoping", () => {
  beforeEach(() => {
    setActionNotice.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("removes only elizaOS-owned Web Storage keys on reset", async () => {
    window.localStorage.setItem("eliza:ui-theme", "dark");
    window.localStorage.setItem("elizaos_api_base", "https://api.eliza.app");
    window.localStorage.setItem("steward_session_token", "tok");
    window.localStorage.setItem("errorLogging", "1");
    window.localStorage.setItem("unrelated-app-auth", "keep-me");
    window.sessionStorage.setItem("eliza:setup:step", "2");
    window.sessionStorage.setItem("other-origin-tenant", "keep-me-too");

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reset app state" }));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "App state reset. Reload to finish.",
        "success",
        5000,
      ),
    );
    expect(window.localStorage.getItem("eliza:ui-theme")).toBeNull();
    expect(window.localStorage.getItem("elizaos_api_base")).toBeNull();
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
    expect(window.localStorage.getItem("errorLogging")).toBeNull();
    expect(window.localStorage.getItem("unrelated-app-auth")).toBe("keep-me");
    expect(window.sessionStorage.getItem("eliza:setup:step")).toBeNull();
    expect(window.sessionStorage.getItem("other-origin-tenant")).toBe(
      "keep-me-too",
    );
  });
});

describe("cloud AdvancedSection sign-out", () => {
  beforeEach(() => {
    setActionNotice.mockClear();
    handleCloudSignOut.mockClear();
    handleCloudSignOut.mockImplementation(async () => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("calls the real sign-out boundary before reporting success", async () => {
    let resolveSignOut: (() => void) | undefined;
    handleCloudSignOut.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve;
        }),
    );

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Cloud" }));

    await waitFor(() => expect(handleCloudSignOut).toHaveBeenCalledTimes(1));
    expect(setActionNotice).not.toHaveBeenCalled();
    resolveSignOut?.();

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Signed out of Eliza Cloud.",
        "success",
        5000,
      ),
    );
  });

  it("reports failure and never announces success when sign-out rejects", async () => {
    handleCloudSignOut.mockImplementation(async () => {
      throw new Error("network down");
    });

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Cloud" }));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Could not sign out of Eliza Cloud.",
        "error",
        5000,
      ),
    );
    expect(setActionNotice).not.toHaveBeenCalledWith(
      "Signed out of Eliza Cloud.",
      "success",
      5000,
    );
  });

  it("does not sign out when the confirmation is declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out of Cloud" }));

    expect(handleCloudSignOut).not.toHaveBeenCalled();
    expect(setActionNotice).not.toHaveBeenCalled();
  });
});
