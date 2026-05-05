import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  type LifeOpsActivitySignalSource,
  type LifeOpsHealthSignalSource,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS,
  LIFEOPS_PRESENCE_DAY_HEALTH_SIGNALS,
  LIFEOPS_PRESENCE_DAY_REQUIRED_ACTIVITY_SOURCES,
  LIFEOPS_PRESENCE_DAY_REQUIRED_HEALTH_SOURCES,
  LIFEOPS_PRESENCE_DAY_SAMPLES,
  lifeOpsPresenceDayCoverage,
} from "../fixtures/lifeops-presence-day.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PRESENCE_ENV_PATH = path.resolve(
  PROJECT_ROOT,
  "test/mocks/environments/lifeops-presence.json",
);

interface MockoonRoute {
  endpoint: string;
  method: string;
  responses?: { body?: string; statusCode?: number }[];
}

interface MockoonEnvironmentFile {
  name?: string;
  routes?: MockoonRoute[];
}

function readPresenceEnvironment(): MockoonEnvironmentFile {
  return JSON.parse(
    fs.readFileSync(PRESENCE_ENV_PATH, "utf8"),
  ) as MockoonEnvironmentFile;
}

describe("LifeOps presence mock coverage contract", () => {
  it("ships a lifeops-presence mockoon environment with the required awake/asleep routes", () => {
    expect(fs.existsSync(PRESENCE_ENV_PATH)).toBe(true);
    const environment = readPresenceEnvironment();
    expect(environment.name).toBe("LifeOps Presence Signal Sources");
    const routes = environment.routes ?? [];
    expect(routes.length).toBeGreaterThanOrEqual(4);

    const endpoints = routes.map((route) => route.endpoint);
    expect(endpoints).toEqual(
      expect.arrayContaining([
        "__mock/lifeops/presence/healthkit/daily",
        "__mock/lifeops/presence/screentime/daily",
        "__mock/lifeops/presence/desktop/power",
        "__mock/lifeops/presence/calendar/busy",
      ]),
    );

    for (const route of routes) {
      expect(route.method.toLowerCase()).toBe("get");
      const response = route.responses?.[0];
      expect(response).toBeDefined();
      expect(response?.statusCode).toBe(200);
      expect(response?.body).toEqual(expect.any(String));
      expect(() => JSON.parse(response?.body ?? "")).not.toThrow();
    }
  });

  it("emits exactly 24 hourly samples covering the wake/awake/active/idle/sleep transition arc", () => {
    expect(LIFEOPS_PRESENCE_DAY_SAMPLES).toHaveLength(24);
    expect(LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS).toHaveLength(24);

    const transitions = new Set(
      LIFEOPS_PRESENCE_DAY_SAMPLES.map((sample) => sample.transition),
    );
    for (const required of [
      "wake",
      "active",
      "idle",
      "background",
      "locked",
      "sleep",
    ] as const) {
      expect(transitions.has(required)).toBe(true);
    }

    const hours = LIFEOPS_PRESENCE_DAY_SAMPLES.map((sample) => sample.hour);
    expect(hours).toEqual(Array.from({ length: 24 }, (_, index) => index));

    const observedAtTimestamps = LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS.map(
      (signal) => Date.parse(signal.observedAt),
    );
    for (let index = 1; index < observedAtTimestamps.length; index += 1) {
      const previous = observedAtTimestamps[index - 1] ?? 0;
      const current = observedAtTimestamps[index] ?? 0;
      expect(current - previous).toBe(60 * 60 * 1_000);
    }
  });

  it("realizes every LifeOps activity-signal source enum value at least once", () => {
    const coverage = lifeOpsPresenceDayCoverage();
    expect([...coverage.activitySources].sort()).toEqual(
      LIFEOPS_PRESENCE_DAY_REQUIRED_ACTIVITY_SOURCES,
    );

    const requiredSet = new Set<LifeOpsActivitySignalSource>(
      LIFEOPS_ACTIVITY_SIGNAL_SOURCES,
    );
    for (const source of coverage.activitySources) {
      expect(
        requiredSet.has(source),
        `presence-day fixture introduced an unknown activity source: ${source}`,
      ).toBe(true);
    }

    for (const required of LIFEOPS_ACTIVITY_SIGNAL_SOURCES) {
      const matches = LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS.filter(
        (signal) => signal.source === required,
      );
      expect(
        matches.length,
        `LIFEOPS_ACTIVITY_SIGNAL_SOURCES enum value "${required}" has no presence-day fixture entry`,
      ).toBeGreaterThan(0);
    }
  });

  it("realizes every LifeOps health-signal source enum value at least once", () => {
    const coverage = lifeOpsPresenceDayCoverage();
    expect([...coverage.healthSources].sort()).toEqual(
      LIFEOPS_PRESENCE_DAY_REQUIRED_HEALTH_SOURCES,
    );

    const requiredSet = new Set<LifeOpsHealthSignalSource>(
      LIFEOPS_HEALTH_SIGNAL_SOURCES,
    );
    for (const source of coverage.healthSources) {
      expect(
        requiredSet.has(source),
        `presence-day fixture introduced an unknown health source: ${source}`,
      ).toBe(true);
    }

    for (const required of LIFEOPS_HEALTH_SIGNAL_SOURCES) {
      const fixture = LIFEOPS_PRESENCE_DAY_HEALTH_SIGNALS[required];
      expect(
        fixture,
        `LIFEOPS_HEALTH_SIGNAL_SOURCES enum value "${required}" has no health-signal fixture entry`,
      ).toBeDefined();
      expect(fixture.source).toBe(required);
      expect(fixture.permissions.sleep).toBe(true);
      expect(fixture.permissions.biometrics).toBe(true);
    }
  });

  it("produces activity-signal records that conform to the runtime contract shape", () => {
    for (const signal of LIFEOPS_PRESENCE_DAY_ACTIVITY_SIGNALS) {
      expect(signal.id).toMatch(/^presence-day-\d{2}$/);
      expect(signal.agentId.length).toBeGreaterThan(0);
      expect(LIFEOPS_ACTIVITY_SIGNAL_SOURCES).toContain(signal.source);
      expect(["active", "idle", "background", "locked", "sleeping"]).toContain(
        signal.state,
      );
      expect(Number.isFinite(Date.parse(signal.observedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(signal.createdAt))).toBe(true);
      if (signal.health !== null) {
        expect(LIFEOPS_HEALTH_SIGNAL_SOURCES).toContain(signal.health.source);
      }
    }
  });
});
