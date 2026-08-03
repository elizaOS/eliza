// @vitest-environment jsdom
/**
 * Proves streamed transcript updates bypass historical scroller-item renders.
 * The real overlay row is rendered; only the scroller primitive is counted.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const itemRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../ui/message-scroller", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../ui/message-scroller")>();
  return {
    ...actual,
    MessageScrollerItem: ({ children }: { children?: ReactNode }) => {
      itemRenders.count += 1;
      return <div data-testid="counted-scroller-item">{children}</div>;
    },
  };
});

import type { ChatMessageData } from "../composites/chat/chat-types";
import { __OverlayThreadLineForTests } from "./ChatOverlay";
import type { ShellMessage } from "./shell-state";

afterEach(() => {
  cleanup();
  itemRenders.count = 0;
});

const onCopy = () => {};
const onLongPressCopy = () => {};
const onSpeak = () => {};
const onEdit = () => true;
const onReply = () => {};
const onRetry = () => {};
const onAcceptSuggestion = () => {};
const onDismissSuggestion = () => {};
const renderContent = (message: ChatMessageData) => message.text;

function line(message: ShellMessage) {
  return (
    <__OverlayThreadLineForTests
      message={message}
      isLastAssistant={false}
      responding={false}
      turnStatus={null}
      firstRunOffset={false}
      speakingSource={false}
      agentName="Eliza"
      reduceMotion={false}
      playing={false}
      onCopy={onCopy}
      onLongPressCopy={onLongPressCopy}
      onSpeak={onSpeak}
      onEdit={onEdit}
      onReply={onReply}
      onRetry={onRetry}
      renderContent={renderContent}
      onAcceptSuggestion={onAcceptSuggestion}
      onDismissSuggestion={onDismissSuggestion}
    />
  );
}

describe("ChatOverlay ThreadLine memoization", () => {
  it("skips a historical scroller item until its message changes", () => {
    const message: ShellMessage = {
      id: "history-1",
      role: "assistant",
      content: "settled answer",
      createdAt: 1,
    };
    const rendered = render(line(message));
    expect(itemRenders.count).toBe(1);

    rendered.rerender(line(message));
    expect(itemRenders.count).toBe(1);

    rendered.rerender(line({ ...message, content: "updated answer" }));
    expect(itemRenders.count).toBe(2);
  });
});
