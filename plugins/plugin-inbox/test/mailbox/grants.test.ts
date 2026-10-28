/** Incremental Gmail grants against synthetic account rows. No Google account or consent is involved. */
import { describe, expect, it } from "vitest";
import {
  GMAIL_MODIFY_CAPABILITIES,
  gmailActionGrant,
  gmailCapabilitiesFor,
  gmailConsentCapabilities,
  gmailGrantChange,
  gmailGrantLabel,
  gmailGrantTier,
  gmailInboxAllows,
  gmailModifyIncomplete,
  gmailReadable,
  gmailReadCacheKey,
  googleAccountAccessLabel,
  requiredGmailCapability,
} from "../../src/mailbox/grants.ts";
import type {
  GmailAccount,
  GmailInboxCapabilities,
} from "../../src/mailbox/types.ts";

const account = (
  capabilities: string[],
  patch: Partial<GmailAccount> = {},
): GmailAccount => ({
  configured: true,
  connected: true,
  reason: "connected",
  connectionId: "grant-1",
  label: "Mailbox",
  grantedCapabilities: capabilities,
  ...patch,
});
const READ = ["google.gmail.triage"],
  MODIFY = [...READ, ...GMAIL_MODIFY_CAPABILITIES];
const caps = (
  patch: Partial<GmailInboxCapabilities> = {},
): GmailInboxCapabilities => ({
  version: 1,
  from: "a@example.invalid",
  threads: true,
  send: true,
  providerDrafts: true,
  mailboxMutations: true,
  attachments: true,
  providerExactlyOnce: false,
  atomicDraftReplacement: false,
  readState: true,
  draftsList: true,
  forwardAttachments: false,
  searchTrash: false,
  opaqueAttachments: false,
  attachmentPolicy: {
    maximumOutgoing: 1,
    maximumBytes: 5242880,
    maximumTotalBytes: 5242880,
  },
  ...patch,
});

describe("managed Gmail grants", () => {
  it("asks for read first; modify is one incremental step that keeps read", () => {
    expect(gmailCapabilitiesFor("read")).toEqual([
      "google.basic_identity",
      "google.gmail.triage",
    ]);
    expect(gmailCapabilitiesFor("modify")).toEqual([
      "google.basic_identity",
      "google.gmail.triage",
      "google.gmail.send",
      "google.gmail.drafts",
      "google.gmail.mailbox",
    ]);
  });

  it("a reconnect names the grants the account already holds and nothing unknown", () => {
    expect(
      gmailConsentCapabilities("read", [
        "google.gmail.send",
        "google.calendar.write",
      ]),
    ).toEqual([
      "google.basic_identity",
      "google.gmail.triage",
      "google.gmail.send",
    ]);
    expect(gmailConsentCapabilities("drafts")).toEqual([
      "google.basic_identity",
      "google.gmail.triage",
      "google.gmail.drafts",
    ]);
    expect(gmailConsentCapabilities("modify", READ)).toEqual(
      gmailCapabilitiesFor("modify"),
    );
  });

  it("maps approved mailbox actions to the change capability they need", () => {
    expect(requiredGmailCapability("send")).toBe("google.gmail.send");
    for (const kind of [
      "draft-create",
      "draft-replace",
      "draft-delete",
    ] as const)
      expect(requiredGmailCapability(kind)).toBe("google.gmail.drafts");
    for (const kind of [
      "archive",
      "unarchive",
      "trash",
      "untrash",
      "mark-read",
      "mark-unread",
    ] as const)
      expect(requiredGmailCapability(kind)).toBe("google.gmail.mailbox");
    expect(gmailActionGrant(account(READ), "archive")).toBe("upgrade");
    expect(gmailActionGrant(account(MODIFY), "send")).toBe("granted");
    expect(gmailActionGrant(account(["google.gmail.send"]), "send")).toBe(
      "unreadable",
    );
    expect(
      gmailActionGrant(account(MODIFY, { connected: false }), "send"),
    ).toBe("unreadable");
    expect(gmailInboxAllows(caps({ mailboxMutations: false }), "trash")).toBe(
      false,
    );
    expect(gmailInboxAllows(caps(), "draft-create")).toBe(true);
    expect(gmailInboxAllows(null, "send")).toBe(false);
    expect(gmailModifyIncomplete(caps({ send: false }))).toBe(true);
    expect(gmailModifyIncomplete(caps())).toBe(false);
  });

  it("reports grant tiers and labels", () => {
    expect(gmailGrantTier(account(READ))).toBe("readonly");
    expect(gmailGrantTier(account(MODIFY))).toBe("modify");
    expect(gmailGrantTier(account([...READ, "google.gmail.send"]))).toBe(
      "readonly",
    );
    expect(gmailGrantTier(account(MODIFY, { connectionId: null }))).toBe(
      "none",
    );
    expect(gmailReadable(account(READ))).toBe(true);
    expect(gmailReadable(null)).toBe(false);
    expect(gmailGrantLabel([account(READ)])).toBe("Read access authorized");
    expect(
      gmailGrantLabel([
        account(READ),
        account(MODIFY, { connectionId: "grant-2" }),
      ]),
    ).toBe("Read and change access authorized");
    expect(gmailGrantLabel([account([])])).toBe("Authorization required");
    expect(
      googleAccountAccessLabel(account([...READ, "google.calendar.read"])),
    ).toBe("Connected · Gmail: Read access · Calendar: Read access");
    expect(
      googleAccountAccessLabel(
        account([
          ...READ,
          "google.gmail.send",
          "google.calendar.read",
          "google.calendar.write",
        ]),
      ),
    ).toBe(
      "Connected · Gmail: Read and send access · Calendar: Read and edit access",
    );
  });

  it("isolates cached mail and unsent reviews across revoke, account and session changes", () => {
    const s = "session-1";
    expect(gmailReadCacheKey(s, account([]))).toBeNull();
    expect(gmailReadCacheKey(null, account(READ))).toBeNull();
    expect(gmailReadCacheKey(s, account(READ))).not.toBe(
      gmailReadCacheKey("session-2", account(READ)),
    );
    expect(gmailReadCacheKey(s, account(READ))).not.toBe(
      gmailReadCacheKey(s, account(READ, { connectionId: "grant-2" })),
    );
    expect(gmailReadCacheKey(s, account(READ))).toBe(
      gmailReadCacheKey(s, account(MODIFY)),
    );
    expect(
      gmailGrantChange(
        { sessionId: s, account: account(READ) },
        { sessionId: s, account: account(MODIFY) },
      ),
    ).toEqual({ dropReadCache: false, withdrawn: [] });
    expect(
      gmailGrantChange(
        { sessionId: s, account: account(MODIFY) },
        { sessionId: s, account: account([...READ, "google.gmail.drafts"]) },
      ),
    ).toEqual({
      dropReadCache: false,
      withdrawn: ["google.gmail.send", "google.gmail.mailbox"],
    });
    expect(
      gmailGrantChange(
        { sessionId: s, account: account(MODIFY) },
        { sessionId: s, account: account([]) },
      ),
    ).toEqual({
      dropReadCache: true,
      withdrawn: [...GMAIL_MODIFY_CAPABILITIES],
    });
    expect(
      gmailGrantChange(
        { sessionId: s, account: account(MODIFY) },
        { sessionId: s, account: undefined },
      ),
    ).toEqual({
      dropReadCache: true,
      withdrawn: [...GMAIL_MODIFY_CAPABILITIES],
    });
    expect(
      gmailGrantChange(
        { sessionId: s, account: account(READ) },
        { sessionId: "session-2", account: account(READ) },
      ).dropReadCache,
    ).toBe(true);
  });
});
