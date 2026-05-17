// @vitest-environment jsdom
//
// Smoke guard: every per-state onboarding component must mount with minimal
// props without throwing. Not snapshot files — just a render-pass assertion.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StateCloudChat } from "../StateCloudChat";
import { StateCloudLogin } from "../StateCloudLogin";
import { StateDeviceMode } from "../StateDeviceMode";
import { StateDeviceSecurity } from "../StateDeviceSecurity";
import { StateHello } from "../StateHello";
import { StateLocalDownload } from "../StateLocalDownload";
import { StateMic } from "../StateMic";
import { StateProfileLocation } from "../StateProfileLocation";
import { StateProfileName } from "../StateProfileName";
import { StateRemotePair } from "../StateRemotePair";
import { StateSetup } from "../StateSetup";
import { StateTutorialConnectors } from "../StateTutorialConnectors";
import { StateTutorialPermissions } from "../StateTutorialPermissions";
import { StateTutorialSettings } from "../StateTutorialSettings";
import { StateTutorialSubscriptions } from "../StateTutorialSubscriptions";
import { StateTutorialViews } from "../StateTutorialViews";

const noop = (): void => undefined;

afterEach(() => {
  cleanup();
});

describe("onboarding state components — render smoke", () => {
  it("StateHello mounts", () => {
    expect(() => render(<StateHello onBegin={noop} />)).not.toThrow();
  });

  it("StateSetup mounts", () => {
    expect(() =>
      render(
        <StateSetup
          deviceProfile="ios"
          runtime={undefined}
          language="en-US"
          onLanguageChange={noop}
          onChooseRuntime={noop}
          onContinue={noop}
          onChooseRemote={noop}
        />,
      ),
    ).not.toThrow();
  });

  it("StateCloudLogin mounts", () => {
    expect(() =>
      render(<StateCloudLogin onConnect={noop} onBack={noop} />),
    ).not.toThrow();
  });

  it("StateCloudChat mounts with no progress prop", () => {
    expect(() => render(<StateCloudChat onEnterChat={noop} />)).not.toThrow();
  });

  it("StateCloudChat mounts with running progress", () => {
    expect(() =>
      render(
        <StateCloudChat
          onEnterChat={noop}
          progress={{
            status: "running",
            meta: "Hetzner ready",
            ready: true,
          }}
        />,
      ),
    ).not.toThrow();
  });

  it("StateRemotePair mounts", () => {
    expect(() =>
      render(<StateRemotePair onPair={noop} onBack={noop} />),
    ).not.toThrow();
  });

  it("StateDeviceSecurity mounts", () => {
    expect(() =>
      render(
        <StateDeviceSecurity
          sandboxMode={undefined}
          onChoose={noop}
          onContinue={noop}
          onBack={noop}
        />,
      ),
    ).not.toThrow();
  });

  it("StateDeviceMode mounts", () => {
    expect(() =>
      render(
        <StateDeviceMode
          devicePath={undefined}
          onChoose={noop}
          onStartLocalModelDownload={noop}
          onBack={noop}
          onContinue={noop}
        />,
      ),
    ).not.toThrow();
  });

  it("StateLocalDownload mounts with ready external progress", () => {
    expect(() =>
      render(
        <StateLocalDownload
          progress={{ ratio: 1, meta: "ready", ready: true }}
          onUseCloudInstead={noop}
          onContinue={noop}
        />,
      ),
    ).not.toThrow();
  });

  it("StateMic mounts", () => {
    expect(() =>
      render(<StateMic onContinue={noop} onSkip={noop} />),
    ).not.toThrow();
  });

  it("StateProfileName mounts", () => {
    expect(() => render(<StateProfileName onContinue={noop} />)).not.toThrow();
  });

  it("StateProfileLocation mounts", () => {
    expect(() =>
      render(<StateProfileLocation onContinue={noop} />),
    ).not.toThrow();
  });

  it("StateTutorialSettings mounts", () => {
    expect(() =>
      render(
        <StateTutorialSettings onHasSubscriptions={noop} onContinue={noop} />,
      ),
    ).not.toThrow();
  });

  it("StateTutorialSubscriptions mounts", () => {
    expect(() =>
      render(<StateTutorialSubscriptions onContinue={noop} />),
    ).not.toThrow();
  });

  it("StateTutorialViews mounts", () => {
    expect(() =>
      render(<StateTutorialViews onContinue={noop} />),
    ).not.toThrow();
  });

  it("StateTutorialConnectors mounts", () => {
    expect(() =>
      render(<StateTutorialConnectors onContinue={noop} />),
    ).not.toThrow();
  });

  it("StateTutorialPermissions mounts", () => {
    expect(() =>
      render(<StateTutorialPermissions onFinish={noop} />),
    ).not.toThrow();
  });
});
