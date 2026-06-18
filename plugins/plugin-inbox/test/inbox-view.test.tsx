// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InboxView } from "../src/components/inbox/InboxView.tsx";
import type { ThreadSummary } from "../src/types.ts";

// InboxView is a placeholder GUI view (dataSource: props). It renders a static
// header, eight channel filter chips (module-const CHANNEL_CHIPS), and a thread
// list driven by props.threads. The only interactive behavior is toggleChannel,
// which mutates an activeChannels Set and re-filters visibleThreads. There is no
// external API to contract-test (purely props). jest-dom matchers are NOT
// installed in this repo, so we assert against real DOM nodes with plain Vitest
// matchers (mirrors plugin-documents/test/documents-view.test.tsx).

const ORANGE = "rgb(249, 115, 22)"; // #f97316 active chip background
const INACTIVE_BORDER = "rgb(68, 68, 68)"; // #444 inactive chip border
const WHITE = "rgb(255, 255, 255)"; // #fff active chip text

const SUBTITLE = "Unified triage across every connected channel.";
const EMPTY_TEXT = "No threads to triage.";

const ALL_CHIP_LABELS = [
  "Email",
  "Discord",
  "Telegram",
  "WhatsApp",
  "Slack",
  "X",
  "Farcaster",
  "iMessage",
] as const;

// Realistic two-channel fixture. The discord thread deliberately omits `subject`
// to exercise the `subject ?? threadId` fallback in the <strong> render.
const EMAIL_THREAD: ThreadSummary = {
  threadId: "t1",
  channel: "email",
  participants: ["a@example.com"],
  subject: "Invoice #42 overdue",
  lastMessagePreview: "Please remit payment",
  lastMessageAt: "2026-06-16T10:00:00.000Z",
  unread: true,
  unresolved: true,
};

const DISCORD_THREAD: ThreadSummary = {
  threadId: "discord-thread-7",
  channel: "discord",
  participants: ["@guildmate"],
  // no subject -> falls back to threadId
  lastMessagePreview: "gm everyone",
  lastMessageAt: "2026-06-16T09:30:00.000Z",
  unread: false,
  unresolved: false,
};

const TWO_CHANNEL_FIXTURE: ThreadSummary[] = [EMAIL_THREAD, DISCORD_THREAD];

function chip(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

afterEach(cleanup);

describe("InboxView header + chips (static region)", () => {
  it("renders the static header heading and subtitle", () => {
    render(<InboxView />);

    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(screen.getByText(SUBTITLE)).toBeTruthy();
  });

  it("renders all 8 channel filter chips, each inactive by default", () => {
    render(<InboxView />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(8);
    expect(buttons.map((b) => b.textContent)).toEqual([...ALL_CHIP_LABELS]);

    for (const label of ALL_CHIP_LABELS) {
      const button = chip(label);
      // Default (inactive) state: aria-pressed=false + transparent fill + #444 border.
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.style.background).toBe("transparent");
      expect(button.style.borderColor).toBe(INACTIVE_BORDER);
    }
  });
});

describe("InboxView empty state", () => {
  it("shows the empty-state text and zero list items when no threads are provided", () => {
    render(<InboxView />);

    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("shows the empty-state text when an explicit empty array is provided", () => {
    render(<InboxView threads={[]} />);

    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("InboxView populated thread list", () => {
  it("renders one <li> per thread with subject, channel, and preview, hiding the empty state", () => {
    render(<InboxView threads={TWO_CHANNEL_FIXTURE} />);

    // Empty state must be gone once threads exist.
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    // Email thread: subject in <strong>, "channel — preview" subline.
    const subject = screen.getByText("Invoice #42 overdue");
    expect(subject.tagName).toBe("STRONG");
    expect(screen.getByText("email — Please remit payment")).toBeTruthy();

    // Discord thread has no subject -> falls back to rendering its threadId.
    const fallback = screen.getByText("discord-thread-7");
    expect(fallback.tagName).toBe("STRONG");
    expect(screen.getByText("discord — gm everyone")).toBeTruthy();
  });
});

describe("InboxView toggleChannel interaction", () => {
  it("clicking a chip activates it (aria-pressed + orange styling), clicking again reverts", () => {
    render(<InboxView />);

    const discord = chip("Discord");
    expect(discord.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(discord);
    expect(chip("Discord").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Discord").style.background).toBe(ORANGE);
    expect(chip("Discord").style.color).toBe(WHITE);
    expect(chip("Discord").style.borderColor).toBe(ORANGE);

    // Other chips remain untouched.
    expect(chip("Email").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Email").style.background).toBe("transparent");

    // Toggling off restores the inactive styling.
    fireEvent.click(chip("Discord"));
    expect(chip("Discord").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Discord").style.background).toBe("transparent");
    expect(chip("Discord").style.borderColor).toBe(INACTIVE_BORDER);
  });
});

describe("InboxView filtering behavior (visibleThreads)", () => {
  it("with no chip active, shows all threads", () => {
    render(<InboxView threads={TWO_CHANNEL_FIXTURE} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Invoice #42 overdue")).toBeTruthy();
    expect(screen.getByText("discord-thread-7")).toBeTruthy();
  });

  it("activating a chip narrows the list to only that channel", () => {
    render(<InboxView threads={TWO_CHANNEL_FIXTURE} />);

    fireEvent.click(chip("Email"));

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(screen.getByText("Invoice #42 overdue")).toBeTruthy();
    // The discord thread is filtered out entirely.
    expect(screen.queryByText("discord-thread-7")).toBeNull();
    expect(screen.queryByText("discord — gm everyone")).toBeNull();
  });

  it("activating a second chip widens the visible set (union semantics)", () => {
    render(<InboxView threads={TWO_CHANNEL_FIXTURE} />);

    fireEvent.click(chip("Email"));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    // Adding Discord re-includes the discord thread (union, not intersection).
    fireEvent.click(chip("Discord"));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Invoice #42 overdue")).toBeTruthy();
    expect(screen.getByText("discord-thread-7")).toBeTruthy();

    // Deactivating Email leaves only the discord thread.
    fireEvent.click(chip("Email"));
    const remaining = screen.getAllByRole("listitem");
    expect(remaining).toHaveLength(1);
    expect(screen.getByText("discord-thread-7")).toBeTruthy();
    expect(screen.queryByText("Invoice #42 overdue")).toBeNull();
  });

  it("activating a chip with no matching threads yields the empty state", () => {
    render(<InboxView threads={TWO_CHANNEL_FIXTURE} />);

    // Slack has no thread in the fixture -> visibleThreads becomes empty.
    fireEvent.click(chip("Slack"));

    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText("Invoice #42 overdue")).toBeNull();
    expect(screen.queryByText("discord-thread-7")).toBeNull();
  });
});
