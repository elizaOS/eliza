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

describe("onboarding flow — on-device + cloud services", () => {
  it("walks hello -> setup -> device-security -> device-mode (local-cloud) -> mic -> home", async () => {
    const completed: OnboardingFlowState[] = [];
    const startCloudProvisioning = vi.fn();
    const startLocalDownload = vi.fn();

    render(
      <OnboardingRoot
        onComplete={(state) => completed.push(state)}
        onStartCloudProvisioning={startCloudProvisioning}
        onStartLocalModelDownload={startLocalDownload}
      />,
    );

    await expectState("hello");
    clickButton(/tap to begin/i);

    await expectState("setup");
    clickButton(/^on-device$/i);
    clickButton(/^continue$/i);

    await expectState("device-security");
    clickButton(/^sandbox$/i);
    clickButton(/^continue$/i);

    await expectState("device-mode");
    clickButton(/local \+ cloud services/i);
    clickButton(/^continue$/i);

    await expectState("mic");
    clickButton(/skip voice input/i);

    await expectState("profile-name");
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "Grace" },
    });
    clickButton(/^continue$/i);

    await expectState("profile-location");
    fireEvent.change(screen.getByPlaceholderText(/city, region, or country/i), {
      target: { value: "Berlin" },
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

    await expectState("home");
    expect(completed).toHaveLength(1);
    const final = completed[0];
    expect(final?.runtime).toBe("device");
    expect(final?.sandboxMode).toBe("sandbox");
    expect(final?.devicePath).toBe("local-cloud");
    expect(final?.localDownloadStarted).toBeUndefined();
    expect(final?.cloudProvisioningStarted).toBeUndefined();
    expect(startLocalDownload).not.toHaveBeenCalled();
    expect(startCloudProvisioning).not.toHaveBeenCalled();
  });
});
