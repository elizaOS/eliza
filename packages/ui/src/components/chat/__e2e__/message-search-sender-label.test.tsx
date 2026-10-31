// @vitest-environment jsdom
/** Message search result rows name the sender the transcript shows. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationMessageSearchResult } from "../../../api/client-types-chat";
import { MessageSearchPanel } from "../MessageSearchPanel";

afterEach(cleanup);

const hit = (
  overrides: Partial<ConversationMessageSearchResult>,
): ConversationMessageSearchResult => ({
  messageId: "m",
  conversationId: "c",
  roomId: "r",
  role: "user",
  text: "walrus",
  snippet: "walrus",
  createdAt: 0,
  score: 1,
  ...overrides,
});

it("labels a non-owner hit with its sender and an unnamed user hit as You", async () => {
  const search = vi.fn(async () => [
    hit({ messageId: "member", from: "Member Display", source: "discord" }),
    hit({ messageId: "handle", fromUserName: "member_handle" }),
    hit({ messageId: "owner" }),
    hit({ messageId: "agent", role: "assistant" }),
  ]);
  render(
    <MessageSearchPanel
      search={search}
      onJump={() => {}}
      onClose={() => {}}
      initialQuery="walrus"
    />,
  );

  const rows = await screen.findAllByTestId("message-search-result");
  expect(rows.map((row) => row.textContent?.split(" ·")[0])).toEqual([
    "Member Display",
    "member_handle",
    "You",
    "Eliza",
  ]);
});
