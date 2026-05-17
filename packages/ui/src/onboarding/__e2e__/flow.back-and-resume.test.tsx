// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingRoot } from "../../components/onboarding/states/OnboardingRoot";
import type { OnboardingFlowState } from "../state-machine";
import { ONBOARDING_STORAGE_KEY } from "../state-persistence";

function currentStateAttr(): string | null {
  return (
    document
      .querySelector("[data-eliza-ob-state]")
      ?.getAttribute("data-eliza-ob-state") ?? null
  );
}

async function expectState(state: string): Promise<void> {
  await waitFor(() => expect(currentStateAttr()).toBe(state));
}

function clickButton(name: RegExp | string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function readPersistedState(): OnboardingFlowState | null {
  const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as OnboardingFlowState) : null;
}

beforeEach(() => {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

describe("onboarding flow — back navigation and resume", () => {
  it("Back from device-mode returns to device-security and preserves the sandbox choice", async () => {
    render(<OnboardingRoot />);

    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^on-device/i);
    clickButton(/^continue$/i);

    await expectState("device-security");
    clickButton(/no sandbox/i);
    clickButton(/^continue$/i);

    await expectState("device-mode");
    clickButton(/^back$/i);
    await expectState("device-security");

    const noSandbox = screen.getByRole("button", { name: /no sandbox/i });
    expect(noSandbox.className).toContain("selected");
  });

  it("Back from cloud-login returns to setup with the cloud runtime still selected", async () => {
    render(<OnboardingRoot />);

    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^continue$/i);
    await expectState("cloud-login");
    clickButton(/^back$/i);
    await expectState("setup");

    const cloudBtn = screen.getByRole("button", { name: /^cloud/i });
    expect(cloudBtn.className).toContain("selected");
  });

  it("persists state to localStorage and resumes mid-flow after remount", async () => {
    const { unmount } = render(<OnboardingRoot />);

    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^on-device/i);
    clickButton(/^continue$/i);

    await expectState("device-security");
    clickButton(/^sandbox/i);
    clickButton(/^continue$/i);

    await expectState("device-mode");
    clickButton(/local \+ cloud services/i);

    await waitFor(() => {
      const persisted = readPersistedState();
      expect(persisted?.current).toBe("device-mode");
      expect(persisted?.runtime).toBe("device");
      expect(persisted?.sandboxMode).toBe("sandbox");
      expect(persisted?.devicePath).toBe("local-cloud");
    });

    unmount();

    render(<OnboardingRoot />);
    await expectState("device-mode");
    const localCloud = screen.getByRole("button", {
      name: /local \+ cloud services/i,
    });
    expect(localCloud.className).toContain("selected");
  });
});
