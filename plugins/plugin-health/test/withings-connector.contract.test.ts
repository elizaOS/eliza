/**
 * Withings connector contract tests replay recorded API envelopes through the
 * actual normalizer to pin real field-name mappings without network access.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../src/health-bridge/__fixtures__/withings.recorded.json",
    ),
    "utf8",
  ),
) as {
  activity: Record<string, unknown>;
  sleep: Record<string, unknown>;
  measures: Record<string, unknown>;
};

const token: StoredHealthConnectorToken = {
  provider: "withings",
  agentId: "agent-withings",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: [
    "user.info",
    "user.metrics",
    "user.activity",
    "user.sleepevents",
  ],
  expiresAt: null,
  identity: { withings_user_id: "wu-1" },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    // Order matters: /v2/measure (activity) before the bare /measure (getmeas).
    if (url.includes("/v2/measure")) {
      return jsonResponse(recorded.activity);
    }
    if (url.includes("/v2/sleep")) {
      return jsonResponse(recorded.sleep);
    }
    if (url.includes("/measure")) {
      return jsonResponse(recorded.measures);
    }
    throw new Error(`unexpected Withings fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Withings connector — recorded real API contract", () => {
  it("normalizes the real Withings response shapes into a contract-shaped payload", async () => {
    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-withings",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    // Withings keeps identity as the stored token identity (no profile fetch).
    expect(payload.identity).toEqual({ withings_user_id: "wu-1" });
    expect(payload.cursor).toBeNull();
    // Withings syncWithings emits no workouts.
    expect(payload.workouts).toEqual([]);

    const dayAt = "2026-05-01T12:00:00.000Z";

    // --- getactivity samples (id is the YYYY-MM-DD date) ---
    const steps = payload.samples.find((s) => s.metric === "steps");
    expect(steps?.value).toBe(11842);
    expect(steps?.unit).toBe("count");
    expect(steps?.startAt).toBe(dayAt);
    expect(steps?.sourceExternalId).toBe("2026-05-01:withings:steps");

    // .active is seconds (moderate 28 + intense 41 = 69 s) -> 1.15 min.
    const activeMinutes = payload.samples.find(
      (s) => s.metric === "active_minutes",
    );
    expect(activeMinutes?.value).toBeCloseTo(69 / 60);
    expect(activeMinutes?.unit).toBe("min");

    // totalcalories preferred over calories.
    const calories = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:calories",
    );
    expect(calories?.value).toBe(2415);
    expect(calories?.unit).toBe("kcal");

    // .distance meters -> distance_meters verbatim.
    const distance = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:distance_meters",
    );
    expect(distance?.value).toBe(8520);
    expect(distance?.unit).toBe("m");

    // .hr_average -> heart_rate; .hr_resting -> resting_heart_rate.
    const hr = payload.samples.find(
      (s) => s.sourceExternalId === "2026-05-01:withings:heart_rate",
    );
    expect(hr?.value).toBe(78);
    const resting = payload.samples.find(
      (s) => s.metric === "resting_heart_rate",
    );
    expect(resting?.value).toBe(54);

    // --- getsummary sleep episode ---
    const sleepHours = payload.samples.find((s) => s.metric === "sleep_hours");
    // total_sleep_time 27360 s -> 7.6 h.
    expect(sleepHours?.value).toBe(27360 / 3600);
    expect(sleepHours?.unit).toBe("h");
    // Overnight sleep starts 2026-04-30T23:48Z; Withings `date` (and the
    // episode) is the wake date 2026-05-01. Daily summaries group by localDate.
    expect(sleepHours?.startAt).toBe("2026-04-30T23:48:00.000Z");
    expect(sleepHours?.localDate).toBe("2026-05-01");

    expect(payload.sleepEpisodes).toHaveLength(1);
    const ep = payload.sleepEpisodes[0];
    if (!ep) throw new Error("missing sleep episode");

    // series[].id -> sourceExternalId (stringified).
    expect(ep.sourceExternalId).toBe("920211001");
    expect(typeof ep.sourceExternalId).toBe("string");
    expect(ep.provider).toBe("withings");
    expect(ep.agentId).toBe("agent-withings");
    expect(ep.grantId).toBe("grant-withings");
    // startdate/enddate UNIX seconds -> ISO startAt/endAt.
    expect(ep.startAt).toBe("2026-04-30T23:48:00.000Z");
    expect(ep.endAt).toBe("2026-05-01T07:54:00.000Z");
    // .date -> localDate; timezone passes through.
    expect(ep.localDate).toBe("2026-05-01");
    expect(ep.timezone).toBe("Europe/London");
    // Withings summary is always treated as the main sleep; sleepType marker.
    expect(ep.isMainSleep).toBe(true);
    expect(ep.sleepType).toBe("summary");
    // data.total_sleep_time -> durationSeconds.
    expect(ep.durationSeconds).toBe(27360);
    // timeInBedSeconds = wakeupduration (1800) + durationSeconds (27360).
    expect(ep.timeInBedSeconds).toBe(1800 + 27360);
    // durationtosleep -> latencySeconds; wakeupduration -> awakeSeconds.
    expect(ep.latencySeconds).toBe(540);
    expect(ep.awakeSeconds).toBe(1800);
    // *duration -> {light,deep,rem}SleepSeconds.
    expect(ep.lightSleepSeconds).toBe(15120);
    expect(ep.deepSleepSeconds).toBe(6480);
    expect(ep.remSleepSeconds).toBe(5760);
    // Withings summary has no efficiency/score in this normalizer.
    expect(ep.efficiency).toBeNull();
    expect(ep.sleepScore).toBeNull();
    expect(ep.readinessScore).toBeNull();
    // biometrics map across.
    expect(ep.averageHeartRate).toBe(53);
    expect(ep.lowestHeartRate).toBe(47);
    expect(ep.respiratoryRate).toBe(14);
    expect(ep.metadata.source).toBe("withings_sleep_summary");

    // --- getmeas measure samples (value * 10^unit by `type`) ---
    const weight = payload.samples.find((s) => s.metric === "weight_kg");
    // type 1 weight: 61200 * 10^-3 = 61.2 kg.
    expect(weight?.value).toBe(61.2);
    expect(weight?.unit).toBe("kg");
    expect(weight?.sourceExternalId).toBe("770110201:withings:weight_kg");
    expect(weight?.metadata.withingsType).toBe(1);

    // type 11 heart_rate: 540 * 10^-1 = 54 bpm.
    const measHr = payload.samples.find(
      (s) => s.sourceExternalId === "770110201:withings:heart_rate",
    );
    expect(measHr?.value).toBe(54);
    expect(measHr?.unit).toBe("bpm");

    // type 54 blood_oxygen_percent: 982 * 10^-1 = 98.2 %.
    const spo2 = payload.samples.find(
      (s) => s.metric === "blood_oxygen_percent",
    );
    expect(spo2?.value).toBeCloseTo(98.2, 5);
    expect(spo2?.unit).toBe("%");

    // type 71 body_temperature_celsius: 3651 * 10^-2 = 36.51 C.
    const temp = payload.samples.find(
      (s) => s.metric === "body_temperature_celsius",
    );
    expect(temp?.value).toBeCloseTo(36.51, 5);
    expect(temp?.unit).toBe("C");

    // type 73 is Skin Temperature (celsius) in the Withings API, not heart
    // rate variability. No health metric holds it, so it adds no sample.
    expect(
      payload.samples.some((s) => s.metric === "heart_rate_variability"),
    ).toBe(false);

    // type 10 systolic / type 9 diastolic (unit 0 -> verbatim).
    const systolic = payload.samples.find(
      (s) => s.metric === "blood_pressure_systolic",
    );
    expect(systolic?.value).toBe(78);
    expect(systolic?.unit).toBe("mmHg");
    const diastolic = payload.samples.find(
      (s) => s.metric === "blood_pressure_diastolic",
    );
    expect(diastolic?.value).toBe(52);
    expect(diastolic?.unit).toBe("mmHg");

    // Every sample carries the required contract fields.
    for (const s of payload.samples) {
      expect(typeof s.id).toBe("string");
      expect(s.provider).toBe("withings");
      expect(typeof s.value).toBe("number");
      expect(Number.isFinite(s.value)).toBe(true);
      expect(typeof s.startAt).toBe("string");
      if (s.metric === "sleep_hours") {
        expect(s.localDate).toBe("2026-05-01");
      } else {
        expect(s.localDate).toBe(s.startAt.slice(0, 10));
      }
    }
  });

  it("files a weigh-in under the user's local day from the measures timezone", async () => {
    // 2026-10-14T22:30:00Z is 07:30 on 2026-10-15 in Tokyo.
    const measures = structuredClone(recorded.measures) as {
      body: { timezone: string; measuregrps: Array<{ date: number }> };
    };
    measures.body.timezone = "Asia/Tokyo";
    const tokyoMorning = Date.parse("2026-10-14T22:30:00Z") / 1000;
    for (const group of measures.body.measuregrps) group.date = tokyoMorning;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/v2/measure")) return jsonResponse(recorded.activity);
      if (url.includes("/v2/sleep")) return jsonResponse(recorded.sleep);
      if (url.includes("/measure")) return jsonResponse(measures);
      throw new Error(`unexpected Withings fetch: ${url}`);
    });

    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-withings",
      startDate: "2026-10-14",
      endDate: "2026-10-15",
    });

    const weight = payload.samples.find((s) => s.metric === "weight_kg");
    expect(weight?.startAt).toBe("2026-10-14T22:30:00.000Z");
    expect(weight?.localDate).toBe("2026-10-15");
  });

  it("reads every page of the activity, sleep, and measure lists", async () => {
    // Withings answers `more` with the next `offset` when a list holds more
    // rows than one page. Reading page one only stores a partial window and
    // still reports a successful sync.
    const pageOneActivity = recorded.activity as {
      body: { activities: Array<Record<string, unknown>> };
    };
    const pageOneSleep = recorded.sleep as {
      body: { series: Array<Record<string, unknown>> };
    };
    const pageOneMeasures = recorded.measures as {
      body: {
        updatetime: number;
        timezone: string;
        measuregrps: Array<Record<string, unknown>>;
      };
    };
    const pageTwoActivity = {
      date: "2026-05-02",
      timezone: "Europe/London",
      steps: 4321,
    };
    const pageTwoSleep = {
      id: 920211002,
      timezone: "Europe/London",
      startdate: 1777679280,
      enddate: 1777708440,
      date: "2026-05-02",
      data: { total_sleep_time: 25200 },
    };
    const pageTwoMeasure = {
      grpid: 770110202,
      date: 1777700000,
      measures: [{ value: 61300, type: 1, unit: -3 }],
    };
    const requested: Record<string, Array<string | null>> = {
      "/v2/measure": [],
      "/v2/sleep": [],
      "/measure": [],
    };
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const form = new URLSearchParams(String(init?.body ?? ""));
        const offset = form.get("offset");
        requested[url.pathname]?.push(offset);
        const secondPage = offset !== null;
        if (url.pathname === "/v2/measure") {
          return jsonResponse({
            status: 0,
            body: {
              activities: [
                secondPage
                  ? pageTwoActivity
                  : pageOneActivity.body.activities[0],
              ],
              more: secondPage ? 0 : 1,
              offset: secondPage ? 0 : 1,
            },
          });
        }
        if (url.pathname === "/v2/sleep") {
          return jsonResponse({
            status: 0,
            body: {
              series: secondPage ? [pageTwoSleep] : pageOneSleep.body.series,
              more: secondPage ? 0 : 1,
              offset: secondPage ? 0 : 1,
            },
          });
        }
        if (url.pathname === "/measure") {
          return jsonResponse({
            status: 0,
            body: {
              updatetime: pageOneMeasures.body.updatetime,
              timezone: pageOneMeasures.body.timezone,
              measuregrps: secondPage
                ? [pageTwoMeasure]
                : pageOneMeasures.body.measuregrps,
              more: secondPage ? 0 : 1,
              offset: secondPage ? 0 : 7,
            },
          });
        }
        throw new Error(`unexpected Withings fetch: ${url}`);
      },
    );

    const payload = await syncHealthConnectorData({
      token,
      grantId: "grant-withings",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    expect(requested["/v2/measure"]).toEqual([null, "1"]);
    expect(requested["/v2/sleep"]).toEqual([null, "1"]);
    expect(requested["/measure"]).toEqual([null, "7"]);
    expect(
      payload.samples.find(
        (s) => s.sourceExternalId === "2026-05-02:withings:steps",
      )?.value,
    ).toBe(4321);
    expect(payload.sleepEpisodes.map((ep) => ep.sourceExternalId)).toEqual([
      "920211001",
      "920211002",
    ]);
    const secondPageWeight = payload.samples.find(
      (s) => s.sourceExternalId === "770110202:withings:weight_kg",
    );
    // 61300 * 10^-3 kg, from the second getmeas page.
    expect(secondPageWeight?.value).toBeCloseTo(61.3, 5);
  });
});
