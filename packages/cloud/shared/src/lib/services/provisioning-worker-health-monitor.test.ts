// Exercises provisioning worker health monitor behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it, mock } from "bun:test";
import type { ProvisioningWorkerHealth } from "./provisioning-worker-health";
import {
  alertFetch,
  HEARTBEAT_MAX_AGE_MS,
  isHeartbeatStale,
  monitorProvisioningWorkerHealth,
} from "./provisioning-worker-health-monitor";

const NOW = Date.parse("2026-06-28T00:00:00.000Z");
describe("isHeartbeatStale", () => {
  it("treats a fresh heartbeat as not stale", () => {
    const fresh = new Date(NOW - 1_000).toISOString();
    expect(isHeartbeatStale(fresh, NOW)).toBe(false);
  });

  it("treats a heartbeat older than the max age as stale", () => {
    const old = new Date(NOW - HEARTBEAT_MAX_AGE_MS - 1).toISOString();
    expect(isHeartbeatStale(old, NOW)).toBe(true);
  });

  it("treats an absent heartbeat as stale", () => {
    expect(isHeartbeatStale(undefined, NOW)).toBe(true);
  });

  it("treats an unparseable heartbeat as stale", () => {
    expect(isHeartbeatStale("not-a-date", NOW)).toBe(true);
  });

  it("does not flag a heartbeat exactly at the max age", () => {
    const edge = new Date(NOW - HEARTBEAT_MAX_AGE_MS).toISOString();
    expect(isHeartbeatStale(edge, NOW)).toBe(false);
  });
});

function captureAlerts() {
  const alerts: { title: string; details: Record<string, unknown> }[] = [];
  return {
    alerts,
    alert: async (a: { title: string; details: Record<string, unknown> }) => {
      alerts.push(a);
    },
  };
}

describe("monitorProvisioningWorkerHealth", () => {
  it("is healthy and silent when the daemon is not required", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = { ok: true, required: false };
    const result = await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {},
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(true);
    expect(result.stale).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("is healthy and silent on a fresh heartbeat", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(NOW - 1_000).toISOString(),
    };
    const result = await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {},
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(true);
    expect(result.stale).toBe(false);
    expect(alerts).toHaveLength(0);
  });

  it("is unhealthy and alerts when the heartbeat is absent (gate failed closed)", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_UNHEALTHY",
      error: "Provisioning worker has not reported a heartbeat in the last 60 seconds.",
    };
    const result = await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {},
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.code).toBe("PROVISIONING_WORKER_UNHEALTHY");
  });

  it("is unhealthy and alerts when a present heartbeat is stale", async () => {
    const { alerts, alert } = captureAlerts();
    const health: ProvisioningWorkerHealth = {
      ok: true,
      required: true,
      lastHeartbeatAt: new Date(NOW - HEARTBEAT_MAX_AGE_MS - 10_000).toISOString(),
    };
    const result = await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {},
      check: async () => health,
      alert,
      now: () => NOW,
    });
    expect(result.healthy).toBe(false);
    expect(result.stale).toBe(true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.code).toBe("PROVISIONING_WORKER_STALE_HEARTBEAT");
  });

  // #16160: this per-minute monitor doubles as the cloud-api DB heartbeat
  // writer the provisioning-worker daemon reads to tell idle from split — it
  // must stamp the heartbeat on EVERY invocation, including the not-required
  // early return (the daemon may be optional while the DB signal still matters).
  it("stamps the DB heartbeat on every invocation, even when the daemon is not required", async () => {
    let writes = 0;
    const health: ProvisioningWorkerHealth = { ok: true, required: false };
    await monitorProvisioningWorkerHealth({
      writeDbHeartbeat: async () => {
        writes += 1;
      },
      check: async () => health,
      alert: async () => {},
      now: () => NOW,
    });
    expect(writes).toBe(1);
  });

  it("sendProvisioningWorkerAlert posts to every configured channel and resolves without any", async () => {
    const { sendProvisioningWorkerAlert } = await import("./provisioning-worker-health-monitor");
    const prevSlack = process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
    const prevPd = process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
    const posted: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (url: string, init?: RequestInit) => {
      posted.push({ url, init });
      return new Response("ok");
    };
    try {
      // No channels configured: structured log only, no fetch, no throw.
      delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
      delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
      await sendProvisioningWorkerAlert(
        { title: "t", message: "m", details: { code: "TEST" } },
        { transport },
      );
      expect(posted).toHaveLength(0);

      // Both channels configured: one POST each (Slack webhook + PagerDuty).
      process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = "https://hooks.slack.example/T/B/x";
      process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = "pd-routing-key";
      await sendProvisioningWorkerAlert(
        {
          title: `${"t".repeat(510)}🦊${"t".repeat(1_000)}`,
          message: "m".repeat(10_000),
          details: { code: "TEST", diagnostic: "d".repeat(20_000) },
          dedupKey: "test-dedup",
        },
        { transport },
      );
      expect(posted).toHaveLength(2);
      expect(posted[0]?.url).toBe("https://hooks.slack.example/T/B/x");
      expect(posted[1]?.url).toBe("https://events.pagerduty.com/v2/enqueue");
      for (const post of posted) {
        expect(post.init?.method).toBe("POST");
        expect(post.init?.redirect).toBe("error");
        expect(post.init?.signal).toBeDefined();
        expect(String(post.init?.body).length).toBeLessThan(20_000);
        expect(() => JSON.parse(String(post.init?.body))).not.toThrow();
      }
      const slackBody = JSON.parse(String(posted[0]?.init?.body)) as { text: string };
      expect(slackBody.text.isWellFormed()).toBe(true);
      expect(slackBody.text).not.toContain("�");
    } finally {
      if (prevSlack === undefined) delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
      else process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = prevSlack;
      if (prevPd === undefined) delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
      else process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = prevPd;
    }
  });

  it("preserves repeated DAG references while cutting true cycles", async () => {
    const previous = process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
    process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = "pd-routing-key";
    const posted: RequestInit[] = [];
    const shared = { region: "eu-west", replicas: 2 };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    try {
      const { sendProvisioningWorkerAlert } = await import("./provisioning-worker-health-monitor");
      await sendProvisioningWorkerAlert(
        {
          title: "t",
          message: "m",
          details: { primary: shared, secondary: shared, cycle },
        },
        {
          transport: async (_url, init) => {
            if (init) posted.push(init);
            return new Response("ok");
          },
        },
      );
      const body = JSON.parse(String(posted[0]?.body)) as {
        payload: { custom_details: Record<string, unknown> };
      };
      expect(body.payload.custom_details.primary).toEqual(shared);
      expect(body.payload.custom_details.secondary).toEqual(shared);
      expect(body.payload.custom_details.cycle).toEqual({ self: "[circular]" });
    } finally {
      if (previous === undefined) delete process.env.PROVISIONING_ALERT_PAGERDUTY_KEY;
      else process.env.PROVISIONING_ALERT_PAGERDUTY_KEY = previous;
    }
  });

  it("keeps channel HTTP failures non-fatal after the primary structured alert", async () => {
    const previous = process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
    process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = "https://hooks.slack.example/T/B/x";
    try {
      const { sendProvisioningWorkerAlert } = await import("./provisioning-worker-health-monitor");
      await expect(
        sendProvisioningWorkerAlert(
          { title: "t", message: "m", details: { code: "TEST" } },
          { transport: async () => new Response("down", { status: 503 }) },
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.PROVISIONING_ALERT_SLACK_WEBHOOK;
      else process.env.PROVISIONING_ALERT_SLACK_WEBHOOK = previous;
    }
  });
});

describe("alertFetch — bounded alert hops fail closed and keep caller signals", () => {
  it("aborts a hung alert hop at the configured timeout", async () => {
    const transport = mock(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const start = Date.now();
    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 100, transport),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("composes a caller-provided abort signal with the deadline", async () => {
    let seen: AbortSignal | undefined;
    const transport = mock(async (_input: string, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("{}", { status: 200 });
    });

    const controller = new AbortController();
    await alertFetch(
      "https://events.pagerduty.com/v2/enqueue",
      {
        signal: controller.signal,
      },
      100,
      transport,
    );
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  it("keeps the deadline when a caller signal never fires", async () => {
    const transport = mock(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const caller = new AbortController();
    await expect(
      alertFetch(
        "https://events.pagerduty.com/v2/enqueue",
        { signal: caller.signal },
        100,
        transport,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
  });

  it("still lets the caller abort ahead of the deadline", async () => {
    const transport = mock(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const caller = new AbortController();
    const pending = alertFetch(
      "https://events.pagerduty.com/v2/enqueue",
      { signal: caller.signal },
      1_000,
      transport,
    );
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects non-success responses and cancels their bodies", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const transport = mock(async () => new Response(body, { status: 503 }));
    await expect(
      alertFetch("https://events.pagerduty.com/v2/enqueue", undefined, 100, transport),
    ).rejects.toThrow("HTTP 503");
    expect(cancelled).toBe(true);
  });
});
