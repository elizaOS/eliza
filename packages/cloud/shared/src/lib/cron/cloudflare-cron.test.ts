/** Verifies the scheduled handler reaches the canonical payment expiry route. */
import { describe, expect, test } from "bun:test";
import { makeCronHandler } from "./cloudflare-cron";

describe("payment-request cron fanout", () => {
  test("dispatches the authenticated canonical expiry route every ten minutes", async () => {
    const requests: Request[] = [];
    let work: Promise<unknown> | undefined;
    const scheduled = makeCronHandler(async (request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });

    await scheduled(
      { cron: "*/10 * * * *", scheduledTime: Date.now() },
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://api.example.test",
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      } as never,
    );
    await work;

    const expiryRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/cron/cleanup-expired-payment-requests",
    );
    expect(expiryRequest?.method).toBe("POST");
    expect(expiryRequest?.headers.get("x-cron-secret")).toBe("cron-secret");
  });
});
