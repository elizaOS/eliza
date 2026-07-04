/**
 * Renders the presentational InboxSpatialView to real terminal lines through
 * the spatial TUI registry and asserts the snapshot states lay out correctly.
 * Deterministic — no live model or connector.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INBOX_CHANNEL_LABELS, INBOX_CHANNELS } from "../../types.ts";
import {
  type InboxChannelFilter,
  type InboxSnapshot,
  InboxSpatialView,
} from "./InboxSpatialView.tsx";

function filters(active: Set<string> = new Set()): InboxChannelFilter[] {
  return INBOX_CHANNELS.map((channel) => ({
    channel,
    label: INBOX_CHANNEL_LABELS[channel],
    active: active.has(channel),
  }));
}

const populated: InboxSnapshot = {
  status: "ready",
  items: [
    {
      id: "gmail:msg-1",
      channel: "gmail",
      sender: "Acme Billing",
      subject: "Invoice 42 overdue",
      preview: "Please remit payment",
      receivedAt: "2026-06-16T10:00:00.000Z",
      unread: true,
      threadId: "thread-gmail-1",
    },
    {
      id: "discord:msg-7",
      channel: "discord",
      sender: "guildmate",
      subject: null,
      preview: "gm everyone",
      receivedAt: "2026-06-16T09:30:00.000Z",
      unread: false,
      threadId: "thread-discord-7",
    },
  ],
  filters: filters(),
  activeFilterCount: 0,
  hasConnectedChannels: true,
  degradedSources: [],
  nudge: "1 thread still needs a reply.",
  error: null,
};

const view = <InboxSpatialView snapshot={populated} />;

describe("InboxSpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Invoice 42 overdue");
      expect(flat).toContain("guildmate");
      expect(flat).toContain("Email");
      expect(flat).toContain("Discord");
      // The unread nudge is surfaced (the sentence may wrap at narrow widths,
      // so match a fragment that survives the line break).
      expect(flat).toContain("still needs a");
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("Invoice 42 overdue");
      expect(html).toContain("guildmate");
      // Channel filter chips are addressable by agent id.
      expect(html).toContain('data-agent-id="inbox-channel-gmail"');
      // Each triage row exposes an Open action keyed by message id.
      expect(html).toContain('data-agent-id="open:gmail:msg-1"');
    }
  });

  it("GUI: keeps the wrapped channel filter row from shrinking into the body", () => {
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    expect(html).toContain("flex-shrink:0");
    expect(html).toContain("1 thread still needs a reply.");
  });

  it("error state renders the message and a Retry action", () => {
    const error: InboxSnapshot = {
      status: "error",
      items: [],
      filters: filters(),
      activeFilterCount: 0,
      hasConnectedChannels: false,
      degradedSources: [],
      nudge: null,
      error: "Inbox request failed (503)",
    };
    const lines = renderViewToLines(<InboxSpatialView snapshot={error} />, 54);
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Couldn't load inbox");
    expect(flat).toContain("Inbox request failed (503)");
    expect(flat).toContain("Retry");
  });

  it("empty (no channels) renders the connect affordance", () => {
    const empty: InboxSnapshot = {
      status: "empty",
      items: [],
      filters: filters(),
      activeFilterCount: 0,
      hasConnectedChannels: false,
      degradedSources: [],
      nudge: null,
      error: null,
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <InboxSpatialView snapshot={empty} />
      </SpatialSurface>,
    );
    expect(html).toContain("None");
    expect(html).toContain('data-agent-id="connect"');
  });

  it("empty (connected, inbox zero) renders the caught-up copy", () => {
    const zero: InboxSnapshot = {
      status: "empty",
      items: [],
      filters: filters(),
      activeFilterCount: 0,
      hasConnectedChannels: true,
      degradedSources: [],
      nudge: null,
      error: null,
    };
    const lines = renderViewToLines(<InboxSpatialView snapshot={zero} />, 54);
    const flat = lines.join("\n");
    expect(flat).toContain("Inbox zero");
    expect(flat).not.toContain("None");
  });

  it("an active channel filter is marked on its chip", () => {
    const active: InboxSnapshot = {
      ...populated,
      filters: filters(new Set(["gmail"])),
      activeFilterCount: 1,
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <InboxSpatialView snapshot={active} />
      </SpatialSurface>,
    );
    // The active chip is prefixed with the width-1 active marker.
    expect(html).toContain("* Email");
  });

  it("degraded source renders the banner with the reason and a Reconnect action across GUI + TUI", () => {
    const degraded: InboxSnapshot = {
      ...populated,
      degradedSources: [
        {
          source: "gmail",
          label: "Gmail",
          message:
            "Gmail authorization has expired — reconnect Google to resume inbox sync.",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <InboxSpatialView snapshot={degraded} />
      </SpatialSurface>,
    );
    expect(html).toContain("Gmail unavailable");
    expect(html).toContain("Gmail authorization has expired");
    expect(html).toContain('data-agent-id="reconnect:gmail"');
    // Messages from healthy channels still render alongside the banner.
    expect(html).toContain("Invoice 42 overdue");

    const lines = renderViewToLines(
      <InboxSpatialView snapshot={degraded} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Gmail unavailable");
    expect(flat).toContain("Reconnect");
  });

  it("empty + degraded never claims inbox zero and names the unreachable source", () => {
    const emptyDegraded: InboxSnapshot = {
      status: "empty",
      items: [],
      filters: filters(),
      activeFilterCount: 0,
      hasConnectedChannels: false,
      degradedSources: [
        {
          source: "gmail",
          label: "Gmail",
          message:
            "Gmail authorization has expired — reconnect Google to resume inbox sync.",
        },
        {
          source: "x_dm",
          label: "X DMs",
          message: "X is connected but DM read access was not granted.",
        },
      ],
      nudge: null,
      error: null,
    };
    const html = renderToStaticMarkup(
      <SpatialSurface modality="gui">
        <InboxSpatialView snapshot={emptyDegraded} />
      </SpatialSurface>,
    );
    expect(html).not.toContain("Inbox zero");
    // The degraded empty state must not push the connect-a-channel CTA either.
    expect(html).not.toContain('data-agent-id="connect"');
    expect(html).toContain("Gmail unavailable");
    expect(html).toContain("X DMs unavailable");
    expect(html).toContain("No messages from reachable channels");
    expect(html).toContain('data-agent-id="reconnect:gmail"');
    expect(html).toContain('data-agent-id="reconnect:x_dm"');
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("inbox-test", () => view);
    try {
      const component = getTerminalView("inbox-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("Invoice 42 overdue");
    } finally {
      unregister();
    }
  });
});
