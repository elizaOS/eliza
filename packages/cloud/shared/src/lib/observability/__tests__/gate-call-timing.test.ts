import { describe, expect, test } from "bun:test";
import {
  currentGateServerTimings,
  observeCloudRequest,
  observeInferenceDependency,
} from "../cloud-backend-observability";
import { setGatewayPreforwardTelemetryHeaders } from "../http-telemetry";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chatRequest<T>(fn: () => Promise<T>): Promise<T> {
  return observeCloudRequest(
    {
      id: crypto.randomUUID(),
      traceId: "a".repeat(32),
      method: "POST",
      path: "/api/v1/chat/completions",
    },
    async () => ({ result: await fn(), status: 200 }),
  );
}

describe("Durable Object call timing", () => {
  test("splits entry, handler and after-handler time into Server-Timing", async () => {
    const headers = await chatRequest(async () => {
      await observeInferenceDependency(
        "durable_object",
        "/rate-limit",
        () => sleep(40),
        () => ({ entryMs: 10, handlerMs: 5, cold: true }),
      );
      const out = new Headers();
      setGatewayPreforwardTelemetryHeaders(out, "b".repeat(32), {
        totalMs: 50,
        authMs: 1,
        middleMs: 45,
        reserveMs: 2,
        setupMs: 2,
      });
      return out;
    });
    const timing = headers.get("Server-Timing") ?? "";
    expect(timing).toMatch(/gate_rate-limit;dur=[\d.]+;desc="cold"/);
    expect(timing).toContain("gate_rate-limit_entry;dur=10");
    expect(timing).toContain("gate_rate-limit_handler;dur=5");
    const total = Number(/gate_rate-limit;dur=([\d.]+)/.exec(timing)?.[1]);
    const after = Number(/gate_rate-limit_after;dur=([\d.]+)/.exec(timing)?.[1]);
    expect(after).toBeCloseTo(total - 15, 1);
  });

  test("drops an entry time that clock skew puts outside the call", async () => {
    const timings = await chatRequest(async () => {
      await observeInferenceDependency(
        "durable_object",
        "/lease-dispatched",
        () => sleep(5),
        () => ({ entryMs: -3, handlerMs: 1, cold: false }),
      );
      await observeInferenceDependency(
        "durable_object",
        "/settle",
        () => sleep(5),
        () => ({ entryMs: 60_000, handlerMs: 1 }),
      );
      return currentGateServerTimings().map((timing) => timing.name);
    });
    expect(timings).toEqual([
      "gate_lease-dispatched",
      "gate_lease-dispatched_handler",
      "gate_settle",
      "gate_settle_handler",
    ]);
  });

  test("records nothing outside an inference request", async () => {
    await observeInferenceDependency(
      "durable_object",
      "/rate-limit",
      async () => undefined,
      () => ({ entryMs: 1, handlerMs: 1 }),
    );
    expect(currentGateServerTimings()).toEqual([]);
  });
});
