/** Verifies the composer's serving-provider chip through the package's configured test harness. */
// @vitest-environment jsdom
//
// The chat surface had no provider indicator at all, so a user mid-conversation
// could not tell whether a reply came from Cloud, an external provider, or the
// on-device model (elizaOS/eliza#20045 U6). These tests lock the two properties
// that make the chip trustworthy: it names the real serving source, and it
// renders nothing rather than guessing before that source is known.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServingProviderChip } from "./ServingProviderChip";

const modelsConfig = vi.hoisted(() => ({
  activeChat: null as {
    provider: string;
    family: string;
    endpoint: string;
  } | null,
  pending: false,
}));

vi.mock("../../../state", () => ({
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      elizaCloudConnected: true,
      t: (key: string, vars?: Record<string, unknown>) =>
        typeof vars?.defaultValue === "string" ? vars.defaultValue : key,
      firstRunRuntimeTarget: "",
      startupCoordinator: { target: "embedded-local" },
    }),
}));
vi.mock("../../../hooks/useRuntimeMode", () => ({
  useRuntimeMode: () => ({
    state: {
      phase: "ready",
      snapshot: { mode: "local", deploymentRuntime: "local" },
    },
  }),
}));
vi.mock("../../../api", () => ({
  client: {
    getModelsConfig: vi.fn(
      () =>
        new Promise((resolve) => {
          if (modelsConfig.pending) return; // never resolves
          resolve({
            targets: { small: {}, large: {}, coding: {} },
            ...(modelsConfig.activeChat
              ? { activeChat: modelsConfig.activeChat }
              : {}),
          });
        }),
    ),
  },
}));

afterEach(() => {
  cleanup();
  modelsConfig.activeChat = null;
  modelsConfig.pending = false;
});

describe("ServingProviderChip", () => {
  it("names Eliza Cloud when Cloud is serving", async () => {
    modelsConfig.activeChat = {
      provider: "elizacloud",
      family: "ELIZAOS_CLOUD",
      endpoint: "api.eliza.app",
    };
    render(<ServingProviderChip />);
    await waitFor(() => {
      expect(screen.getByTestId("serving-provider-chip").textContent).toBe(
        "Eliza Cloud",
      );
    });
  });

  it("names a direct external provider rather than claiming on-device", async () => {
    modelsConfig.activeChat = {
      provider: "cerebras",
      family: "OPENAI",
      endpoint: "api.cerebras.ai",
    };
    render(<ServingProviderChip />);
    await waitFor(() => {
      expect(screen.getByTestId("serving-provider-chip").textContent).toBe(
        "cerebras",
      );
    });
  });

  it("says on device when the local model is serving", async () => {
    modelsConfig.activeChat = null;
    render(<ServingProviderChip />);
    await waitFor(() => {
      expect(screen.getByTestId("serving-provider-chip").textContent).toBe(
        "On device",
      );
    });
  });

  it("renders nothing until the serving source is known", () => {
    modelsConfig.pending = true;
    render(<ServingProviderChip />);
    // A chip that guesses is worse than no chip.
    expect(screen.queryByTestId("serving-provider-chip")).toBeNull();
  });
});
