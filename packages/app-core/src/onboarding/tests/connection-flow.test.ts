import { describe, expect, it } from "vitest";
import {
  applyConnectionTransition,
  deriveConnectionScreen,
  mergeConnectionSnapshot,
  resolveConnectionUiSpec,
  type ConnectionFlowSnapshot,
} from "../connection-flow";

const baseSnapshot: ConnectionFlowSnapshot = {
  onboardingServerTarget: "",
  onboardingProvider: "",
  onboardingRemoteConnected: false,
  onboardingElizaCloudTab: "login",
  onboardingSubscriptionTab: "token",
  forceCloud: false,
  isNative: true,
  cloudOnly: false,
  onboardingDetectedProviders: [],
};

describe("connection-flow", () => {
  it("routes cloud-hybrid hosting into the provider grid", () => {
    const result = applyConnectionTransition(baseSnapshot, {
      type: "selectElizaCloudHybridHosting",
    });

    expect(result).toEqual({
      kind: "patch",
      patch: {
        onboardingServerTarget: "elizacloud-hybrid",
        onboardingProvider: "",
        onboardingApiKey: "",
        onboardingPrimaryModel: "",
      },
    });

    const next =
      result?.kind === "patch"
        ? mergeConnectionSnapshot(baseSnapshot, result.patch)
        : baseSnapshot;
    expect(deriveConnectionScreen(next)).toBe("providerGrid");
  });

  it("keeps native hosting choices to remote, cloud, and cloud-hybrid", () => {
    expect(resolveConnectionUiSpec(baseSnapshot).showHostingLocalCard).toBe(
      false,
    );
  });
});
