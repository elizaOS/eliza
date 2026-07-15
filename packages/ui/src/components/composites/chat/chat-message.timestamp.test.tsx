/**
 * Verifies that compact message times share the glass action lane for both
 * speakers and inherit its reveal without changing the row's reserved flow.
 *
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

const NOW = new Date("2026-07-15T16:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

beforeAll(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeMessage(
  role: "user" | "assistant",
  timestamp: number,
): ChatMessageData {
  return {
    id: `${role}-message`,
    role,
    text: role === "user" ? "Please keep this compact." : "Absolutely.",
    timestamp,
  };
}

describe("ChatMessage glass timestamp", () => {
  it.each([
    ["assistant", "left-0"],
    ["user", "right-0"],
  ] as const)("renders for the %s lane without reveal reflow", (role, edge) => {
    const timestamp = NOW.getTime() - 5 * MINUTE_MS;
    render(
      <ChatMessage
        appearance="glass"
        message={makeMessage(role, timestamp)}
        onCopy={vi.fn()}
      />,
    );

    const row = screen.getByTestId("thread-line");
    const actions = screen.getByTestId("thread-line-actions");
    const content = actions.parentElement;
    const restingContentClass = content?.className;
    const time = screen.getByTestId("thread-line-timestamp");

    expect(time.textContent).toBe("5m");
    expect(time.getAttribute("dateTime")).toBe(
      new Date(timestamp).toISOString(),
    );
    expect(time.getAttribute("title")).toBe(
      new Date(timestamp).toLocaleString(),
    );
    expect(time.className).toContain("min-w-[3ch]");
    expect(actions.className).toContain(edge);
    expect(actions.getAttribute("aria-hidden")).toBe("true");

    fireEvent.mouseEnter(row);

    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.parentElement?.className).toBe(restingContentClass);
  });

  it.each([
    [59_999, "now"],
    [MINUTE_MS, "1m"],
    [HOUR_MS - 1, "59m"],
    [HOUR_MS, "1h"],
    [DAY_MS - 1, "23h"],
    [DAY_MS, "1d"],
    [7 * DAY_MS - 1, "6d"],
    [7 * DAY_MS, new Date(NOW.getTime() - 7 * DAY_MS).toLocaleDateString()],
  ])("uses the compact relative label at %dms", (age, label) => {
    render(
      <ChatMessage
        appearance="glass"
        message={makeMessage("assistant", NOW.getTime() - age)}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getByTestId("thread-line-timestamp").textContent).toBe(label);
  });

  it("omits the time leaf when a generic message has no transport timestamp", () => {
    render(
      <ChatMessage
        appearance="glass"
        message={{ id: "no-time", role: "assistant", text: "Hello." }}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("thread-line-timestamp")).toBeNull();
  });

  it("keeps the live action accessory beside the timestamp", () => {
    render(
      <ChatMessage
        actionAccessory={<span data-testid="live-status">Working</span>}
        appearance="glass"
        message={makeMessage("assistant", NOW.getTime() - 5 * MINUTE_MS)}
        onCopy={vi.fn()}
      />,
    );

    const accessory = screen.getByTestId("thread-line-action-accessory");
    const liveStatus = screen.getByTestId("live-status");
    const timestamp = screen.getByTestId("thread-line-timestamp");
    expect(
      liveStatus.compareDocumentPosition(timestamp) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(accessory.contains(timestamp)).toBe(true);
    expect(accessory.contains(liveStatus)).toBe(true);
  });
});
