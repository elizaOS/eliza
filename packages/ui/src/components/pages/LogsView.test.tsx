// @vitest-environment jsdom

/**
 * Renders `LogsView` in jsdom with mocked state/agent-surface to verify the
 * loading skeleton reserves tall row-shaped space and that the first hydration
 * swap is flagged transient (no layout-shift flash on initial paint).
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { LogsView } from "./LogsView";

const appMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({
    ref: vi.fn(),
    agentProps: {},
  }),
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: vi.fn(),
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    logs: [],
    logSources: [],
    logTags: [],
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

beforeEach(() => {
  vi.useFakeTimers();
  appMock.value = makeContext();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LogsView", () => {
  it("reserves tall row-shaped skeleton space and marks the initial hydration swap transient", async () => {
    let resolveLoad: (() => void) | undefined;
    const loadLogs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    appMock.value = makeContext({ loadLogs });

    render(<LogsView />);

    const panel = screen.getByTestId("logs-entry-panel");
    const skeleton = panel.querySelector('[aria-hidden="true"]');
    expect(skeleton).toBeTruthy();
    expect(skeleton?.children).toHaveLength(4);
    for (const row of Array.from(skeleton?.children ?? [])) {
      expect(row.className).toContain("h-[11.375rem]");
    }

    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });

    expect(panel.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBe(
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(panel.hasAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBe(false);
    expect(skeleton?.isConnected).toBe(false);
  });
});
