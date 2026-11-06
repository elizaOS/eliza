import { afterEach, expect, spyOn, test } from "bun:test";
import { CloudflareEmailProvider } from "../auth/cloudflare-email-provider";

const recipient = "test@example.org";
const provider = new CloudflareEmailProvider({
  accountId: "a".repeat(32),
  apiToken: "test-token",
  from: "login@example.com",
});

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => fetchSpy?.mockRestore());

test("returns a receipt when Cloudflare queues the exact recipient", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      success: true,
      result: { message_id: "delivery-id", queued: [recipient] },
    }),
  );

  await expect(
    provider.send(recipient, "Sign in", "Code", "<p>Code</p>", {
      replyTo: "support@example.com",
    }),
  ).resolves.toEqual({ provider: "cloudflare", id: "delivery-id" });
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/email/sending/send`,
  );
  expect(init?.redirect).toBe("error");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    to: [recipient],
    from: "login@example.com",
    reply_to: "support@example.com",
  });
});

test.each([
  { message_id: "delivery-id", suppressed_recipients: [recipient] },
  {
    message_id: "delivery-id",
    queued: [recipient],
    permanent_bounces: [recipient],
  },
  { message_id: "delivery-id", delivered: ["different@example.org"] },
  { queued: [recipient] },
])(
  "refuses a success response without recipient acceptance: %j",
  async (result) => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: true, result }),
    );
    await expect(provider.send(recipient, "Sign in", "Code")).rejects.toThrow(
      "Cloudflare Email Sending did not accept recipient",
    );
  },
);
