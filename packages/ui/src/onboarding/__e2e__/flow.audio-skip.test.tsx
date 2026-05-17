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

describe("onboarding flow — audio skip", () => {
  it("clicking 'skip voice input' on the mic state advances to profile-name", async () => {
    render(
      <OnboardingRoot
        cloudProvisioningProgress={{
          status: "running",
          meta: "ready",
          ready: true,
        }}
      />,
    );

    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^continue$/i);
    await expectState("cloud-login");
    clickButton(/continue with google/i);
    await expectState("cloud-chat");
    clickButton(/enter chat/i);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await expectState("profile-name");
  });

  it("clicking the main Continue button on the mic state also advances to profile-name", async () => {
    render(
      <OnboardingRoot
        cloudProvisioningProgress={{
          status: "running",
          meta: "ready",
          ready: true,
        }}
      />,
    );

    await expectState("hello");
    clickButton(/tap to begin/i);
    await expectState("setup");
    clickButton(/^continue$/i);
    await expectState("cloud-login");
    clickButton(/continue with google/i);
    await expectState("cloud-chat");
    clickButton(/enter chat/i);

    await expectState("mic");
    clickButton(/^continue$/i);
    await expectState("profile-name");
  });
});
