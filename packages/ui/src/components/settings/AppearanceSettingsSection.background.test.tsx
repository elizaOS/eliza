// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";

vi.mock("../pages/background-image", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../pages/background-image")>();
  return {
    ...actual,
    fileToBackgroundDataUrl: vi.fn(async () => "data:image/jpeg;base64,ZZZ"),
  };
});

function seed(opts: { setBackgroundConfig?: (config: unknown) => void } = {}) {
  __setAppValueForTests({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    uiLanguage: "en",
    setUiLanguage: vi.fn(),
    uiThemeMode: "system",
    setUiThemeMode: vi.fn(),
    backgroundConfig: { mode: "shader", color: "#ef5a1f" },
    setBackgroundConfig: opts.setBackgroundConfig ?? vi.fn(),
    undoBackgroundConfig: vi.fn(),
    canUndoBackground: false,
    elizaCloudConnected: false,
    elizaCloudAuthRejected: false,
    activePackId: null,
    selectedVrmIndex: 0,
    customVrmUrl: "",
    customVrmPreviewUrl: "",
    customBackgroundUrl: "",
    customWorldUrl: "",
    firstRunName: "",
    firstRunStyle: "",
    setState: vi.fn(),
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("AppearanceSettingsSection background controls", () => {
  it("consolidates the unified background controls into Appearance settings", () => {
    const setBackgroundConfig = vi.fn();
    seed({ setBackgroundConfig });

    render(<AppearanceSettingsSection />);

    expect(screen.getByTestId("background-settings-controls")).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Set background to Blue"));
    expect(setBackgroundConfig).toHaveBeenCalledWith({
      mode: "shader",
      color: "#2563eb",
    });
  });
});
