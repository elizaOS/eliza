/**
 * Deterministic component coverage for the two locally supported group-chat
 * walkthroughs. The test asserts the product-critical permission, response,
 * identity, duplicate, and recovery language rather than provider pixels.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GroupChatReadinessGuide } from "./GroupChatReadinessGuide";

describe("GroupChatReadinessGuide", () => {
  afterEach(() => cleanup());

  it("explains Telegram privacy, reply policy, topic identity, and replay safety", () => {
    render(<GroupChatReadinessGuide connector="telegram" />);

    const guide = screen.getByTestId("telegram-group-guide");
    expect(guide.textContent).toContain("BotFather privacy");
    expect(guide.textContent).toContain("TELEGRAM_AUTO_REPLY=true");
    expect(guide.textContent).toContain("TELEGRAM_ALLOWED_CHATS");
    expect(guide.textContent).toContain("forum topic");
    expect(guide.textContent).toContain("uncertain retry is refused");
    expect(guide.textContent).toContain("remove and re-add");
  });

  it("explains BlueBubbles host access, allowlists, participant mapping, and recovery", () => {
    render(<GroupChatReadinessGuide connector="bluebubbles" />);

    const guide = screen.getByTestId("bluebubbles-group-guide");
    expect(guide.textContent).toContain("Full Disk Access");
    expect(guide.textContent).toContain("BLUEBUBBLES_GROUP_ALLOW_FROM");
    expect(guide.textContent).toContain("no mention-only");
    expect(guide.textContent).toContain("phone or email handle");
    expect(guide.textContent).toContain("message GUID");
    expect(guide.textContent).toContain("Remove the Messages participant");
  });
});
