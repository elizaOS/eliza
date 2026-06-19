import type { GetLifeOpsInboxRequest } from "@elizaos/shared";

const PROACTIVE_INBOX_DIGEST_REQUEST = {
  limit: 24,
  // Chat connector memories do not carry reliable per-owner read state yet;
  // the inbox layer conservatively marks them unread so explicit inbox views
  // can still triage them. Proactive digests should only summarize channels
  // with personal inbox semantics until chat read/mention state is grounded.
  channels: ["gmail", "x_dm", "imessage", "whatsapp", "sms"],
  groupByThread: true,
  missedOnly: true,
  sortByPriority: true,
} satisfies GetLifeOpsInboxRequest;

export function proactiveInboxDigestRequest(): GetLifeOpsInboxRequest {
  return {
    ...PROACTIVE_INBOX_DIGEST_REQUEST,
    channels: [...(PROACTIVE_INBOX_DIGEST_REQUEST.channels ?? [])],
  };
}
