// @vitest-environment jsdom

// Drives the unified FocusView (the single GUI/XR data wrapper) through the
// rendered DOM: the same component the bundle exports for both the "gui" and
// "xr" modalities. Asserts each SelfControlStatus phase (loading, error,
// unavailable, permission, active, empty), the clickable Retry / Release
// agent-instrumented controls, the early-release mutation + refetch, and the
// release-gating when a block can't be unblocked early.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelfControlStatus } from "../../services/website-blocker/index.js";

// `@elizaos/ui` is the giant renderer barrel; the wrapper only touches
// `client.getBaseUrl()` / `client.stopWebsiteBlock()` on its default fetcher
// seam, which every test overrides via the injection props.
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    stopWebsiteBlock: vi.fn(async () => ({ success: true, removed: true })),
  },
}));

import { FocusView } from "./FocusView.js";

function baseStatus(
  overrides: Partial<SelfControlStatus> = {},
): SelfControlStatus {
  return {
    available: true,
    active: false,
    hostsFilePath: "/etc/hosts",
    startedAt: null,
    endsAt: null,
    websites: [],
    blockedWebsites: [],
    allowedWebsites: [],
    requestedWebsites: [],
    matchMode: "exact",
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "hosts-file",
    platform: "linux",
    supportsElevationPrompt: true,
    elevationPromptMethod: "pkexec",
    ...overrides,
  };
}

const UNAVAILABLE_STATUS = baseStatus({
  available: false,
  hostsFilePath: null,
  canUnblockEarly: false,
  requiresElevation: false,
  reason: "Could not find the system hosts file on this machine.",
});

const PERMISSION_STATUS = baseStatus({
  canUnblockEarly: false,
  requiresElevation: true,
  elevationPromptMethod: "pkexec",
  reason:
    "Eliza needs administrator/root access to edit the system hosts file.",
});

const EMPTY_STATUS = baseStatus();

const ACTIVE_STATUS = baseStatus({
  active: true,
  startedAt: "2026-06-17T10:00:00.000Z",
  endsAt: "2026-06-17T12:00:00.000Z",
  blockedWebsites: ["x.com", "reddit.com", "news.google.com"],
  matchMode: "subdomain",
  canUnblockEarly: true,
});

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FocusView — phases", () => {
  it("renders the loading state while the initial fetch is in flight", () => {
    render(
      <FocusView
        fetchStatus={() => new Promise<SelfControlStatus>(() => {})}
      />,
    );
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("renders the unavailable state with platform + reason", async () => {
    render(<FocusView fetchStatus={async () => UNAVAILABLE_STATUS} />);
    await screen.findByText(/Focus unavailable/i);
    expect(screen.getByText(/linux/)).toBeTruthy();
    expect(
      screen.getByText(/Could not find the system hosts file/),
    ).toBeTruthy();
  });

  it("renders the permission-needed state mentioning the elevation method", async () => {
    render(<FocusView fetchStatus={async () => PERMISSION_STATUS} />);
    await screen.findByText("Permission");
    expect(screen.getByText(/pkexec/)).toBeTruthy();
  });

  it("renders the empty state when available, inactive, nothing blocked", async () => {
    render(<FocusView fetchStatus={async () => EMPTY_STATUS} />);
    await screen.findByText("No active focus block.");
  });

  it("renders the active state with times, count, list, and Release control", async () => {
    render(<FocusView fetchStatus={async () => ACTIVE_STATUS} />);
    await screen.findByText(/Focus active/i);
    expect(screen.getByText(/Mode: subdomain/i)).toBeTruthy();
    expect(screen.getByText("x.com")).toBeTruthy();
    expect(screen.getByText("news.google.com")).toBeTruthy();
    expect(agent("release")).toBeTruthy();
  });
});

describe("FocusView — actions", () => {
  it("Retry refetches after an error", async () => {
    let attempt = 0;
    const fetchStatus = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return EMPTY_STATUS;
    });
    render(<FocusView fetchStatus={fetchStatus} />);

    await screen.findByText("network down");
    fireEvent.click(agent("retry"));

    await screen.findByText("No active focus block.");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("Release calls releaseBlock then refetches the now-empty state", async () => {
    let active = true;
    const fetchStatus = vi.fn(async () =>
      active ? ACTIVE_STATUS : EMPTY_STATUS,
    );
    const releaseBlock = vi.fn(async () => {
      active = false;
    });
    render(<FocusView fetchStatus={fetchStatus} releaseBlock={releaseBlock} />);

    await screen.findByText(/Focus active/i);
    fireEvent.click(agent("release"));

    await waitFor(() => expect(releaseBlock).toHaveBeenCalledTimes(1));
    await screen.findByText("No active focus block.");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("hides the Release control when the block cannot be unblocked early", async () => {
    render(
      <FocusView
        fetchStatus={async () =>
          baseStatus({
            active: true,
            canUnblockEarly: false,
            requiresElevation: true,
            blockedWebsites: ["x.com"],
          })
        }
      />,
    );
    await screen.findByText(/Focus active/i);
    expect(document.querySelector('[data-agent-id="release"]')).toBeNull();
    expect(screen.getByText(/Admin approval required/i)).toBeTruthy();
  });
});
