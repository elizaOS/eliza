/** Verifies IntelligenceServingSummary states both serving axes through the package's configured test harness. */
// @vitest-environment jsdom
//
// The Intelligence tiles answer only "who computes chat replies?", so before
// this summary a hosted-Cloud agent and a local agent on Cloud models rendered
// identically (#20045 follow-up). These tests lock the two-axis readout: the
// runtime row and the inference row must be able to disagree, and an unsigned
// cloud-proxy must read as local inference rather than Cloud.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IntelligenceServingSummary } from "./IntelligenceServingSummary";
import {
  resolveServingAxes,
  type ServingAxesInput,
} from "./resolveServingAxes";

/** Mirrors i18next: return the default copy with `{{var}}` interpolated. */
const t = (key: string, vars?: Record<string, unknown>) => {
  if (typeof vars?.defaultValue !== "string") return key;
  return vars.defaultValue.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
};

const CLOUD = {
  provider: "elizacloud",
  family: "ELIZAOS_CLOUD",
  endpoint: "api.eliza.app",
} as const;
const CEREBRAS = {
  provider: "cerebras",
  family: "OPENAI",
  endpoint: "api.cerebras.ai",
} as const;

const base: ServingAxesInput = {
  deploymentRuntime: null,
  startupTarget: null,
  firstRunRuntimeTarget: null,
  mobileRuntimeMode: null,
  activeChat: null,
  activeChatResolved: true,
  elizaCloudConnected: false,
  isCloudSelected: false,
  cloudCallsDisabled: false,
};

function renderAxes(overrides: Partial<ServingAxesInput>) {
  return render(
    <IntelligenceServingSummary
      axes={resolveServingAxes({ ...base, ...overrides })}
      t={t}
    />,
  );
}

/** The value shown against each axis, so the two rows can be told apart. */
function runtimeValue(): string | null {
  return screen.getByTestId("serving-runtime-value").textContent;
}

function inferenceValue(): string | null {
  return screen.getByTestId("serving-inference-value").textContent;
}

describe("IntelligenceServingSummary", () => {
  afterEach(cleanup);

  it("names both axes as local when the agent and models run on device", () => {
    renderAxes({ deploymentRuntime: "local" });

    expect(runtimeValue()).toBe("This device");
    expect(inferenceValue()).toBe("This device");
  });

  it("separates a local agent on Cloud models from a hosted agent", () => {
    renderAxes({
      deploymentRuntime: "local",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });

    // The row that used to be indistinguishable from hosted Cloud.
    expect(runtimeValue()).toBe("This device");
    expect(inferenceValue()).toBe("Eliza Cloud");
  });

  it("names Cloud runtime with local inference", () => {
    renderAxes({ deploymentRuntime: "cloud", cloudCallsDisabled: true });

    expect(runtimeValue()).toBe("Eliza Cloud");
    expect(inferenceValue()).toBe("This device");
    expect(
      screen.getByText(
        "The agent process is hosted on Eliza Cloud and stays online when this device sleeps.",
      ),
    ).toBeTruthy();
  });

  it("names both axes as Cloud when the agent and models are hosted", () => {
    renderAxes({
      deploymentRuntime: "cloud",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });

    expect(runtimeValue()).toBe("Eliza Cloud");
    expect(inferenceValue()).toBe("Eliza Cloud");
  });

  it("reports local inference with the sign-in reason when cloud-proxy is unsigned", () => {
    renderAxes({
      deploymentRuntime: "local",
      isCloudSelected: true,
      activeChat: CLOUD,
    });

    expect(inferenceValue()).toBe("This device");
    expect(
      screen.getByText(
        "Eliza Cloud is selected but not signed in, so chat replies are computed locally until you sign in.",
      ),
    ).toBeTruthy();
  });

  it("names a direct external provider rather than claiming this device", () => {
    renderAxes({ deploymentRuntime: "local", activeChat: CEREBRAS });

    expect(runtimeValue()).toBe("This device");
    // The review's P1: this row previously read "This device" for a direct
    // Cerebras/OpenAI/Anthropic route.
    expect(inferenceValue()).toBe("cerebras");
    expect(inferenceValue()).not.toBe("This device");
    expect(
      screen.getByText(/external provider at api\.cerebras\.ai/),
    ).toBeTruthy();
  });

  it("says it is still checking before the server names a provider", () => {
    renderAxes({ deploymentRuntime: "local", activeChatResolved: false });

    expect(inferenceValue()).toBe("Checking…");
    expect(inferenceValue()).not.toBe("This device");
  });

  it("keeps a remote host distinct from Eliza Cloud", () => {
    renderAxes({ deploymentRuntime: "remote" });

    expect(runtimeValue()).toBe("Remote host");
    expect(
      screen.getByText(
        "The agent process runs on a remote host you configured, not on Eliza Cloud.",
      ),
    ).toBeTruthy();
  });
});
