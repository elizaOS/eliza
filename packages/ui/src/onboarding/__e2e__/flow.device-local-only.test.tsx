// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

describe("onboarding flow — on-device + local-only", () => {
  it("walks the all-local path through mic, profile, tutorials, into local-download (mock progress complete) and home", async () => {
    const completed: OnboardingFlowState[] = [];
    const startLocalDownload = vi.fn();

    render(
      <OnboardingRoot
        onComplete={(state) => completed.push(state)}
        onStartLocalModelDownload={startLocalDownload}
        localDownloadProgress={{
          ratio: 1,
          meta: "Model ready",
          ready: true,
        }}
      />,
    );

    await expectState("hello");
    clickButton(/tap to begin/i);

    await expectState("setup");
    clickButton(/^on-device/i);
    clickButton(/^continue$/i);

    await expectState("device-security");
    clickButton(/^sandbox/i);
    clickButton(/^continue$/i);

    await expectState("device-mode");
    clickButton(/all local/i);
    expect(startLocalDownload).toHaveBeenCalledTimes(1);
    clickButton(/^continue$/i);

    await expectState("mic");
    clickButton(/skip voice input/i);

    await expectState("profile-name");
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "Linus" },
    });
    clickButton(/^continue$/i);

    await expectState("profile-location");
    fireEvent.change(screen.getByPlaceholderText(/city, region, or country/i), {
      target: { value: "Helsinki" },
    });
    clickButton(/^continue$/i);

    await expectState("tutorial-settings");
    clickButton(/^continue$/i);
    await expectState("tutorial-views");
    clickButton(/^continue$/i);
    await expectState("tutorial-connectors");
    clickButton(/^continue$/i);
    await expectState("tutorial-permissions");
    clickButton(/finish/i);

    // local-only routes into local-download once the tutorials finish and
    // localDownloadReady has not been latched yet on the state machine.
    await expectState("local-download");
    expect(screen.getByText(/Model ready/i)).toBeTruthy();
    clickButton(/^continue$/i);

    await expectState("home");
    expect(completed).toHaveLength(1);
    const final = completed[0];
    expect(final?.runtime).toBe("device");
    expect(final?.sandboxMode).toBe("sandbox");
    expect(final?.devicePath).toBe("local-only");
    expect(final?.localDownloadStarted).toBe(true);
    expect(final?.localDownloadReady).toBe(true);
    expect(final?.name).toBe("Linus");
    expect(final?.location).toBe("Helsinki");
  });
});
