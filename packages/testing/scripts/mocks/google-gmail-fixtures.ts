/** Fixture names shared by the mock provider and legacy static-server seeding. */
export const GMAIL_FIXTURE_MESSAGE_IDS: Readonly<
  Record<string, readonly string[]>
> = {
  default: ["msg-finance", "msg-sarah", "msg-newsletter"],
  "unread-inbox.eml": ["msg-finance", "msg-sarah"],
  "sarah-product-brief.eml": ["msg-sarah"],
  "high-priority-client.eml": ["msg-sarah"],
  "alice-recent.eml": ["msg-sarah"],
  "followup-14-days-ago.eml": [
    "msg-unresponded-inbound",
    "msg-unresponded-sent",
  ],
  "injection-fake-wire-instruction": ["msg-injection-wire"],
};
