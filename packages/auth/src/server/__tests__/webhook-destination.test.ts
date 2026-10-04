import { expect, test } from "bun:test";
import {
  validateWebhookUrl,
  validateWebhookUrlResolved,
} from "../api/services/webhook-url";

test("registration rejects a DNS answer set with any non-public candidate", async () => {
  expect(validateWebhookUrl("https://receiver.example.com")).toBeNull();
  expect(
    await validateWebhookUrlResolved(
      "https://receiver.example.com",
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ],
    ),
  ).toBe("url host must resolve to a public address");
  expect(
    await validateWebhookUrlResolved(
      "https://receiver.example.com",
      async () => [],
    ),
  ).toBe("url host could not be resolved");
});

test("registration preserves globally routable translated IPv4", () => {
  expect(validateWebhookUrl("https://[::ffff:0:808:808]/")).toBeNull();
  expect(validateWebhookUrl("https://[::ffff:0:7f00:1]/")).toBe(
    "url host must be public",
  );
});
