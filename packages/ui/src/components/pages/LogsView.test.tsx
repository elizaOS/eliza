// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../../api";
import { getViewChatBinding } from "../../state/view-chat-binding";
import { LogsView } from "./LogsView";

// LogsView reads all log data + filter state + the loadLogs/setState mutators
// from the app store via useAppSelectorShallow. The store is the only
// collaborator seam — we drive the view through a controllable context object
// and assert the rendered/filtered DOM and the exact mutator payloads.
// The text-search filter is fed NOT by an in-view input but by the floating
// chat composer through useRegisterViewChatBinding; we exercise that real
// wiring by invoking the registered onQuery via getViewChatBinding() — exactly
// how the composer does at runtime.
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

function t(
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
) {
  let out = options?.defaultValue ?? key;
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (k === "defaultValue") continue;
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
    }
  }
  return out;
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: 1_700_000_000_000,
    level: "info",
    source: "agent",
    tags: ["agent"],
    message: "runtime booted",
    ...overrides,
  } as LogEntry;
}

const LOGS: LogEntry[] = [
  makeEntry({
    level: "info",
    source: "agent",
    tags: ["agent", "plugins"],
    message: "runtime booted with plugins",
    timestamp: 1_700_000_000_000,
  }),
  makeEntry({
    level: "warn",
    source: "server",
    tags: ["websocket"],
    message: "reconnect attempt 2",
    timestamp: 1_700_000_001_000,
  }),
  makeEntry({
    level: "error",
    source: "cloud",
    tags: ["cloud"],
    message: "upstream timeout syncing routes",
    timestamp: 1_700_000_002_000,
  }),
];

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    logs: LOGS,
    logSources: ["agent", "server", "cloud"],
    logTags: ["agent", "plugins", "websocket", "cloud"],
    logTagFilter: "",
    logLevelFilter: "",
    logSourceFilter: "",
    logLoadError: null,
    loadLogs: vi.fn(async () => {}),
    setState: vi.fn(),
    t,
    ...overrides,
  };
}

function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="log-entry"]'),
  ) as HTMLElement[];
}

function messages(): string[] {
  // The message is the last <span> in each row.
  return rows().map((r) => {
    const spans = r.querySelectorAll("span");
    return spans[spans.length - 1]?.textContent ?? "";
  });
}

/** Push a live composer draft into the active view chat binding (real wiring). */
function typeSearch(text: string) {
  act(() => {
    const binding = getViewChatBinding();
    if (!binding?.onQuery) throw new Error("no active view chat binding");
    binding.onQuery(text);
  });
}

beforeEach(() => {
  appMock.value = makeContext();
});

afterEach(() => cleanup());

describe("LogsView filtering", () => {
  it("renders every log row when no filter is active", () => {
    render(<LogsView />);
    expect(rows()).toHaveLength(3);
    // The count span reflects filteredLogs.length.
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("text filter shows only rows whose message/source/level/tags match", () => {
    render(<LogsView />);
    expect(rows()).toHaveLength(3);

    // Matches a message substring — only the cloud timeout row survives.
    typeSearch("timeout");
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["upstream timeout syncing routes"]);

    // Matches a source name — only the server row.
    typeSearch("server");
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["reconnect attempt 2"]);

    // Matches a level — only the error row.
    typeSearch("error");
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["upstream timeout syncing routes"]);

    // Matches a tag — only the row tagged "plugins".
    typeSearch("plugins");
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["runtime booted with plugins"]);
  });

  it("text filter is case-insensitive and trims whitespace", () => {
    render(<LogsView />);
    typeSearch("  TIMEOUT  ");
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["upstream timeout syncing routes"]);
  });

  it("clearing the search text restores every row (round-trip)", () => {
    render(<LogsView />);
    typeSearch("timeout");
    expect(rows()).toHaveLength(1);
    typeSearch("");
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("a non-matching query yields the filtered empty state with a Clear Filters action", async () => {
    render(<LogsView />);
    // Let the mount loadLogs() settle so initialLoading flips false — otherwise
    // the zero-row branch shows the skeleton, not the empty state.
    await act(async () => {});
    typeSearch("zzz-nothing-matches");
    expect(rows()).toHaveLength(0);
    // Empty-state copy switches to the "matching filters" variant...
    expect(
      screen.getByText("logsview.NoLogEntriesMatchingFiltersDescription"),
    ).toBeTruthy();
    // ...and offers a Clear Filters primary action (not shown in the pristine
    // "no entries yet" state).
    expect(screen.getAllByText("logsview.ClearFilters").length).toBeGreaterThan(
      0,
    );
  });

  it("rapid-fire filter toggling is idempotent — final DOM matches the final query", () => {
    render(<LogsView />);
    for (let i = 0; i < 8; i += 1) {
      typeSearch("timeout");
      typeSearch("");
      typeSearch("reconnect");
    }
    // Last query was "reconnect" → exactly the server row.
    expect(rows()).toHaveLength(1);
    expect(messages()).toEqual(["reconnect attempt 2"]);

    typeSearch("");
    expect(rows()).toHaveLength(3);
  });
});

describe("LogsView clear-filters button", () => {
  it("resets the text search AND dispatches setState('') for level/source/tag filters", () => {
    render(<LogsView />);
    // Activate a filter so the Clear button mounts + rows shrink.
    typeSearch("timeout");
    expect(rows()).toHaveLength(1);

    const clearBtn = screen.getByText("logsview.ClearFilters");
    fireEvent.click(clearBtn);

    // Search cleared locally → all rows return.
    expect(rows()).toHaveLength(3);

    // Store filters reset via the setState boundary — exact payloads.
    const setState = appMock.value.setState as ReturnType<typeof vi.fn>;
    expect(setState).toHaveBeenCalledWith("logLevelFilter", "");
    expect(setState).toHaveBeenCalledWith("logSourceFilter", "");
    expect(setState).toHaveBeenCalledWith("logTagFilter", "");
  });

  it("does not render a Clear Filters button when no filter is active", () => {
    render(<LogsView />);
    // Toolbar button only; the empty-state clear action is absent because the
    // list is populated and unfiltered.
    expect(screen.queryByText("logsview.ClearFilters")).toBeNull();
  });
});

describe("LogsView level filter round-trip", () => {
  it("reflects the active store level filter in the select trigger", () => {
    appMock.value = makeContext({ logLevelFilter: "error" });
    render(<LogsView />);
    // Radix SelectValue renders the selected item's text ("error") in the
    // trigger, not the placeholder.
    const trigger = document.querySelector(
      '[data-agent-id="logs-filter-level"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.textContent).toContain("error");
  });

  it("shows the placeholder (All Levels) when no level filter is set", () => {
    render(<LogsView />);
    const trigger = document.querySelector(
      '[data-agent-id="logs-filter-level"]',
    );
    expect(trigger?.textContent).toContain("logsview.AllLevels");
  });
});

describe("LogsView state surfaces", () => {
  it("shows the loading skeleton on first load with no entries yet", () => {
    appMock.value = makeContext({ logs: [], logSources: [], logTags: [] });
    render(<LogsView />);
    // No log rows, no empty-state copy — the skeleton placeholder instead.
    expect(rows()).toHaveLength(0);
    expect(screen.queryByText("logsview.NoLogEntriesYetDescription")).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("shows the pristine empty state (no Clear action) once load settles with zero logs", async () => {
    appMock.value = makeContext({ logs: [], logSources: [], logTags: [] });
    render(<LogsView />);
    // The mount effect flips initialLoading=false after loadLogs settles.
    await screen.findByText("logsview.NoLogEntriesYetDescription");
    expect(screen.queryByText("logsview.ClearFilters")).toBeNull();
  });

  it("renders an error alert with a Retry button that re-invokes loadLogs", () => {
    const loadLogs = vi.fn(async () => {});
    appMock.value = makeContext({
      logLoadError: "upstream 503",
      loadLogs,
    });
    render(<LogsView />);

    const alert = document.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("upstream 503");

    const loadCallsAfterMount = loadLogs.mock.calls.length;
    fireEvent.click(screen.getByText("Retry"));
    expect(loadLogs.mock.calls.length).toBe(loadCallsAfterMount + 1);
  });

  it("shows the error-count badge only when error-level logs are present", () => {
    render(<LogsView />);
    // LOGS has exactly one error entry.
    expect(screen.getByText("1 errors")).toBeTruthy();

    cleanup();
    appMock.value = makeContext({
      logs: [makeEntry({ level: "info", message: "all good" })],
    });
    render(<LogsView />);
    expect(screen.queryByText(/errors$/)).toBeNull();
  });

  it("loads logs on mount (live-tail seed)", () => {
    render(<LogsView />);
    expect(appMock.value.loadLogs).toHaveBeenCalled();
  });
});
