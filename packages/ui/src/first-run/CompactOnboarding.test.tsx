// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstRunController } from "./use-first-run-controller";

const controllerMock = vi.hoisted(() => ({
  current: null as FirstRunController | null,
}));

vi.mock("./use-first-run-controller", () => ({
  useFirstRunController: () => {
    if (!controllerMock.current) {
      throw new Error("First-run controller test double missing.");
    }
    return controllerMock.current;
  },
}));

import { CompactOnboarding } from "./CompactOnboarding";

function controller(
  overrides: Partial<FirstRunController> = {},
): FirstRunController {
  return {
    step: "runtime",
    draft: {
      agentName: "Eliza",
      runtime: "cloud",
      localInference: "all-local",
      remoteApiBase: "",
      remoteToken: "",
    },
    localRuntimeAvailable: false,
    cloudOnly: true,
    elizaCloudConnected: false,
    submitting: false,
    busyText: null,
    error: null,
    cloudError: null,
    voice: {
      supported: false,
      listening: false,
      speaking: false,
      transcript: "",
      error: null,
    },
    microphone: {
      status: "unknown",
      canRequest: true,
      requesting: false,
      request: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
    },
    primaryLabel: "Continue",
    canBack: false,
    updateDraft: vi.fn(),
    setStep: vi.fn(),
    goBack: vi.fn(),
    finishRuntime: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    toggleVoice: vi.fn(async () => {}),
    onPromptReady: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  controllerMock.current = null;
});

describe("CompactOnboarding", () => {
  it("renders the minimalist cloud-only entry surface", () => {
    controllerMock.current = controller();

    render(<CompactOnboarding />);

    expect(screen.getByRole("button", { name: "Tap to speak" })).toBeTruthy();
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect.className).toContain("bg-transparent");
    expect(connect.className).toContain("border");
    expect(connect.className).toContain("rounded-[2px]");
    expect(screen.queryByText("Set up your agent")).toBeNull();
    expect(screen.queryByText("Connect to cloud.")).toBeNull();
    expect(screen.queryByText("Use Local")).toBeNull();
  });

  it("shows cloud login errors without replacing the orange background", () => {
    controllerMock.current = controller({
      cloudError: "Eliza Cloud login timed out. Please try again.",
    });

    render(<CompactOnboarding />);

    expect(screen.getByTestId("onboarding-toast").textContent).toContain(
      "Eliza Cloud login timed out. Please try again.",
    );
    expect(document.querySelector(".first-run-screen")).toBeTruthy();
  });

  it("disables actions while cloud login is pending", () => {
    controllerMock.current = controller({ submitting: true });

    render(<CompactOnboarding />);

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Tap to speak" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Connect" })
        .disabled,
    ).toBe(true);
  });

  it("connects to cloud from the single Connect action", async () => {
    const updateDraft = vi.fn();
    const finishRuntime = vi.fn(async () => {});
    controllerMock.current = controller({ updateDraft, finishRuntime });

    render(<CompactOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(finishRuntime).toHaveBeenCalledTimes(1);
    });
    expect(updateDraft).toHaveBeenCalledWith("runtime", "cloud");
  });
});
