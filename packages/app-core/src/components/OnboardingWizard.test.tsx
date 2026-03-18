// @vitest-environment jsdom

import React from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApplyUiTheme, mockUseApp, mockVrmStage } = vi.hoisted(() => ({
  mockApplyUiTheme: vi.fn(),
  mockUseApp: vi.fn(),
  mockVrmStage: vi.fn(() => React.createElement("div", null, "VrmStage")),
}));

vi.mock("@elizaos/app-core/state", () => ({
  applyUiTheme: (theme: "light" | "dark") => mockApplyUiTheme(theme),
  getVrmPreviewUrl: () => "/vrms/previews/eliza-1.png",
  getVrmUrl: () => "/vrms/eliza-1.vrm.gz",
  ONBOARDING_STEPS: [
    {
      id: "identity",
      name: "onboarding.identity.title",
      subtitle: "onboarding.identity.subtitle",
    },
  ],
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/components", () => ({
  LanguageDropdown: () => React.createElement("div", null, "LanguageDropdown"),
}));

vi.mock("@elizaos/app-core/utils", () => ({
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("./companion/VrmStage", () => ({
  VrmStage: (props: unknown) => mockVrmStage(props),
}));

vi.mock("./onboarding/ActivateStep", () => ({
  ActivateStep: () => React.createElement("div", null, "ActivateStep"),
}));

vi.mock("./onboarding/ConnectionStep", () => ({
  ConnectionStep: () => React.createElement("div", null, "ConnectionStep"),
}));

vi.mock("./onboarding/OnboardingPanel", () => ({
  OnboardingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("./onboarding/OnboardingStepNav", () => ({
  OnboardingStepNav: () =>
    React.createElement("div", null, "OnboardingStepNav"),
}));

vi.mock("./onboarding/PermissionsStep", () => ({
  PermissionsStep: () => React.createElement("div", null, "PermissionsStep"),
}));

vi.mock("./onboarding/RpcStep", () => ({
  RpcStep: () => React.createElement("div", null, "RpcStep"),
}));

import { OnboardingWizard } from "./OnboardingWizard";

describe("OnboardingWizard", () => {
  beforeEach(() => {
    mockApplyUiTheme.mockReset();
    mockUseApp.mockReset();
    mockVrmStage.mockClear();
  });

  it("forces light chrome while keeping the onboarding world on the day scene", async () => {
    mockUseApp.mockReturnValue({
      onboardingStep: "identity",
      selectedVrmIndex: 1,
      customVrmUrl: "",
      uiLanguage: "en",
      uiTheme: "dark",
      setState: vi.fn(),
      t: (key: string) => key,
    });

    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(<OnboardingWizard />);
    });

    expect(mockApplyUiTheme).toHaveBeenCalledWith("light");
    expect(mockVrmStage.mock.calls[0]?.[0]).toMatchObject({
      worldUrl: "worlds/companion-day.spz",
      cameraProfile: "companion_close",
      initialCompanionZoomNormalized: 1,
    });

    await act(async () => {
      tree?.unmount();
    });

    expect(mockApplyUiTheme).toHaveBeenLastCalledWith("dark");
  });
});
