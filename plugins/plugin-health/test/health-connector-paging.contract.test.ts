/**
 * Withings and Strava list endpoints are paged. Recorded API envelopes are
 * replayed through the real connector sync: Withings returns `more`/`offset`
 * on its list actions, and Strava returns at most 200 activities per page.
 * Every page must reach the synced payload.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncHealthConnectorData } from "../src/health-bridge/health-connectors.js";
import type { StoredHealthConnectorToken } from "../src/health-bridge/health-oauth.js";

function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, `../src/health-bridge/__fixtures__/${name}`),
      "utf8",
    ),
  );
}

const withings = fixture("withings.recorded.json");
const strava = fixture("strava.recorded.json");

const withingsToken: StoredHealthConnectorToken = {
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

const stravaToken: StoredHealthConnectorToken = {
  provider: "strava",
  agentId: "agent-strava",
  side: "owner",
  mode: "local",
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://127.0.0.1/redirect",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  tokenType: "Bearer",
  grantedScopes: ["read", "activity:read_all"],
  expiresAt: null,
  identity: {},
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("health connector paging", () => {
  it("reads every Withings getmeas page", async () => {
    const [group] = withings.measures.body.measuregrps;
    const laterGroup = { ...group, grpid: 770110202, date: group.date + 3_600 };
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v2/measure")) return jsonResponse(withings.activity);
        if (url.includes("/v2/sleep")) return jsonResponse(withings.sleep);
        if (url.includes("/measure")) {
          const offset = new URLSearchParams(String(init?.body)).get("offset");
          return jsonResponse({
            status: 0,
            body:
              offset === null
                ? {
                    ...withings.measures.body,
                    measuregrps: [group],
                    more: 1,
                    offset: 1,
                  }
                : {
                    ...withings.measures.body,
                    measuregrps: [laterGroup],
                    more: 0,
                  },
          });
        }
        throw new Error(`unexpected Withings fetch: ${url}`);
      },
    );

    const payload = await syncHealthConnectorData({
      token: withingsToken,
      grantId: "grant-withings",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
    });

    expect(
      payload.samples
        .filter((sample) => sample.metric === "weight_kg")
        .map((sample) => sample.sourceExternalId),
    ).toEqual(["770110201:withings:weight_kg", "770110202:withings:weight_kg"]);
  });

  it("reads every Strava activities page", async () => {
    const [activity] = strava.activities;
    const activities = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...activity, id: from + i }));
    const pages: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/athlete/activities")) {
        const page = url.searchParams.get("page") ?? "1";
        pages.push(page);
        return jsonResponse(
          page === "1" ? activities(1, 200) : activities(201, 1),
        );
      }
      if (url.pathname.endsWith("/athlete"))
        return jsonResponse(strava.athlete);
      throw new Error(`unexpected Strava fetch: ${url}`);
    });

    const payload = await syncHealthConnectorData({
      token: stravaToken,
      grantId: "grant-strava",
      startDate: "2026-05-01",
      endDate: "2026-05-02",
    });

    expect(pages).toEqual(["1", "2"]);
    expect(payload.workouts).toHaveLength(201);
  });
});
