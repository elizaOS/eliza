// @vitest-environment jsdom

/**
 * Repaint lock for the `[CONFIG:<pluginId>]` connector-setup widget (#14412),
 * in the spirit of chat-transcript.render-count.test.tsx (#9141): a transcript
 * parent re-rendering with unrelated state must NOT re-render the config-card
 * subtree — `InlinePluginConfig` is memoized on its single primitive prop — and
 * conversely a widget-internal update (a field edit) must re-render ONLY the
 * widget, proving its state stays isolated from the transcript.
 *
 * HOW RENDERS ARE COUNTED: `ConfigRenderer` receives fresh props on every
 * `InlinePluginConfig` render (rebuilt `values` / `hints` objects) and is not
 * memoized, so it renders exactly once per InlinePluginConfig render. This
 * suite replaces it with a counting probe that forwards `onChange` (a real
 * production prop) to drive the field-edit case. The real form engine is
 * covered by MessageContent.config.test.tsx / .connector-setup.test.tsx.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

const { clientMock, configRendererRenders } = vi.hoisted(() => ({
  clientMock: {
    getPlugins: vi.fn(),
    updatePlugin: vi.fn(),
  },
  configRendererRenders: { count: 0 },
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../config-ui/config-renderer", () => ({
  ConfigRenderer: ({
    onChange,
  }: {
    onChange?: (key: string, value: unknown) => void;
  }) => {
    configRendererRenders.count += 1;
    return (
      <button
        type="button"
        data-testid="probe-edit-field"
        onClick={() => onChange?.("TELEGRAM_BOT_TOKEN", "12345:tok")}
      >
        probe
      </button>
    );
  },
}));

import { MessageContent } from "./MessageContent";

function plugin(): PluginInfo {
  return {
    id: "telegram",
    name: "Telegram",
    description: "",
    enabled: false,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [
      {
        key: "TELEGRAM_BOT_TOKEN",
        type: "string",
        description: "Bot token",
        required: true,
        sensitive: true,
        currentValue: null,
        isSet: false,
      },
    ],
    validationErrors: [],
    validationWarnings: [],
  };
}

const message: ConversationMessage = {
  id: "m-render-count",
  role: "assistant",
  text: "Set it up: [CONFIG:telegram]",
  timestamp: 1_700_000_000_000,
} as ConversationMessage;

/**
 * Stand-in for the transcript row: `unrelated` state changes re-render the
 * host (and MessageContent below it) exactly like a streaming tick or store
 * update re-rendering the surrounding transcript would.
 */
function TranscriptHost() {
  const [unrelated, setUnrelated] = useState(0);
  return (
    <div>
      <button
        type="button"
        data-testid="unrelated-tick"
        onClick={() => setUnrelated((n) => n + 1)}
      >
        tick {unrelated}
      </button>
      <MessageContent message={message} />
    </div>
  );
}

let appValue: never;

beforeEach(() => {
  configRendererRenders.count = 0;
  clientMock.getPlugins.mockReset();
  clientMock.updatePlugin.mockReset();
  clientMock.getPlugins.mockResolvedValue({ plugins: [plugin()] });
  appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    setActionNotice: vi.fn(),
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage: vi.fn(),
    setTab: vi.fn(),
    handleChatRetry: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("InlinePluginConfig render isolation (#14412)", () => {
  it("does not re-render on transcript-parent re-renders; re-renders alone on its own edits", async () => {
    render(
      <AppContext.Provider value={appValue}>
        <TranscriptHost />
      </AppContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("probe-edit-field")).toBeTruthy();
    });
    const afterMount = configRendererRenders.count;
    expect(afterMount).toBeGreaterThan(0);

    // Two unrelated transcript ticks: the memo boundary must swallow both.
    fireEvent.click(screen.getByTestId("unrelated-tick"));
    fireEvent.click(screen.getByTestId("unrelated-tick"));
    expect(configRendererRenders.count).toBe(afterMount);

    // A widget-internal field edit still flows: exactly one extra render of
    // the widget subtree, none for the transcript parent.
    fireEvent.click(screen.getByTestId("probe-edit-field"));
    expect(configRendererRenders.count).toBe(afterMount + 1);
    // The host's own state was untouched by the widget edit.
    expect(screen.getByTestId("unrelated-tick").textContent).toContain(
      "tick 2",
    );
  });

  it("chevron collapse/expand repaints only the shell, not the widget body", async () => {
    render(
      <AppContext.Provider value={appValue}>
        <TranscriptHost />
      </AppContext.Provider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("probe-edit-field")).toBeTruthy();
    });
    const afterMount = configRendererRenders.count;

    // Expand/collapse state lives in ChatWidgetShell BELOW the memo boundary;
    // toggling must not re-render the widget's body children.
    fireEvent.click(screen.getByTestId("inline-plugin-config-chevron"));
    fireEvent.click(screen.getByTestId("inline-plugin-config-chevron"));
    expect(configRendererRenders.count).toBe(afterMount);
  });
});
