/**
 * Verifies the cloud Advanced section waits for Cache Storage deletion and
 * reports incomplete or rejected deletion as a visible failure in jsdom.
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

const { setActionNotice } = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
}));

vi.mock("../../../../state", () => ({
  setDeveloperMode: vi.fn(),
  setPreviewMode: vi.fn(),
  useAppSelectorShallow: (selector: (state: unknown) => unknown) =>
    selector({ setActionNotice }),
  useIsDeveloperMode: () => false,
  useIsPreviewMode: () => false,
}));

vi.mock("../nuphy-settings-primitives", () => ({
  NuphyActionButton: ({
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
  NuphySwitchRow: () => null,
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
    const keys = vi.fn(async () => ["assets"]);
    const deleteCache = vi.fn(() => pendingDelete);
    vi.stubGlobal("caches", { keys, delete: deleteCache });

    render(<AdvancedSection />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));

    await waitFor(() => expect(deleteCache).toHaveBeenCalledWith("assets"));
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
      keys: vi.fn(async () => ["assets"]),
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
});
