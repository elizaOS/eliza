// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingFlowState } from "../../../onboarding/state-machine";
import { ONBOARDING_STORAGE_KEY } from "../../../onboarding/state-persistence";
import { OnboardingRoot } from "./OnboardingRoot";

function currentState(): string | null {
  return (
    document
      .querySelector("[data-eliza-ob-state]")
      ?.getAttribute("data-eliza-ob-state") ?? null
  );
}

async function expectState(state: string): Promise<void> {
  await waitFor(() => expect(currentState()).toBe(state));
}

function clickButton(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function renderOnboarding(
  onComplete = (_state: OnboardingFlowState) => {},
  extraProps: Partial<ComponentProps<typeof OnboardingRoot>> = {},
): void {
  render(<OnboardingRoot onComplete={onComplete} {...extraProps} />);
}

async function beginSetup(): Promise<void> {
  await expectState("hello");
  clickButton(/tap to begin/i);
  await expectState("setup");
}

async function finishPersonalProfile(): Promise<void> {
  await expectState("profile-name");
  fireEvent.change(screen.getByPlaceholderText(/your name/i), {
    target: { value: "Test User" },
  });
  clickButton(/continue/i);

  await expectState("profile-location");
  fireEvent.change(screen.getByPlaceholderText(/city, region, or country/i), {
    target: { value: "Los Angeles" },
  });
  clickButton(/continue/i);
}

async function finishTutorialWithoutSubscriptions(): Promise<void> {
  await expectState("tutorial-settings");
  clickButton(/continue/i);
  await expectState("tutorial-views");
  clickButton(/continue/i);
  await expectState("tutorial-connectors");
  clickButton(/continue/i);
  await expectState("tutorial-permissions");
  clickButton(/finish/i);
}

async function finishTutorialWithSubscriptions(): Promise<void> {
  await expectState("tutorial-settings");
  clickButton(/i have ai subscriptions/i);
  await expectState("tutorial-subscriptions");
  clickButton(/continue/i);
  await expectState("tutorial-views");
  clickButton(/continue/i);
  await expectState("tutorial-connectors");
  clickButton(/continue/i);
  await expectState("tutorial-permissions");
  clickButton(/finish/i);
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
});

describe("OnboardingRoot clickthrough flows", () => {
  it.each([
    [/continue with google/i, "google"],
    [/continue with discord/i, "discord"],
    [/continue with x/i, "x"],
    [/continue with email/i, "email"],
  ])("completes the cloud login flow through %s", async (providerButton) => {
    const completedStates: OnboardingFlowState[] = [];
    const startCloudProvisioning = vi.fn();
    const pushConversation = vi.fn();
    renderOnboarding((state) => completedStates.push(state), {
      cloudProvisioningProgress: {
        status: "running",
        meta: "Hetzner server ready",
        ready: true,
      },
      onStartCloudProvisioning: startCloudProvisioning,
      onCloudConversationPush: pushConversation,
    });

    await beginSetup();
    clickButton(/continue/i);
    await expectState("cloud-login");
    expect(startCloudProvisioning).toHaveBeenCalledTimes(1);

    clickButton(providerButton);
    await expectState("cloud-chat");
    expect(screen.getByText(/Hetzner server ready/i)).toBeTruthy();
    clickButton(/enter chat/i);
    expect(pushConversation).toHaveBeenCalledTimes(1);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await finishPersonalProfile();
    await finishTutorialWithoutSubscriptions();
    await expectState("home");
    expect(completedStates).toHaveLength(1);
    expect(completedStates[0]?.runtime).toBe("cloud");
    expect(completedStates[0]?.cloudProvisioningStarted).toBe(true);
    expect(completedStates[0]?.cloudConversationPushed).toBe(true);
  });

  it("clicks through the remote pairing flow and the standard tutorial path", async () => {
    const completedStates: OnboardingFlowState[] = [];
    renderOnboarding((state) => completedStates.push(state));

    await beginSetup();
    clickButton(/connect to remote instance/i);
    await expectState("remote-pair");

    fireEvent.change(screen.getByPlaceholderText(/agent url/i), {
      target: { value: "https://agent.example.test" },
    });
    fireEvent.change(screen.getByPlaceholderText(/pairing code/i), {
      target: { value: "123456" },
    });
    clickButton(/pair/i);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await finishPersonalProfile();
    await finishTutorialWithoutSubscriptions();
    await expectState("home");

    expect(completedStates).toHaveLength(1);
    expect(completedStates[0]?.runtime).toBe("remote");
  });

  it("clicks through the on-device local-only flow and subscription tutorial branch", async () => {
    const completedStates: OnboardingFlowState[] = [];
    const startLocalDownload = vi.fn();
    render(
      <OnboardingRoot
        localDownloadProgress={{
          ratio: 1,
          meta: "Model ready",
          ready: true,
        }}
        onStartLocalModelDownload={startLocalDownload}
        onComplete={(state) => completedStates.push(state)}
      />,
    );

    await beginSetup();
    clickButton(/on-device/i);
    clickButton(/continue/i);

    await expectState("device-security");
    clickButton(/^sandbox/i);
    clickButton(/continue/i);

    await expectState("device-mode");
    clickButton(/all local/i);
    expect(startLocalDownload).toHaveBeenCalledTimes(1);
    clickButton(/continue/i);

    await expectState("mic");
    clickButton(/continue/i);
    await finishPersonalProfile();
    await finishTutorialWithSubscriptions();

    await expectState("local-download");
    expect(screen.getByText(/Model ready/i)).toBeTruthy();
    clickButton(/continue/i);
    await expectState("home");

    expect(completedStates).toHaveLength(1);
    expect(completedStates[0]?.runtime).toBe("device");
    expect(completedStates[0]?.sandboxMode).toBe("sandbox");
    expect(completedStates[0]?.devicePath).toBe("local-only");
    expect(completedStates[0]?.localDownloadStarted).toBe(true);
    expect(completedStates[0]?.localDownloadReady).toBe(true);
  });

  it("clicks through the on-device local-cloud branch into cloud chat", async () => {
    const completedStates: OnboardingFlowState[] = [];
    const startCloudProvisioning = vi.fn();
    const startLocalDownload = vi.fn();
    renderOnboarding((state) => completedStates.push(state), {
      onStartCloudProvisioning: startCloudProvisioning,
      onStartLocalModelDownload: startLocalDownload,
    });

    await beginSetup();
    clickButton(/on-device/i);
    clickButton(/continue/i);

    await expectState("device-security");
    clickButton(/no sandbox/i);
    clickButton(/continue/i);

    await expectState("device-mode");
    clickButton(/local \+ cloud services/i);
    clickButton(/continue/i);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await finishPersonalProfile();
    await finishTutorialWithoutSubscriptions();
    await expectState("home");
    expect(completedStates).toHaveLength(1);
    expect(completedStates[0]?.runtime).toBe("device");
    expect(completedStates[0]?.sandboxMode).toBe("unsandboxed");
    expect(completedStates[0]?.devicePath).toBe("local-cloud");
    expect(completedStates[0]?.cloudProvisioningStarted).toBeUndefined();
    expect(completedStates[0]?.localDownloadStarted).toBeUndefined();
    expect(startCloudProvisioning).not.toHaveBeenCalled();
    expect(startLocalDownload).not.toHaveBeenCalled();
  });

  it("can switch from local download to cloud instead", async () => {
    const completedStates: OnboardingFlowState[] = [];
    renderOnboarding((state) => completedStates.push(state));

    await beginSetup();
    clickButton(/on-device/i);
    clickButton(/continue/i);
    await expectState("device-security");
    clickButton(/continue/i);
    await expectState("device-mode");
    clickButton(/all local/i);
    clickButton(/continue/i);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await finishPersonalProfile();
    await finishTutorialWithoutSubscriptions();
    await expectState("local-download");
    clickButton(/use cloud instead/i);
    await expectState("cloud-login");
    clickButton(/continue with google/i);
    await expectState("cloud-chat");
    clickButton(/enter chat/i);

    await expectState("mic");
    clickButton(/skip voice input/i);
    await finishPersonalProfile();
    await finishTutorialWithoutSubscriptions();
    await expectState("home");
    expect(completedStates).toHaveLength(1);
    expect(completedStates[0]?.runtime).toBe("cloud");
  });
});
