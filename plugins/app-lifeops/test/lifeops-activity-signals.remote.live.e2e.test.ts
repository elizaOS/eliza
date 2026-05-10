import { expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";

const REMOTE_API_BASE =
  process.env.ELIZA_LIFEOPS_REMOTE_E2E_URL?.trim().replace(/\/+$/, "") ?? "";
const REMOTE_API_TOKEN =
  process.env.ELIZA_API_TOKEN?.trim() ??
  process.env.ELIZA_LIFEOPS_REMOTE_E2E_TOKEN?.trim() ??
  "";
const CAN_RUN_REMOTE_E2E =
  REMOTE_API_BASE.length > 0 && REMOTE_API_TOKEN.length > 0;

type JsonResponse = {
  data: Record<string, unknown>;
  status: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function requestJson(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<JsonResponse> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${REMOTE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body && method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${REMOTE_API_BASE}${path}`, init);
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object from ${method} ${path}`);
  }
  return {
    status: response.status,
    data: parsed,
  };
}

describeIf(CAN_RUN_REMOTE_E2E)(
  "Live E2E: remote LifeOps mobile activity signals",
  () => {
    it("accepts mobile device and health signals from a remote client and exposes them to the agent", async () => {
      const testRunId = `remote-mobile-e2e-${Date.now()}`;
      const sinceAt = new Date(Date.now() - 1_000).toISOString();

      const deviceResponse = await requestJson(
        "POST",
        "/api/lifeops/activity-signals",
        {
          source: "mobile_device",
          platform: "mobile_app",
          state: "active",
          observedAt: new Date().toISOString(),
          idleState: "unlocked",
          idleTimeSeconds: 0,
          onBattery: true,
          metadata: {
            testRunId,
            deviceKind: "iphone",
          },
        },
      );
      expect(deviceResponse.status).toBe(201);

      const healthResponse = await requestJson(
        "POST",
        "/api/lifeops/activity-signals",
        {
          source: "mobile_health",
          platform: "mobile_app",
          state: "active",
          observedAt: new Date().toISOString(),
          health: {
            source: "healthkit",
            permissions: {
              sleep: "authorized",
              biometrics: "not_determined",
            },
            sleep: {
              available: true,
              isSleeping: false,
              asleepAt: "2026-04-20T06:30:00.000Z",
              awakeAt: "2026-04-20T14:00:00.000Z",
              durationMinutes: 450,
              stage: "asleep",
            },
            biometrics: {
              sampleAt: null,
              heartRateBpm: null,
              restingHeartRateBpm: null,
              heartRateVariabilityMs: null,
              respiratoryRate: null,
              bloodOxygenPercent: null,
            },
            warnings: [],
          },
          metadata: {
            testRunId,
            deviceKind: "iphone",
          },
        },
      );
      expect(healthResponse.status).toBe(201);

      const listed = await requestJson(
        "GET",
        `/api/lifeops/activity-signals?sinceAt=${encodeURIComponent(sinceAt)}&limit=25`,
      );
      expect(listed.status).toBe(200);
      expect(Array.isArray(listed.data.signals)).toBe(true);
      const signals = Array.isArray(listed.data.signals)
        ? listed.data.signals.filter(isRecord)
        : [];
      const matchingSources = new Set(
        signals
          .filter((signal) => {
            const metadata = signal.metadata;
            return isRecord(metadata) && metadata.testRunId === testRunId;
          })
          .map((signal) => signal.source),
      );
      expect(matchingSources.has("mobile_device")).toBe(true);
      expect(matchingSources.has("mobile_health")).toBe(true);

      const overview = await requestJson("GET", "/api/lifeops/overview");
      expect(overview.status).toBe(200);
      expect(overview.data.summary).toBeTruthy();
      expect(overview.data.schedule).toBeTruthy();
    });
  },
);
