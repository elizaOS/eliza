/**
 * Verifies the routing controls keep working when supplemental hardware-tier
 * classification rejects, without leaking an unhandled mount-time promise.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getLocalInferenceDeviceTier: vi.fn(),
  getLocalInferenceRouting: vi.fn(),
}));

vi.mock("../../api", () => ({ client: clientMock }));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ agentProps: {}, ref: { current: null } }),
}));
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));
vi.mock("../../hooks/useRenderGuard", () => ({
  useRenderGuard: () => undefined,
}));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));
vi.mock("../ui/settings-controls", () => ({
  SettingsSelectTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

import { RoutingMatrix } from "./RoutingMatrix";

describe("RoutingMatrix hardware-tier failure", () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
    clientMock.getLocalInferenceRouting.mockResolvedValue({
      registrations: [],
      preferences: { policy: {}, preferredProvider: {} },
    });
    clientMock.getLocalInferenceDeviceTier.mockRejectedValue(
      new Error("malformed hardware probe"),
    );
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    cleanup();
    vi.clearAllMocks();
  });

  it("shows loading, reports unavailable hardware, and recovers on retry", async () => {
    const initialRead = Promise.withResolvers<never>();
    clientMock.getLocalInferenceDeviceTier.mockReturnValueOnce(
      initialRead.promise,
    );
    await act(async () => {
      render(<RoutingMatrix />);
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Model routing" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Checking device hardware",
    );
    await act(async () =>
      initialRead.reject(new Error("malformed hardware probe")),
    );
    await waitFor(() =>
      expect(clientMock.getLocalInferenceDeviceTier).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/Auto: /)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Hardware details are unavailable",
    );
    clientMock.getLocalInferenceDeviceTier.mockResolvedValue({
      tier: "GOOD",
      reason: "Device supports local inference",
      cpuOnly: false,
      mobile: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getAllByText(/Auto: on-device/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(unhandled).toEqual([]);
  });
});
