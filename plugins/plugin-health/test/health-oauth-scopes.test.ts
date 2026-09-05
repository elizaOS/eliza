/**
 * The scope-to-capability mapping for every health connector.
 *
 * `healthScopesToCapabilities` turns the scopes a user actually granted at the
 * provider's consent screen into the capabilities this agent will exercise. It
 * is therefore a consent-fidelity boundary: a capability it returns that the
 * granted scopes do not cover is a promise the token cannot keep, and a
 * capability it drops silently disables a feature the user did authorize.
 *
 * Four providers, four hand-written branches, and none of these exports were
 * referenced by any test in the repo.
 */

import { describe, expect, it } from "vitest";
import type { LifeOpsHealthConnectorProvider } from "../src/health-bridge/health-oauth.js";
import {
  healthConnectorCapabilities,
  healthConnectorScopes,
  healthScopesToCapabilities,
} from "../src/health-bridge/health-oauth.js";

const PROVIDERS = [
  "strava",
  "fitbit",
  "withings",
  "oura",
] as const satisfies readonly LifeOpsHealthConnectorProvider[];

describe("the declared capability and scope lists", () => {
  it.each(PROVIDERS)("%s advertises a non-empty capability set", (provider) => {
    expect(healthConnectorCapabilities(provider).length).toBeGreaterThan(0);
    expect(healthConnectorScopes(provider).length).toBeGreaterThan(0);
  });

  it.each(PROVIDERS)(
    "%s hands back a copy, not the registry array",
    (provider) => {
      // Both accessors spread. A caller that sorts or splices the result must not
      // mutate the shared provider spec for every later connector.
      const first = healthConnectorCapabilities(provider);
      first.length = 0;
      expect(healthConnectorCapabilities(provider).length).toBeGreaterThan(0);

      const scopes = healthConnectorScopes(provider);
      scopes.push("injected-scope");
      expect(healthConnectorScopes(provider)).not.toContain("injected-scope");
    },
  );
});

describe("granting nothing grants nothing", () => {
  it.each(PROVIDERS)(
    "%s derives no capability from an empty scope set",
    (provider) => {
      expect(healthScopesToCapabilities(provider, [])).toEqual([]);
    },
  );

  it.each(PROVIDERS)("%s ignores scopes it does not recognise", (provider) => {
    expect(
      healthScopesToCapabilities(provider, [
        "admin",
        "offline_access",
        "HEARTRATE",
        "activity ",
      ]),
    ).toEqual([]);
  });
});

describe("the granted scopes bound the capabilities (no over-grant)", () => {
  it.each(PROVIDERS)(
    "%s never derives a capability outside its declared set",
    (provider) => {
      const declared = healthConnectorCapabilities(provider);
      const scopes = healthConnectorScopes(provider);

      // Every single-scope grant, and the full grant.
      for (const scope of [...scopes.map((s) => [s]), scopes]) {
        for (const capability of healthScopesToCapabilities(provider, scope)) {
          expect(declared).toContain(capability);
        }
      }
    },
  );

  it.each(PROVIDERS)("%s returns no duplicates", (provider) => {
    const derived = healthScopesToCapabilities(
      provider,
      healthConnectorScopes(provider),
    );
    expect(new Set(derived).size).toBe(derived.length);
  });
});

describe("the full default grant reaches every advertised capability (no under-grant)", () => {
  it.each(PROVIDERS)(
    "%s: authorizing the default scopes yields exactly the declared set",
    (provider) => {
      // If these ever diverge, the connector either advertises a capability no
      // scope can unlock, or requests a scope that unlocks nothing.
      const declared = [...healthConnectorCapabilities(provider)].sort();
      const derived = [
        ...healthScopesToCapabilities(
          provider,
          healthConnectorScopes(provider),
        ),
      ].sort();
      expect(derived).toEqual(declared);
    },
  );
});

describe("adding a scope is monotone", () => {
  it.each(PROVIDERS)(
    "%s never loses a capability when another scope is added",
    (provider) => {
      const scopes = healthConnectorScopes(provider);
      for (const scope of scopes) {
        const alone = healthScopesToCapabilities(provider, [scope]);
        const withAll = healthScopesToCapabilities(provider, scopes);
        for (const capability of alone) {
          expect(withAll).toContain(capability);
        }
      }
    },
  );
});

describe("per-provider scope semantics", () => {
  it("strava: either activity scope unlocks activity and workouts, nothing else does", () => {
    for (const scope of ["activity:read", "activity:read_all"]) {
      expect(healthScopesToCapabilities("strava", [scope]).sort()).toEqual([
        "health.activity.read",
        "health.workouts.read",
      ]);
    }
    // `read` and `profile:read_all` are requested by default but grant no
    // health capability on their own — they exist for identity, not data.
    expect(healthScopesToCapabilities("strava", ["read"])).toEqual([]);
    expect(healthScopesToCapabilities("strava", ["profile:read_all"])).toEqual(
      [],
    );
  });

  it("fitbit: each data scope unlocks only its own family", () => {
    expect(healthScopesToCapabilities("fitbit", ["activity"]).sort()).toEqual([
      "health.activity.read",
      "health.workouts.read",
    ]);
    expect(healthScopesToCapabilities("fitbit", ["sleep"])).toEqual([
      "health.sleep.read",
    ]);
    expect(healthScopesToCapabilities("fitbit", ["heartrate"])).toEqual([
      "health.vitals.read",
    ]);
    expect(healthScopesToCapabilities("fitbit", ["weight"])).toEqual([
      "health.body.read",
    ]);
    // `profile` is identity only.
    expect(healthScopesToCapabilities("fitbit", ["profile"])).toEqual([]);
  });

  it("oura: `daily` is the broad one, and the vitals scopes are interchangeable", () => {
    expect(healthScopesToCapabilities("oura", ["daily"]).sort()).toEqual([
      "health.activity.read",
      "health.readiness.read",
      "health.sleep.read",
    ]);
    // Either vitals scope alone is sufficient, and together they must not
    // duplicate the capability.
    expect(healthScopesToCapabilities("oura", ["heartrate"])).toEqual([
      "health.vitals.read",
    ]);
    expect(healthScopesToCapabilities("oura", ["spo2"])).toEqual([
      "health.vitals.read",
    ]);
    expect(healthScopesToCapabilities("oura", ["heartrate", "spo2"])).toEqual([
      "health.vitals.read",
    ]);
    expect(healthScopesToCapabilities("oura", ["workout"])).toEqual([
      "health.workouts.read",
    ]);
    expect(healthScopesToCapabilities("oura", ["personal"])).toEqual([
      "health.body.read",
    ]);
    expect(healthScopesToCapabilities("oura", ["email"])).toEqual([]);
  });

  it("withings: sleep is reachable from two scopes, and they agree", () => {
    // `user.activity` and `user.sleepevents` both yield sleep access. Whichever
    // is granted, the capability must be identical and appear exactly once.
    expect(
      healthScopesToCapabilities("withings", ["user.activity"]).sort(),
    ).toEqual(["health.activity.read", "health.sleep.read"]);
    expect(
      healthScopesToCapabilities("withings", ["user.sleepevents"]),
    ).toEqual(["health.sleep.read"]);
    expect(
      healthScopesToCapabilities("withings", [
        "user.activity",
        "user.sleepevents",
      ]),
    ).toEqual(["health.activity.read", "health.sleep.read"]);

    expect(
      healthScopesToCapabilities("withings", ["user.metrics"]).sort(),
    ).toEqual(["health.body.read", "health.vitals.read"]);
    expect(healthScopesToCapabilities("withings", ["user.info"])).toEqual([]);
  });
});

describe("scope matching is exact", () => {
  it.each(PROVIDERS)(
    "%s does not match a scope by prefix or substring",
    (provider) => {
      // A `Set.has` lookup is exact today. A future refactor to `startsWith` or
      // `includes` would let `activity:read_all_admin` or `daily-summary` grant
      // real capabilities.
      const scopes = healthConnectorScopes(provider);
      const mangled = scopes.flatMap((scope) => [
        `${scope}_extra`,
        `x-${scope}`,
        scope.toUpperCase(),
      ]);
      expect(healthScopesToCapabilities(provider, mangled)).toEqual([]);
    },
  );
});
