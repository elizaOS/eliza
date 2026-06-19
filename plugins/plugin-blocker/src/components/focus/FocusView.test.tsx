// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelfControlStatus } from "../../services/website-blocker/index.js";

// `@elizaos/ui` is the giant renderer barrel; the component only touches
// `client.getBaseUrl()` / `client.stopWebsiteBlock()` on its default fetcher
// seam, which every test overrides. `@elizaos/ui/agent-surface` is mocked to an
// inert hook so the agent-instrumented buttons render outside a provider.
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    stopWebsiteBlock: vi.fn(async () => ({ success: true, removed: true })),
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import {
  type FocusActiveSession,
  type FocusScheduleEntry,
  FocusView,
} from "./FocusView.js";

// ---------------------------------------------------------------------------
// SelfControlStatus fixtures — one per state branch.
// ---------------------------------------------------------------------------

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
  available: true,
  active: false,
  canUnblockEarly: false,
  requiresElevation: true,
  elevationPromptMethod: "pkexec",
  reason:
    "Eliza needs administrator/root access to edit the system hosts file.",
});

const EMPTY_STATUS = baseStatus({ available: true, active: false });

const ACTIVE_STATUS = baseStatus({
  available: true,
  active: true,
  startedAt: "2026-06-17T10:00:00.000Z",
  endsAt: "2026-06-17T12:00:00.000Z",
  blockedWebsites: ["x.com", "reddit.com", "news.google.com"],
  requestedWebsites: ["x.com", "reddit.com"],
  matchMode: "subdomain",
  canUnblockEarly: true,
  requiresElevation: false,
});

describe("FocusView (fetch-driven)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the loading state while the initial fetch is in flight", () => {
    // A fetcher that never resolves keeps the view in `loading`.
    render(
      <FocusView
        fetchStatus={() => new Promise<SelfControlStatus>(() => {})}
      />,
    );

    expect(screen.getByTestId("focus-loading")).toBeTruthy();
    expect(screen.getByText(/Loading focus status/i)).toBeTruthy();
    // Header refresh control is always present.
    expect(
      screen.getByRole("button", { name: "Refresh focus status" }),
    ).toBeTruthy();
  });

  it("renders the error state and refetches when Retry is clicked", async () => {
    let attempt = 0;
    const fetchStatus = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("network down");
      }
      return EMPTY_STATUS;
    });

    render(<FocusView fetchStatus={fetchStatus} />);

    const error = await screen.findByTestId("focus-error");
    expect(within(error).getByText("network down")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    // Second attempt resolves to the empty state.
    expect(await screen.findByTestId("focus-empty")).toBeTruthy();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("renders the unavailable (disconnected) state with platform + reason", async () => {
    render(<FocusView fetchStatus={async () => UNAVAILABLE_STATUS} />);

    const unavailable = await screen.findByTestId("focus-unavailable");
    expect(
      within(unavailable).getByText(/Focus blocking is unavailable/i),
    ).toBeTruthy();
    expect(within(unavailable).getByText(/linux/)).toBeTruthy();
    expect(
      within(unavailable).getByText(
        "Could not find the system hosts file on this machine.",
      ),
    ).toBeTruthy();
  });

  it("renders the permission-needed state mentioning the elevation method", async () => {
    render(<FocusView fetchStatus={async () => PERMISSION_STATUS} />);

    const permission = await screen.findByTestId("focus-permission");
    expect(within(permission).getByText(/Permission needed/i)).toBeTruthy();
    expect(within(permission).getByText(/pkexec/)).toBeTruthy();
    expect(
      within(permission).getByText(/Ask the assistant to .enable website/i),
    ).toBeTruthy();
  });

  it("renders the empty state when available, inactive, nothing blocked", async () => {
    render(<FocusView fetchStatus={async () => EMPTY_STATUS} />);

    const empty = await screen.findByTestId("focus-empty");
    expect(within(empty).getByText("No active focus session.")).toBeTruthy();
  });

  it("renders the active state with times, count, list, match mode, and Release", async () => {
    render(<FocusView fetchStatus={async () => ACTIVE_STATUS} />);

    const active = await screen.findByTestId("focus-active");
    expect(within(active).getByText(/Focus session active/i)).toBeTruthy();
    expect(within(active).getByText(/3 websites blocked/i)).toBeTruthy();
    expect(within(active).getByText(/Match mode: subdomain/i)).toBeTruthy();

    const list = within(active).getByRole("list", { name: "Blocked websites" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("x.com")).toBeTruthy();
    expect(within(list).getByText("news.google.com")).toBeTruthy();

    expect(
      within(active).getByRole("button", { name: "Release focus block" }),
    ).toBeTruthy();
  });

  it("hides the Release button when the block cannot be unblocked early", async () => {
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

    const active = await screen.findByTestId("focus-active");
    expect(
      within(active).queryByRole("button", { name: "Release focus block" }),
    ).toBeNull();
    expect(
      within(active).getByText(/Releasing this block needs administrator/i),
    ).toBeTruthy();
  });

  it("calls releaseBlock then refetches when Release is activated", async () => {
    let active = true;
    const fetchStatus = vi.fn(async () =>
      active ? ACTIVE_STATUS : EMPTY_STATUS,
    );
    const releaseBlock = vi.fn(async () => {
      active = false;
    });

    render(<FocusView fetchStatus={fetchStatus} releaseBlock={releaseBlock} />);

    const releaseButton = await screen.findByRole("button", {
      name: "Release focus block",
    });
    fireEvent.click(releaseButton);

    await waitFor(() => expect(releaseBlock).toHaveBeenCalledTimes(1));
    // After release the refetch returns the empty state.
    expect(await screen.findByTestId("focus-empty")).toBeTruthy();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("refetches when the header Refresh control is clicked", async () => {
    const fetchStatus = vi.fn(async () => EMPTY_STATUS);
    render(<FocusView fetchStatus={fetchStatus} />);

    await screen.findByTestId("focus-empty");
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh focus status" }),
    );
    await waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// Back-compat: explicit schedule / activeSession props bypass the fetch path.
// These preserve the original prop-driven stub contract.
// ---------------------------------------------------------------------------

describe("FocusView (back-compat overrides)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the override scaffold (header + both empty branches) with no fetch", () => {
    const fetchStatus = vi.fn();
    render(
      <FocusView
        activeSession={null}
        schedule={[]}
        fetchStatus={fetchStatus}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Focus" }),
    ).toBeTruthy();
    expect(screen.getByText("No active focus session.")).toBeTruthy();
    expect(screen.getByText("No scheduled blocks.")).toBeTruthy();
    // Override path must never hit the fetcher.
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("renders a populated active session override with an end time", () => {
    const session: FocusActiveSession = {
      id: "session-1",
      startedAt: "10:00",
      endsAt: "11:30",
      ruleCount: 7,
    };
    render(<FocusView activeSession={session} />);

    expect(screen.getByText("Focus session active")).toBeTruthy();
    const startedLine = screen.getByText(/Started 10:00/);
    expect(startedLine.textContent).toBe("Started 10:00 · ends 11:30");
    expect(screen.getByText("7 rules enforced")).toBeTruthy();
  });

  it("renders a populated schedule override with website + app targets", () => {
    const schedule: ReadonlyArray<FocusScheduleEntry> = [
      {
        id: "entry-web",
        label: "Deep work",
        target: "website",
        startsAt: "09:00",
        endsAt: "17:00",
      },
      {
        id: "entry-app",
        label: "Lunch detox",
        target: "app",
        startsAt: "12:00",
        endsAt: "13:00",
      },
    ];
    render(<FocusView schedule={schedule} />);

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(screen.getByText("website · 09:00 → 17:00")).toBeTruthy();
    expect(screen.getByText("app · 12:00 → 13:00")).toBeTruthy();
  });
});
