/**
 * Covers numeric HTML-entity decoding on Gmail subject/snippet triage reads.
 * Reviewer request on #34464: assert &#x27;/&#8217; in Subject + snippet so a
 * regression is caught in-tree.
 */
import { describe, expect, it } from "vitest";
import { GoogleGmailClient } from "./gmail.ts";
import type { GoogleApiClientFactory } from "./client-factory.ts";

function stubFactory(message: Record<string, unknown>): GoogleApiClientFactory {
  return {
    gmail: async () => ({
      users: {
        messages: {
          get: async () => ({ data: message }),
        },
      },
    }),
  } as unknown as GoogleApiClientFactory;
}

describe("Gmail numeric HTML entities", () => {
  it("decodes Subject and snippet numeric references used by triage reads", async () => {
    const client = new GoogleGmailClient(
      stubFactory({
        id: "msg-entities",
        threadId: "thr-entities",
        labelIds: ["INBOX", "UNREAD"],
        internalDate: "1728450000000",
        snippet: "a&#160;b &#x27;c&#x27; &#8217;",
        payload: {
          headers: [
            {
              name: "Subject",
              value: "It&#x27;s &#8217;snowing&#8217; &#8211; caf&#233;",
            },
            { name: "From", value: "Sender <sender@example.com>" },
            { name: "To", value: "me@example.com" },
          ],
        },
      }),
    );

    const summary = await client.getGmailMessage({
      accountId: "acct-test",
      messageId: "msg-entities",
      selfEmail: "me@example.com",
    });

    expect(summary).not.toBeNull();
    expect(summary!.subject).toBe("It's \u2019snowing\u2019 \u2013 caf\u00e9");
    expect(summary!.snippet).toBe("a b 'c' \u2019");
  });
});
