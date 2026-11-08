/** An empty From display must still name a sender, or the app rejects the page. */
import { describe, expect, test } from "bun:test";
import { normalizeGoogleGmailMessage } from "./gmail";

const withFrom = (from: string) =>
  normalizeGoogleGmailMessage(
    {
      id: "m1",
      threadId: "t1",
      internalDate: "1760000000000",
      payload: { headers: [{ name: "From", value: from }] },
    },
    null,
  );

describe("normalizeGoogleGmailMessage From", () => {
  test("labels empty mailboxes 'Unknown sender'", () => {
    expect(withFrom("<>")?.from).toBe("Unknown sender");
    expect(withFrom('""')?.from).toBe("Unknown sender");
    expect(withFrom('"" <>')?.from).toBe("Unknown sender");
  });

  test("keeps a display name or address", () => {
    expect(withFrom('"Ada" <ada@example.org>')?.from).toBe("Ada");
    expect(withFrom("<ada@example.org>")?.from).toBe("ada@example.org");
  });
});
