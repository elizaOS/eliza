import { afterEach, describe, expect, it } from "bun:test";
import { requireLoginValue } from "../../../../required";

import { EmailAuth } from "../email";
import { MockEmailInbox, MockEmailProvider } from "../email-provider";

describe("MockEmailProvider", () => {
  afterEach(() => MockEmailInbox.clear());

  it("captures sent messages keyed by recipient", async () => {
    const provider = new MockEmailProvider();
    await provider.send("Alice@Example.com", "hi", "world");

    const msg = MockEmailInbox.last("alice@example.com");
    expect(msg).toBeDefined();
    expect(msg?.to).toBe("Alice@Example.com");
    expect(msg?.subject).toBe("hi");
    expect(msg?.text).toBe("world");
  });

  it("extracts the magic-link token from the email body", async () => {
    const auth = new EmailAuth({
      from: "login@steward.fi",
      baseUrl: "https://steward.fi",
      provider: new MockEmailProvider(),
      tokenTtlMs: 60_000,
    });

    const { tokenHash } = await auth.sendMagicLink("bob@example.com");
    const msg = MockEmailInbox.last("bob@example.com");
    expect(msg?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(msg?.magicLink).toContain(
      "https://steward.fi/auth/callback/email?token=",
    );

    // The captured token must redeem against the live token store.
    const result = await auth.verifyMagicLink(
      requireLoginValue(requireLoginValue(msg, "msg").token, "msg!.token"),
      "bob@example.com",
    );
    expect(result.valid).toBe(true);
    expect(result.email).toBe("bob@example.com");
    expect(tokenHash).toBeDefined();

    auth.destroy();
  });

  it("returns all messages for an email and supports clear", async () => {
    const provider = new MockEmailProvider();
    await provider.send("c@example.com", "1", "body1");
    await provider.send("c@example.com", "2", "body2");
    expect(MockEmailInbox.all("c@example.com")).toHaveLength(2);

    MockEmailInbox.clear("c@example.com");
    expect(MockEmailInbox.all("c@example.com")).toHaveLength(0);
  });

  it("preserves the legacy regex's last-token extraction semantics", async () => {
    const provider = new MockEmailProvider();
    await provider.send(
      "tokens@example.com",
      "tokens",
      "open https://steward.fi/callback?token=first&next=1&token=second&after=ignored",
    );
    const msg = MockEmailInbox.last("tokens@example.com");
    expect(msg?.token).toBe("second");
    expect(msg?.magicLink).toBe(
      "https://steward.fi/callback?token=first&next=1&token=second",
    );
  });

  it("handles adversarial scheme runs without regex backtracking", async () => {
    const provider = new MockEmailProvider();
    await provider.send(
      "redos@example.com",
      "redos",
      `${"http://".repeat(100_000)}no-token`,
    );
    const msg = MockEmailInbox.last("redos@example.com");
    expect(msg?.token).toBeUndefined();
    expect(msg?.magicLink).toBeUndefined();
  });

  it("scans many short no-link segments in linear time", async () => {
    const provider = new MockEmailProvider();
    const text = "x ".repeat(100_000);
    await provider.send("segmented@example.com", "No link", text);
    expect(MockEmailInbox.last("segmented@example.com")?.token).toBeUndefined();
  });
});
