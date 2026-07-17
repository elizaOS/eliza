// @vitest-environment jsdom

/**
 * Regression guard for #16242: a fresh, unauthenticated visit to the shared
 * Eliza Cloud web app must issue ZERO protected agent probes before sign-in
 * (each 401s and Chromium logs it as a console error). Two layers are proven
 * against the REAL hooks + gate — not a mock of the gate:
 *
 *   - the pure gate decisions (`protectedAgentProbesEnabled`,
 *     `shouldProbeExistingLocalInstall`) that govern every gated call site, and
 *   - real hook behavior for the protected `GET /api/runtime/mode` and the
 *     `GET /api/commands` + `/api/custom-actions` catalog fetches — asserted by
 *     spying on the actual network functions the hooks call.
 *
 * The gate stays inert off the Cloud origin (localhost/self-hosted/desktop),
 * so probes fire there exactly as before.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/runtime-mode-client", () => ({
  fetchRuntimeModeSnapshot: vi.fn().mockResolvedValue(null),
}));

const { listCommands, listCustomActions, getModelsCatalog } = vi.hoisted(
  () => ({
    listCommands: vi.fn(),
    listCustomActions: vi.fn(),
    getModelsCatalog: vi.fn(),
  }),
);

vi.mock("../api", () => ({
  client: {
    listCommands: (surface?: string) => listCommands(surface),
    listCustomActions: () => listCustomActions(),
    getModelsCatalog: () => getModelsCatalog(),
  },
}));
vi.mock("../config/boot-config-react.hooks", () => ({
  useBootConfig: (): Record<string, never> => ({}),
}));
vi.mock("../hooks/useAvailableViews", () => ({
  useAvailableViews: (): { views: never[] } => ({ views: [] }),
}));
vi.mock("../state", () => ({
  useAppSelectorShallow: <T,>(
    selector: (state: {
      setTab: (tab: string) => void;
      handleChatClear: () => Promise<void>;
    }) => T,
  ): T => selector({ setTab: () => {}, handleChatClear: async () => {} }),
}));

import { fetchRuntimeModeSnapshot } from "../api/runtime-mode-client";
import { useSlashCommandController } from "../chat/useSlashCommandController";
import { shouldProbeExistingLocalInstall } from "../state/first-run-bootstrap";
import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
} from "./useAuthStatus";
import {
  protectedAgentProbesEnabled,
  useProtectedAgentProbesEnabled,
} from "./useProtectedAgentProbesEnabled";
import {
  __resetRuntimeModeCacheForTests,
  useRuntimeMode,
} from "./useRuntimeMode";

const CLOUD_APP_ORIGIN = "https://app.elizacloud.ai";
const runtimeModeMock = vi.mocked(fetchRuntimeModeSnapshot);
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function setLocation(url: string): void {
  const u = new URL(url);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: u.href,
      origin: u.origin,
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      assign: () => {},
      replace: () => {},
      reload: () => {},
      toString: () => u.href,
    },
  });
}

function authenticate(): void {
  __setAuthStatusForTests({
    phase: "authenticated",
    identity: { id: "u-1", displayName: "Owner", kind: "owner" },
    session: { id: "s-1", kind: "browser", expiresAt: null },
    access: {
      mode: "session",
      passwordConfigured: true,
      ownerConfigured: true,
      role: "OWNER",
    },
  });
}

function GateProbe(props: { onValue: (enabled: boolean) => void }): null {
  props.onValue(useProtectedAgentProbesEnabled());
  return null;
}

function RuntimeModeProbe(): null {
  useRuntimeMode();
  return null;
}

function SlashProbe(): null {
  useSlashCommandController();
  return null;
}

beforeEach(() => {
  __resetAuthStatusForTests();
  __resetRuntimeModeCacheForTests();
  runtimeModeMock.mockClear().mockResolvedValue(null);
  listCommands.mockReset().mockResolvedValue([]);
  listCustomActions.mockReset().mockResolvedValue([]);
  getModelsCatalog
    .mockReset()
    .mockResolvedValue({ catalog: { providers: {} } });
  window.localStorage.clear();
});

afterEach(() => {
  // Unmount every probe root before jsdom tears down. The gated hooks fire a
  // catalog fetch whose resolution setStates on a still-mounted root; a test
  // that only awaits the fetch being CALLED returns before that update commits,
  // leaving React work queued on setImmediate. Without this unmount the queued
  // task flushes after the environment is gone and React reads `window` —
  // surfacing as an "unhandled" ReferenceError that fails the whole shard.
  cleanup();
  __resetAuthStatusForTests();
  __resetRuntimeModeCacheForTests();
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
});

describe("protectedAgentProbesEnabled (pure gate — #16242)", () => {
  it("blocks probes only on a bare, unauthenticated Cloud control-plane origin", () => {
    expect(protectedAgentProbesEnabled(false, CLOUD_APP_ORIGIN)).toBe(false);
    expect(protectedAgentProbesEnabled(false, "https://elizacloud.ai")).toBe(
      false,
    );
    // A session flips the gate open even on the Cloud origin.
    expect(protectedAgentProbesEnabled(true, CLOUD_APP_ORIGIN)).toBe(true);
    // Self-hosted / local / desktop origins never require cloud auth.
    expect(protectedAgentProbesEnabled(false, "http://localhost:2138")).toBe(
      true,
    );
    expect(
      protectedAgentProbesEnabled(false, "https://agent.example.com"),
    ).toBe(true);
    expect(protectedAgentProbesEnabled(false, null)).toBe(true);
  });
});

describe("shouldProbeExistingLocalInstall (startup restore — #16242)", () => {
  it("skips the first-run/status + config probe on a Cloud control-plane origin", () => {
    expect(shouldProbeExistingLocalInstall(CLOUD_APP_ORIGIN)).toBe(false);
    expect(shouldProbeExistingLocalInstall("https://elizacloud.ai")).toBe(
      false,
    );
    expect(shouldProbeExistingLocalInstall("http://localhost:2138")).toBe(true);
    expect(shouldProbeExistingLocalInstall("https://agent.example.com")).toBe(
      true,
    );
    expect(shouldProbeExistingLocalInstall(null)).toBe(true);
  });
});

describe("useProtectedAgentProbesEnabled (live hook)", () => {
  it("is false on the unauthenticated Cloud origin and true once authenticated", async () => {
    setLocation(`${CLOUD_APP_ORIGIN}/`);
    const seen: boolean[] = [];
    render(<GateProbe onValue={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBe(false);

    act(() => {
      authenticate();
    });
    await waitFor(() => expect(seen.at(-1)).toBe(true));
  });

  it("is true on a localhost origin regardless of auth", () => {
    setLocation("http://localhost:2138/");
    const seen: boolean[] = [];
    render(<GateProbe onValue={(v) => seen.push(v)} />);
    expect(seen.at(-1)).toBe(true);
  });
});

describe("useRuntimeMode — GET /api/runtime/mode gated (#16242)", () => {
  it("does not probe on the fresh unauthenticated Cloud origin, then probes after sign-in", async () => {
    setLocation(`${CLOUD_APP_ORIGIN}/`);
    render(<RuntimeModeProbe />);
    // Give any (incorrectly ungated) mount effect a chance to fire.
    await Promise.resolve();
    expect(runtimeModeMock).not.toHaveBeenCalled();

    act(() => {
      authenticate();
    });
    await waitFor(() => expect(runtimeModeMock).toHaveBeenCalledTimes(1));
  });

  it("probes on mount on a non-Cloud origin (unchanged behavior)", async () => {
    setLocation("http://localhost:2138/");
    render(<RuntimeModeProbe />);
    await waitFor(() => expect(runtimeModeMock).toHaveBeenCalledTimes(1));
  });
});

describe("useSlashCommandController — command catalog gated (#16242)", () => {
  it("does not fetch commands/custom-actions on the unauthenticated Cloud origin, then fetches after sign-in", async () => {
    setLocation(`${CLOUD_APP_ORIGIN}/`);
    render(<SlashProbe />);
    await Promise.resolve();
    expect(listCommands).not.toHaveBeenCalled();
    expect(listCustomActions).not.toHaveBeenCalled();

    act(() => {
      authenticate();
    });
    await waitFor(() => {
      expect(listCommands).toHaveBeenCalledTimes(1);
      expect(listCustomActions).toHaveBeenCalledTimes(1);
    });
  });

  it("fetches the catalog on mount on a non-Cloud origin (unchanged behavior)", async () => {
    setLocation("http://localhost:2138/");
    render(<SlashProbe />);
    await waitFor(() => {
      expect(listCommands).toHaveBeenCalledWith("gui");
      expect(listCustomActions).toHaveBeenCalledTimes(1);
    });
  });
});
