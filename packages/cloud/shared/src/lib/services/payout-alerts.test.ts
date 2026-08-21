/**
 * Exercises payout-alert delivery through a deterministic mocked transport,
 * including endpoint policy, redirect and body bounds, cancellation, response
 * disposal, and the real Slack and PagerDuty request shapes.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { alertFetch, PayoutAlertsService } from "./payout-alerts";

const realFetch = globalThis.fetch;
const slackWebhookEnv = "REDEMPTION_ALERT_SLACK_WEBHOOK";
const pagerDutyKeyEnv = "REDEMPTION_ALERT_PAGERDUTY_KEY";
const previousSlackWebhook = process.env[slackWebhookEnv];
const previousPagerDutyKey = process.env[pagerDutyKeyEnv];

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousSlackWebhook === undefined) delete process.env[slackWebhookEnv];
  else process.env[slackWebhookEnv] = previousSlackWebhook;
  if (previousPagerDutyKey === undefined) delete process.env[pagerDutyKeyEnv];
  else process.env[pagerDutyKeyEnv] = previousPagerDutyKey;
});

describe("alertFetch", () => {
  test("aborts a hung alert hop at the configured timeout", async () => {
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 25),
    ).rejects.toThrow(/aborted/i);
  });

  test("keeps the deadline when a caller supplies a non-firing signal", async () => {
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const controller = new AbortController();
    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", { signal: controller.signal }, 25),
    ).rejects.toThrow(/aborted/i);
  });

  test("propagates caller cancellation through the composed signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const controller = new AbortController();
    await alertFetch("https://events.pagerduty.com/v2/enqueue", {
      signal: controller.signal,
    });
    controller.abort();

    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("rejects unapproved endpoints and oversized bodies before fetch", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      alertFetch("http://169.254.169.254/latest/meta-data", { method: "POST" }),
    ).rejects.toThrow(/approved Slack or PagerDuty URL/);
    await expect(
      alertFetch("https://hooks.slack.com.evil.example/services/T/B/secret", { method: "POST" }),
    ).rejects.toThrow(/approved Slack or PagerDuty URL/);
    await expect(
      alertFetch("https://hooks.slack.com/services/T/B/secret", {
        method: "POST",
        body: "x".repeat(64 * 1024 + 1),
      }),
    ).rejects.toThrow(/64 KiB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("contains transport failures so alert diagnostics cannot stop payouts", async () => {
    process.env[slackWebhookEnv] = "https://hooks.slack.com/services/T/B/secret";
    process.env[pagerDutyKeyEnv] = "pager-key";
    const fetchMock = mock(async () => {
      throw new Error("transport unavailable");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      new PayoutAlertsService().sendAlert({
        severity: "critical",
        title: "Emergency Pause",
        message: "Payouts paused",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("pins real Slack and PagerDuty shapes and releases both responses", async () => {
    process.env[slackWebhookEnv] = "https://hooks.slack.com/services/T/B/secret";
    process.env[pagerDutyKeyEnv] = "pager-key";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let cancelledResponses = 0;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input.toString(), init });
      return new Response(
        new ReadableStream({
          cancel() {
            cancelledResponses += 1;
          },
        }),
        { status: 202 },
      );
    }) as typeof fetch;

    await new PayoutAlertsService().sendAlert({
      severity: "critical",
      title: "Velocity Limit",
      message: "Payouts paused",
      details: { count: 10 },
      timestamp: new Date("2026-08-21T12:00:00.000Z"),
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://hooks.slack.com/services/T/B/secret",
      "https://events.pagerduty.com/v2/enqueue",
    ]);
    expect(requests.every(({ init }) => init?.redirect === "error")).toBe(true);
    expect(requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      text: expect.stringContaining("Velocity Limit"),
      attachments: [{ text: "Payouts paused", fields: [{ title: "count", value: "10" }] }],
    });
    expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
      routing_key: "pager-key",
      event_action: "trigger",
      payload: { summary: "[elizaOS Payout] Velocity Limit", severity: "critical" },
    });
    expect(cancelledResponses).toBe(2);
  });
});
