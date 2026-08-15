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

const base: ServingAxesInput = {
  deploymentRuntime: null,
  startupTarget: null,
  firstRunRuntimeTarget: null,
  mobileRuntimeMode: null,
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
    });
    expect(axes.runtime).toBe("local");
    expect(axes.combination).toBe("cloud-inference");
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
