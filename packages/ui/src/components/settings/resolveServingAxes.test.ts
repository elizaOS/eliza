/**
 * Pins the runtime × inference matrix so Settings cannot collapse hybrid,
 * unsigned cloud-proxy, or hosted-cloud into a single Cloud/Local bit.
 * Deterministic — no React.
 */
import { describe, expect, it } from "vitest";
import {
  resolveServingAxes,
  type ServingAxesInput,
  servingAxesDescription,
  servingAxesHeadline,
} from "./resolveServingAxes";

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

describe("resolveServingAxes", () => {
  it("marks everything local on an unsigned loopback agent", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "embedded-local",
    });
    expect(axes).toMatchObject({
      runtime: "local",
      inference: "local",
      combination: "all-local",
      inferenceFallback: false,
    });
    expect(servingAxesHeadline(axes)).toBe("Everything is local");
  });

  it("keeps local runtime when cloud-proxy is selected but unsigned", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "embedded-local",
      isCloudSelected: true,
      elizaCloudConnected: false,
      activeChat: CLOUD,
    });
    expect(axes).toMatchObject({
      runtime: "local",
      inference: "local",
      combination: "all-local",
      inferenceFallback: true,
    });
    expect(servingAxesDescription(axes)).toContain("not signed in");
  });

  it("is cloud inference when the local agent uses a signed-in Cloud route", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "embedded-local",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes).toMatchObject({
      runtime: "local",
      inference: "cloud",
      combination: "cloud-inference",
      inferenceFallback: false,
    });
    expect(servingAxesHeadline(axes)).toBe("Cloud inference");
  });

  it("treats mobile cloud-hybrid as local runtime + cloud inference", () => {
    const axes = resolveServingAxes({
      ...base,
      mobileRuntimeMode: "cloud-hybrid",
      firstRunRuntimeTarget: "elizacloud-hybrid",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes).toMatchObject({
      runtime: "local",
      inference: "cloud",
      combination: "cloud-inference",
    });
  });

  it("is cloud runtime when a hosted agent uses local inference", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "cloud-managed",
      cloudCallsDisabled: true,
    });
    expect(axes).toMatchObject({
      runtime: "cloud",
      inference: "local",
      combination: "cloud-runtime",
    });
    expect(servingAxesHeadline(axes)).toBe("Cloud runtime");
  });

  it("is both when a hosted agent uses Cloud inference", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "cloud-managed",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes).toMatchObject({
      runtime: "cloud",
      inference: "cloud",
      combination: "both",
    });
    expect(servingAxesHeadline(axes)).toBe("Cloud runtime and inference");
  });

  it("does not let a stale elizacloud first-run pin override a live local target", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "embedded-local",
      firstRunRuntimeTarget: "elizacloud",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes.runtime).toBe("local");
    expect(axes.combination).toBe("cloud-inference");
  });

  it("classifies a remote backend separately", () => {
    const axes = resolveServingAxes({
      ...base,
      startupTarget: "remote-backend",
    });
    expect(axes.combination).toBe("remote");
    expect(servingAxesHeadline(axes)).toBe("Remote runtime");
  });

  it("prefers the server deploymentRuntime over a stale local startup target", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "cloud",
      startupTarget: "embedded-local",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes.runtime).toBe("cloud");
    expect(axes.combination).toBe("both");
  });

  it("keeps hybrid local when the server also reports a local deployment runtime", () => {
    // buildDeploymentTarget persists elizacloud-hybrid as runtime "local",
    // so the authoritative snapshot must agree with the hybrid rule below it.
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      mobileRuntimeMode: "cloud-hybrid",
      firstRunRuntimeTarget: "elizacloud-hybrid",
      isCloudSelected: true,
      elizaCloudConnected: true,
      activeChat: CLOUD,
    });
    expect(axes.runtime).toBe("local");
    expect(axes.combination).toBe("cloud-inference");
  });

  // Regression cluster for the review on #20124: the first version of this
  // resolver read only account/config booleans, so every non-Eliza-Cloud route
  // reported "This device". Inference must come from the server's activeChat.

  it("names a direct external provider instead of claiming this device", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChat: CEREBRAS,
    });
    expect(axes.inference).toBe("external");
    expect(axes.combination).toBe("external-inference");
    expect(axes.activeChatProvider).toBe("cerebras");
    expect(servingAxesHeadline(axes)).toBe("Inference on cerebras");
    expect(servingAxesDescription(axes)).toContain("cerebras");
    // The exact falsehood the review caught.
    expect(axes.inference).not.toBe("local");
    expect(axes.inferenceFallback).toBe(false);
  });

  it("does not label a direct external provider a Cloud fallback", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChat: CEREBRAS,
      isCloudSelected: true,
      elizaCloudConnected: false,
    });
    expect(axes.inferenceFallback).toBe(false);
    expect(axes.inference).toBe("external");
  });

  it("keeps direct external inference honest when Cloud calls are disabled", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChat: CEREBRAS,
      cloudCallsDisabled: true,
    });
    expect(axes.inference).toBe("external");
    expect(axes.combination).toBe("external-inference");
  });

  it("reports unknown, not local, before the server has answered", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChatResolved: false,
    });
    expect(axes.inference).toBe("unknown");
    expect(axes.combination).toBe("inference-unknown");
    expect(servingAxesHeadline(axes)).toBe("Checking what answers chat");
  });

  it("treats a Cloud-named route with no live account as local fallback", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChat: CLOUD,
      elizaCloudConnected: false,
    });
    expect(axes.inference).toBe("local");
    expect(axes.inferenceFallback).toBe(true);
  });

  it("keeps local-only routing local even when a Cloud route is configured", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "local",
      activeChat: CLOUD,
      elizaCloudConnected: true,
      cloudCallsDisabled: true,
    });
    expect(axes.inference).toBe("local");
    expect(axes.inferenceFallback).toBe(false);
  });

  it("keeps the runtime axis independent of an external inference route", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: "cloud",
      activeChat: CEREBRAS,
    });
    expect(axes.runtime).toBe("cloud");
    expect(axes.inference).toBe("external");
  });

  it("falls back to client pins while the snapshot is unresolved", () => {
    const axes = resolveServingAxes({
      ...base,
      deploymentRuntime: null,
      startupTarget: "cloud-managed",
      cloudCallsDisabled: true,
    });
    expect(axes.runtime).toBe("cloud");
    expect(axes.combination).toBe("cloud-runtime");
  });
});
