/**
 * Exercises payout-alert delivery through a deterministic mocked transport,
 * including endpoint policy, redirect and body bounds, cancellation, response
 * disposal, and the real Slack and PagerDuty request shapes.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { type AlertTransport, alertFetch, PayoutAlertsService } from "./payout-alerts";

const slackWebhookEnv = "REDEMPTION_ALERT_SLACK_WEBHOOK";
const pagerDutyKeyEnv = "REDEMPTION_ALERT_PAGERDUTY_KEY";
const previousSlackWebhook = process.env[slackWebhookEnv];
const previousPagerDutyKey = process.env[pagerDutyKeyEnv];

afterEach(() => {
  if (previousSlackWebhook === undefined) delete process.env[slackWebhookEnv];
  else process.env[slackWebhookEnv] = previousSlackWebhook;
  if (previousPagerDutyKey === undefined) delete process.env[pagerDutyKeyEnv];
  else process.env[pagerDutyKeyEnv] = previousPagerDutyKey;
});

describe("alertFetch", () => {
  test("does not dispatch a pre-aborted request", async () => {
    const transport = mock(async () => new Response(null, { status: 204 }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      alertFetch(
        "https://events.pagerduty.com/v2/enqueue",
        { signal: controller.signal },
        25,
        transport as AlertTransport,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
  });

  test("aborts a hung alert hop at the configured timeout", async () => {
    const transport = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as AlertTransport;

    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 25, transport),
    ).rejects.toThrow(/aborted/i);
  });

  test("keeps the deadline when a caller supplies a non-firing signal", async () => {
    const transport = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as AlertTransport;

    const controller = new AbortController();
    await expect(
      alertFetch(
        "https://events.pagerduty.com/v2/enqueue",
        { signal: controller.signal },
        25,
        transport,
      ),
    ).rejects.toThrow(/aborted/i);
  });

  test("enforces the deadline when the transport ignores its signal", async () => {
    const transport = mock(() => new Promise<Response>(() => undefined)) as AlertTransport;

    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 25, transport),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("clears the owned deadline after a fast response", async () => {
    let receivedSignal: AbortSignal | undefined;
    const transport = mock(async (_input: string, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Response(null, { status: 204 });
    }) as AlertTransport;

    await alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 25, transport);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("propagates caller cancellation through the composed signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const transport = mock(async (_input: string, init?: RequestInit) => {
      receivedSignal = init?.signal;
      return new Response(null, { status: 204 });
    }) as AlertTransport;

    const controller = new AbortController();
    await alertFetch(
      "https://events.pagerduty.com/v2/enqueue",
      { signal: controller.signal },
      undefined,
      transport,
    );
    controller.abort();

    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("rejects unapproved endpoints and oversized bodies before fetch", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 204 }));
    const transport = fetchMock as AlertTransport;

    await expect(
      alertFetch(
        "http://169.254.169.254/latest/meta-data",
        { method: "POST" },
        undefined,
        transport,
      ),
    ).rejects.toThrow(/approved Slack or PagerDuty URL/);
    await expect(
      alertFetch(
        "https://hooks.slack.com.evil.example/services/T/B/secret",
        { method: "POST" },
        undefined,
        transport,
      ),
    ).rejects.toThrow(/approved Slack or PagerDuty URL/);
    await expect(
      alertFetch(
        "https://hooks.slack.com/services/T/B/secret",
        {
          method: "POST",
          body: "x".repeat(64 * 1024 + 1),
        },
        undefined,
        transport,
      ),
    ).rejects.toThrow(/64 KiB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects redirects and releases their response body", async () => {
    let cancelled = 0;
    const transport = mock(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled += 1;
            },
          }),
          { status: 302, headers: { location: "https://example.com/capture" } },
        ),
    ) as AlertTransport;

    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, undefined, transport),
    ).rejects.toThrow(/redirected with status 302/);
    expect(cancelled).toBe(1);
  });

  test("contains transport failures so alert diagnostics cannot stop payouts", async () => {
    process.env[slackWebhookEnv] = "https://hooks.slack.com/services/T/B/secret";
    process.env[pagerDutyKeyEnv] = "pager-key";
    const fetchMock = mock(async () => {
      throw new Error("transport unavailable");
    });

    await expect(
      new PayoutAlertsService(fetchMock as AlertTransport).sendAlert({
        severity: "critical",
        title: "Emergency Pause",
        message: "Payouts paused",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a hostile Slack cancellation cannot suppress PagerDuty or completion", async () => {
    process.env[slackWebhookEnv] = "https://hooks.slack.com/services/T/B/secret";
    process.env[pagerDutyKeyEnv] = "pager-key";
    const requests: string[] = [];
    const transport = mock(async (input: string) => {
      requests.push(input);
      return new Response(
        new ReadableStream({
          cancel: () =>
            input.includes("slack") ? new Promise<void>(() => undefined) : Promise.resolve(),
        }),
        { status: 202 },
      );
    }) as AlertTransport;

    await expect(
      new PayoutAlertsService(transport).sendAlert({
        severity: "critical",
        title: "Emergency Pause",
        message: "Payouts paused",
      }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      "https://hooks.slack.com/services/T/B/secret",
      "https://events.pagerduty.com/v2/enqueue",
    ]);
  });

  test("a rejecting cancellation does not replace the selected response outcome", async () => {
    const transport = mock(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => Promise.reject(new Error("cleanup failed")),
          }),
          { status: 302 },
        ),
    ) as AlertTransport;

    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 25, transport),
    ).rejects.toThrow("redirected with status 302");
  });

  test("pins real Slack and PagerDuty shapes and releases both responses", async () => {
    process.env[slackWebhookEnv] = "https://hooks.slack.com/services/T/B/secret";
    process.env[pagerDutyKeyEnv] = "pager-key";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let cancelledResponses = 0;
    const transport = mock(async (input: string, init?: RequestInit) => {
      requests.push({ url: input, init });
      return new Response(
        new ReadableStream({
          cancel() {
            cancelledResponses += 1;
          },
        }),
        { status: 202 },
      );
    }) as AlertTransport;

    await new PayoutAlertsService(transport).sendAlert({
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
    expect(requests.every(({ init }) => init?.redirect === "manual")).toBe(true);
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
