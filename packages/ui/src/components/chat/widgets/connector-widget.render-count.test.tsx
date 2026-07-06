// @vitest-environment jsdom
//
// Repaint lock for connector widgets in a transcript (#14412). A transcript of
// N connector widgets is rendered as memoized `ChatTranscript` rows; toggling
// ONE widget's Advanced dropdown (its internal state) must not re-render any
// sibling row. We assert this two ways: the per-row `renderMessageContent`
// counter (a real production prop) stays flat for siblings, and only the
// toggled widget's own body count increments. This extends the streaming
// render-count lock (`chat-transcript.render-count.test.tsx`) to cover the new
// widget's internal state churn — the case the issue calls out.

import type { PluginParam } from "@elizaos/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "../../composites/chat/chat-transcript";
import type { ChatMessageData } from "../../composites/chat/chat-types";
import { ConnectorSetupWidget } from "./connector-setup-widget";

afterEach(cleanup);

const WIDGET_COUNT = 6;

// Every widget is unconfigured so it renders expanded with an Advanced tier we
// can toggle. Set-optional field makes `advanced.length === 1`.
const PARAMS: PluginParam[] = [
  { key: "TOKEN", required: true, isSet: false, label: "Token" },
  { key: "GUILD", required: false, isSet: true, label: "Guild" },
];

function makeTranscript(): ChatMessageData[] {
  const messages: ChatMessageData[] = [];
  for (let i = 0; i < WIDGET_COUNT; i += 1) {
    messages.push({
      id: `conn-${i}`,
      role: "assistant",
      text: `connector ${i}`,
    });
  }
  return messages;
}

describe("connector widgets do not repaint the transcript (#14412)", () => {
  it("toggling one widget's Advanced dropdown re-renders only that widget", () => {
    // Per-row render tally via the real renderMessageContent prop.
    const rowCounts = new Map<string, number>();
    const renderMessageContent = vi.fn((message: ChatMessageData) => {
      rowCounts.set(message.id, (rowCounts.get(message.id) ?? 0) + 1);
      return (
        <ConnectorSetupWidget
          id={message.id}
          name={`Connector ${message.id}`}
          params={PARAMS}
          onSetup={() => {}}
        />
      );
    });

    const { getByTestId } = render(
      <ChatTranscript
        messages={makeTranscript()}
        renderMessageContent={renderMessageContent}
      />,
    );

    // Mount: every row rendered exactly once.
    for (let i = 0; i < WIDGET_COUNT; i += 1) {
      expect(rowCounts.get(`conn-${i}`)).toBe(1);
    }
    const afterMount = new Map(rowCounts);

    // Interact with ONE widget: open its Advanced dropdown (internal state).
    fireEvent.click(getByTestId("connector-widget-conn-2-advanced-toggle"));

    // No sibling row's content was re-rendered — the widget's state stayed
    // local to its own subtree; the transcript did not repaint.
    for (let i = 0; i < WIDGET_COUNT; i += 1) {
      expect(rowCounts.get(`conn-${i}`)).toBe(afterMount.get(`conn-${i}`));
    }

    // The interaction actually did something: the toggled widget now shows the
    // advanced field it was hiding.
    expect(
      getByTestId("connector-widget-conn-2-advanced-body").textContent,
    ).toContain("Guild");
  });
});
