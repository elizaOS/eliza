// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useAppMock = vi.fn();

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api", () => ({
  client: {
    getOnboardingStatus: vi.fn(),
  },
}));

vi.mock("../../events", () => ({
  CONNECT_EVENT: "milady:test-connect",
}));

vi.mock("../../onboarding/mobile-runtime-mode", () => ({
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

vi.mock("../../platform", () => ({
  applyLaunchConnection: vi.fn(
    (args: { apiBase: string; token?: string | null }) => ({
      apiBase: args.apiBase,
      token: args.token ?? null,
    }),
  ),
}));

vi.mock("../../utils", () => ({
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("../onboarding/BootstrapStep", () => ({
  BootstrapStep: () => <div data-testid="bootstrap-step" />,
}));

vi.mock("./PairingView", () => ({
  PairingView: () => <div data-testid="pairing-view">Pairing required</div>,
}));

vi.mock("./RuntimeGate", () => ({
  RuntimeGate: () => <div data-testid="runtime-gate" />,
}));

vi.mock("./StartupFailureView", () => ({
  StartupFailureView: () => <div data-testid="startup-failure" />,
}));

import { StartupShell } from "./StartupShell";

function mockAppForPhase(
  phase: string,
  overrides: Partial<ReturnType<typeof useAppMock>> = {},
) {
  const coordinatorState =
    phase === "onboarding-required"
      ? { phase, serverReachable: true }
      : { phase };
  useAppMock.mockReturnValue({
    startupCoordinator: {
      phase,
      state: coordinatorState,
      dispatch: vi.fn(),
    },
    startupError: null,
    onboardingCloudProvisionedContainer: false,
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    t: (key: string) => key,
    ...overrides,
  });
}

describe("StartupShell auth states", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the pairing gate for auth-blocked startup instead of password sign-in", () => {
    mockAppForPhase("pairing-required");

    render(<StartupShell />);

    expect(screen.getByTestId("pairing-view")).toBeDefined();
    expect(screen.queryByText(/^Sign in$/i)).toBeNull();
    expect(screen.queryByTestId("runtime-gate")).toBeNull();
  });

  it("renders bootstrap for cloud-provisioned auth instead of pairing", () => {
    window.sessionStorage.clear();
    mockAppForPhase("onboarding-required", {
      onboardingCloudProvisionedContainer: true,
    });

    render(<StartupShell />);

    expect(screen.getByTestId("bootstrap-step")).toBeDefined();
    expect(screen.queryByTestId("pairing-view")).toBeNull();
    expect(screen.queryByTestId("runtime-gate")).toBeNull();
  });
});
