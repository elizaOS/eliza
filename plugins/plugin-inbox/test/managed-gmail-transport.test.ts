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
