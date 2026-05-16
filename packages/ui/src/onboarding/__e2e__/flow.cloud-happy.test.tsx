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

describe("onboarding flow — cloud happy path", () => {
  it("walks hello -> setup -> cloud-login -> cloud-chat -> home", async () => {
    const completed: OnboardingFlowState[] = [];
    const startCloudProvisioning = vi.fn();
    const pushConversation = vi.fn();

    render(
      <OnboardingRoot
        onComplete={(state) => completed.push(state)}
        onStartCloudProvisioning={startCloudProvisioning}
        onCloudConversationPush={pushConversation}
        cloudProvisioningProgress={{
          status: "running",
          meta: "Hetzner online",
          ready: true,
        }}
      />,
    );

    await expectState("hello");
    clickButton(/tap to begin/i);

    await expectState("setup");
    // iOS default profile has Cloud preselected; click Continue.
    clickButton(/^continue$/i);

    await expectState("cloud-login");
    expect(startCloudProvisioning).toHaveBeenCalledTimes(1);
    clickButton(/continue with google/i);

    await expectState("cloud-chat");
    expect(screen.getByText(/Hetzner online/i)).toBeTruthy();
    clickButton(/enter chat/i);
    expect(pushConversation).toHaveBeenCalledTimes(1);

    await expectState("mic");
    clickButton(/skip voice input/i);

    await expectState("profile-name");
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "Ada" },
    });
    clickButton(/^continue$/i);

    await expectState("profile-location");
    fireEvent.change(screen.getByPlaceholderText(/city, region, or country/i), {
      target: { value: "London" },
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
    expect(completed[0]?.runtime).toBe("cloud");
    expect(completed[0]?.cloudProvisioningStarted).toBe(true);
    expect(completed[0]?.cloudConversationPushed).toBe(true);
    expect(completed[0]?.name).toBe("Ada");
    expect(completed[0]?.location).toBe("London");
  });

  it("persists cloudProvisioningStarted across cloud-login back-and-forward", async () => {
    const startCloudProvisioning = vi.fn();
    render(
      <OnboardingRoot
        onStartCloudProvisioning={startCloudProvisioning}
        cloudProvisioningProgress={{
          status: "provisioning",
          meta: "spinning up",
          ready: false,
        }}
      />,
    );
    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^continue$/i);
    await expectState("cloud-login");
    expect(startCloudProvisioning).toHaveBeenCalledTimes(1);
    clickButton(/back/i);
    await expectState("setup");
    clickButton(/^continue$/i);
    await expectState("cloud-login");
    // Second forward should not double-fire provisioning when already started.
    expect(startCloudProvisioning).toHaveBeenCalledTimes(1);
  });
});
