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

beforeEach(() => {
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

describe("onboarding flow — remote pairing", () => {
  it("walks hello -> setup -> remote-pair -> mic -> profile -> tutorials -> home", async () => {
    const completed: OnboardingFlowState[] = [];

    render(<OnboardingRoot onComplete={(state) => completed.push(state)} />);

    await expectState("hello");
    clickButton(/tap to begin/i);

    await expectState("setup");
    clickButton(/connect to remote instance/i);

    await expectState("remote-pair");
    fireEvent.change(screen.getByPlaceholderText(/agent url/i), {
      target: { value: "https://agent.example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText(/pairing code/i), {
      target: { value: "ABC123" },
    });
    clickButton(/^pair$/i);

    await expectState("mic");
    clickButton(/skip voice input/i);

    await expectState("profile-name");
    fireEvent.change(screen.getByPlaceholderText(/your name/i), {
      target: { value: "Remote User" },
    });
    clickButton(/^continue$/i);

    await expectState("profile-location");
    fireEvent.change(screen.getByPlaceholderText(/city, region, or country/i), {
      target: { value: "Anywhere" },
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
    expect(completed[0]?.runtime).toBe("remote");
    expect(completed[0]?.name).toBe("Remote User");
  });
});
