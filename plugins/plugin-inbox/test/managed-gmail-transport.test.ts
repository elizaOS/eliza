import { expect, it } from "vitest";
import { managedGmailHostTransport } from "../src/inbox/managed-gmail-transport.ts";

it("an unavailable operation route does not claim the Google account is disconnected", async () => {
  const call = managedGmailHostTransport(
    "http://127.0.0.1:5209/__alpha-owner-gmail",
    "a".repeat(64),
    async () =>
      Response.json({ reason: "provider-route-unavailable" }, { status: 409 }),
  );
  await expect(
    call!({ send: { operation: "receipt", id: "synthetic" } }),
  ).rejects.toThrow("does not mean the Google account is disconnected");
});

it.each([
  ["signed-out", "Sign in to Eliza Cloud"],
  ["no-account", "Gmail isn't connected"],
  ["multiple-accounts", "More than one Google account"],
  ["permission-needed", "Allow it in Settings"],
  ["changes-off", "Gmail changes are off in Settings. Nothing was changed."],
  ["mailbox-changed", "Search again"],
  ["invalid-request", "Nothing was changed"],
  ["request-too-large", "Nothing was changed"],
  ["result-too-large", "Narrow the date range"],
  ["outcome-unconfirmed", "no outcome is confirmed"],
  ["something-new", "no outcome is confirmed"],
  [undefined, "no outcome is confirmed"],
])("host refusal %s maps to its message", async (reason, text) => {
  const call = managedGmailHostTransport(
    "http://127.0.0.1:5209/__alpha-owner-gmail",
    "a".repeat(64),
    async () => Response.json({ reason, error: "raw" }, { status: 409 }),
  );
  const failure = await call?.({ limit: 1 }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "MANAGED_GMAIL_HOST_UNAVAILABLE" });
  expect(String((failure as Error).message)).toContain(text);
});

it("a definite refusal never claims an unconfirmed outcome", async () => {
  for (const reason of ["changes-off", "invalid-request", "no-account"]) {
    const call = managedGmailHostTransport(
      "http://127.0.0.1:5209/__alpha-owner-gmail",
      "a".repeat(64),
      async () => Response.json({ reason }, { status: 409 }),
    );
    await expect(call?.({ limit: 1 })).rejects.not.toThrow("no outcome");
  }
});
