// Eliza Cloud Maps device provider against a stubbed account-bound Cloud request.
// No request leaves the process; this is not evidence of a deployed Cloud Maps
// service, real coverage, a live route or physical navigation.
import assert from "node:assert/strict";
import {
  cloudMapsFailure,
  createCloudMaps,
  describeMapsDisclosure,
  insideCloudCoverage,
} from "../src/client/cloud-provider.ts";
import { MapsFailure } from "../src/client/contracts.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";

const ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: GraphHopper.";
const CASINO = { latitude: 43.7397, longitude: 7.4276 },
  PORT = { latitude: 43.7347, longitude: 7.4206 };
const coverage = {
  providerId: "eliza-cloud-osm",
  connectionId: "conn_eliza_cloud_maps_osm",
  revision: "osm-monaco-2026-09-29",
  attribution: ATTRIBUTION,
  regions: [
    { id: "monaco", name: "Monaco", bounds: [7.409, 43.724, 7.449, 43.752] },
  ],
  capabilities: {
    map: false,
    search: true,
    placeDetails: true,
    geocode: true,
    reverseGeocode: true,
    modes: ["drive", "walk", "bicycle"],
    alternatives: true,
    traffic: "none",
    transit: "none",
    offline: { map: false, search: false, routing: false },
  },
};
const place = {
  providerId: "eliza-cloud-osm",
  id: "N1234",
  name: "Port Hercule",
  coordinate: PORT,
  address: "Port Hercule, Monaco",
  attribution: ATTRIBUTION,
  fetchedAt: Date.now(),
};
const route = {
  providerId: "eliza-cloud-osm",
  id: "route_0123456789abcdef01234567",
  from: CASINO,
  to: PORT,
  mode: "walk",
  geometry: [CASINO, PORT],
  distanceMeters: 640,
  durationSeconds: 480,
  steps: [
    {
      instruction: "Walk south",
      coordinate: CASINO,
      distanceMeters: 640,
      maneuver: "depart",
    },
    {
      instruction: "Arrive",
      coordinate: PORT,
      distanceMeters: 0,
      maneuver: "arrive",
    },
  ],
  attribution: ATTRIBUTION,
  fetchedAt: Date.now(),
  traffic: "none",
};
const cloudError = (status, code) =>
  Object.assign(new Error(`Eliza Cloud http (${status})`), {
    name: "CloudProtocolError",
    code: "http",
    status,
    data: { code },
  });
const location = {
  awaitingPermission: () => false,
  start: async () => {},
  stop: async () => {},
};
const memory = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

// Signed out: Maps stays unconfigured and says why; nothing is invented.
{
  let configured = 0;
  const maps = createCloudMaps(
    () => async () => {
      throw new MapsFailure(
        "unauthorized",
        "Sign in to Eliza Cloud to use Maps.",
      );
    },
    () => configured++,
  );
  await maps.initializeCloudMaps();
  assert.equal(
    configured,
    0,
    "a provider Cloud never installed is not touched",
  );
  assert.equal(maps.cloudMapsCoverage(), undefined);
  assert.deepEqual(maps.cloudMapsDiagnostics(), {
    configured: true,
    error: "unauthorized",
  });
}

// Signed in: coverage configures the provider and the shared controller plans a validated route.
{
  const calls = [];
  let config, provider;
  const maps = createCloudMaps(
    () => async (path, _signal, body) => {
      calls.push([path, body]);
      if (path === "capabilities") return structuredClone(coverage);
      if (path === "places/search")
        return {
          providerId: coverage.providerId,
          attribution: ATTRIBUTION,
          places: [place],
        };
      if (path === "places/details")
        return {
          providerId: coverage.providerId,
          attribution: ATTRIBUTION,
          place,
        };
      if (path === "routes")
        return {
          providerId: coverage.providerId,
          attribution: ATTRIBUTION,
          routes: [route],
        };
      throw new Error(`unexpected ${path}`);
    },
    (nextConfig, nextProvider) => {
      config = nextConfig;
      provider = nextProvider;
    },
  );
  await maps.initializeCloudMaps();
  assert.equal(config.status, "configured");
  assert.equal(config.capabilities.map, false, "Cloud serves no tiles");
  assert.deepEqual(config.capabilities.modes, ["drive", "walk", "bicycle"]);
  assert.equal(maps.cloudMapsCoverage().attribution, ATTRIBUTION);
  assert.ok(insideCloudCoverage(maps.cloudMapsCoverage(), CASINO));
  assert.ok(
    !insideCloudCoverage(maps.cloudMapsCoverage(), {
      latitude: 48.85,
      longitude: 2.35,
    }),
  );

  const controller = new MapsController(
    config,
    provider,
    new SavedPlaces("test.maps.saved", memory()),
    location,
  );
  await controller.search("Port");
  assert.equal(controller.snapshot().search.phase, "ready");
  await controller.select(controller.snapshot().search.value[0]);
  assert.equal(controller.snapshot().selection.value.name, "Port Hercule");
  controller.setOrigin(CASINO);
  controller.setMode("walk");
  await controller.planRoute();
  const planned = controller.snapshot().route;
  assert.equal(planned.phase, "ready", planned.error?.message);
  assert.equal(planned.value.distanceMeters, 640);
  assert.deepEqual(
    calls.map(([path]) => path),
    ["capabilities", "places/search", "places/details", "routes"],
  );
  assert.deepEqual(calls[1][1], { query: "Port" });
  assert.deepEqual(
    calls[3][1],
    { from: CASINO, to: PORT, mode: "walk" },
    "location travels only in the body; no alternatives are requested",
  );
}

// Typed Cloud refusals become device failures; none becomes data.
for (const [status, code, expected] of [
  [403, "subscription_required", "unauthorized"],
  [422, "no_route", "unsupported"],
  [422, "unsupported_region", "unsupported"],
  [429, "rate_limited", "rate-limited"],
  [503, "maps_not_configured", "unconfigured"],
  [503, "provider_unavailable", "unavailable"],
  [502, "provider_invalid_response", "invalid-response"],
])
  assert.equal(
    cloudMapsFailure(cloudError(status, code)).code,
    expected,
    `${status} ${code}`,
  );
assert.equal(
  cloudMapsFailure(
    Object.assign(new Error("x"), {
      name: "CloudProtocolError",
      code: "credentials-missing",
    }),
  ).code,
  "unauthorized",
);
// Before Cloud Maps is deployed an authenticated read finds no route: Maps is honestly not available yet.
assert.equal(cloudMapsFailure(cloudError(404, undefined)).code, "unconfigured");
// A malformed Cloud body is an invalid response, never a sign-in prompt.
assert.equal(
  cloudMapsFailure(
    Object.assign(new Error("x"), {
      name: "CloudProtocolError",
      code: "invalid-response",
    }),
  ).code,
  "invalid-response",
);
assert.equal(
  cloudMapsFailure(cloudError(503, "provider_unavailable"), AbortSignal.abort())
    .code,
  "cancelled",
);

// Invalid coverage leaves Maps unconfigured.
{
  let configured = 0;
  const maps = createCloudMaps(
    () => async () => ({ ...coverage, regions: [] }),
    () => configured++,
  );
  await maps.initializeCloudMaps();
  assert.equal(
    configured,
    0,
    "a provider Cloud never installed is not touched",
  );
  assert.equal(maps.cloudMapsDiagnostics().error, "invalid-response");
}
console.log(
  "PASS Cloud Maps device provider: coverage, search, details, route, failures",
);

// A failed replacement and a late older response cannot leave a stale provider active.
{
  let resolveOld;
  let config, provider;
  let fetch = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  const maps = createCloudMaps(
    () => fetch,
    (c, p) => {
      config = c;
      provider = p;
    },
  );
  const older = maps.initializeCloudMaps();
  fetch = async () => coverage;
  await maps.initializeCloudMaps();
  const currentProvider = provider;
  resolveOld({ ...coverage, revision: "obsolete" });
  await older;
  assert.equal(provider, currentProvider);
  assert.equal(maps.cloudMapsCoverage().revision, coverage.revision);
  fetch = async () => {
    throw cloudError(503, "maps_not_configured");
  };
  await maps.initializeCloudMaps();
  assert.equal(config.status, "unconfigured");
  assert.equal(provider, undefined);
  await assert.rejects(
    currentProvider.search("Port", new AbortController().signal),
    (error) => error.code === "cancelled",
  );
}

// Account changes before a route request prevent transmission; changes during a request reject its result.
{
  const { captureMapsSession } = await import("../src/client/cloud-session.ts");
  let calls = 0,
    finish;
  const first = {
    sessionId: "A",
    credentialId: "key-A",
    client: {
      mapsRequest: async () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  const second = {
    sessionId: "B",
    credentialId: "key-B",
    client: {
      mapsRequest: async () => {
        calls++;
        return {};
      },
    },
  };
  let active = first;
  const request = captureMapsSession(() => active);
  const pending = request("routes", new AbortController().signal, {
    from: CASINO,
    to: PORT,
  });
  active = second;
  finish({ routes: [route] });
  await assert.rejects(pending, (error) => error.code === "unauthorized");
  await assert.rejects(
    request("routes", new AbortController().signal, { from: CASINO, to: PORT }),
    (error) => error.code === "unauthorized",
  );
  assert.equal(calls, 1, "the new account received no retained coordinates");
}

assert.equal(
  cloudMapsFailure(cloudError(503, "maps_allowance_unconfigured")).code,
  "unconfigured",
);
assert.match(
  cloudMapsFailure(cloudError(503, "maps_allowance_unconfigured")).message,
  /not available yet/,
);
assert.match(
  cloudMapsFailure(cloudError(503, "maps_admission_unknown")).message,
  /not retry automatically/,
);
assert.match(
  cloudMapsFailure(cloudError(409, "maps_request_already_admitted")).message,
  /not retry automatically/,
);
assert.match(
  cloudMapsFailure(cloudError(429, "allowance_exhausted")).message,
  /used your Maps allowance/,
);

// Preserve server retry hints without borrowing AI allowance copy or retrying a request.
{
  const error = (code, fields) =>
    Object.assign(cloudError(429, code), { data: { code, ...fields } });
  assert.match(
    cloudMapsFailure(error("rate_limited", { retryAfterSeconds: 42 })).message,
    /Try again in about 42 seconds/,
  );
  assert.match(
    cloudMapsFailure(error("allowance_exhausted", { retryAfterSeconds: 120 }))
      .message,
    /Maps allowance.*resets in about 2 minutes/,
  );
  const reset = Date.now() + 3 * 86400000;
  const text = cloudMapsFailure(
    error("allowance_exhausted", {
      resetAt: new Date(reset).toISOString(),
      retryAfterSeconds: 60,
    }),
  ).message;
  assert.ok(
    text.includes(new Date(reset).toLocaleString()),
    "An explicit period reset wins over a short retry hint",
  );
  assert.doesNotMatch(text, /AI|credits|purchase|resets in/);
  assert.match(
    cloudMapsFailure(
      error("allowance_exhausted", { retryAfterSeconds: 3 * 86400 }),
    ).message,
    /It resets /,
  );
  assert.doesNotMatch(
    cloudMapsFailure(
      error("allowance_exhausted", { retryAfterSeconds: 3 * 86400 }),
    ).message,
    /resets in/,
  );
  for (const retryAfterSeconds of [-1, "bad", Infinity, 900000000]) {
    assert.equal(
      cloudMapsFailure(error("rate_limited", { retryAfterSeconds })).message,
      "Maps request limit reached. Try again later.",
    );
    assert.equal(
      cloudMapsFailure(error("allowance_exhausted", { retryAfterSeconds }))
        .message,
      "You have used your Maps allowance for this period.",
    );
  }
  assert.equal(
    cloudMapsFailure(
      error("rate_limited", { retryAfterSeconds: 42 }),
      AbortSignal.abort(),
    ).code,
    "cancelled",
  );
  let calls = 0,
    provider;
  const maps = createCloudMaps(
    () => async (route) => {
      if (route === "capabilities") return coverage;
      calls++;
      throw error("rate_limited", { retryAfterSeconds: 42 });
    },
    (_config, next) => (provider = next),
  );
  await maps.initializeCloudMaps();
  await assert.rejects(
    provider.search("Port", new AbortController().signal),
    (failure) =>
      failure.code === "rate-limited" && /42 seconds/.test(failure.message),
  );
  assert.equal(
    calls,
    1,
    "A retry hint never schedules another provider request",
  );
}

assert.equal(
  cloudMapsFailure(
    Object.assign(cloudError(429, "allowance_exhausted"), {
      data: {
        code: "allowance_exhausted",
        resetAt: "9999-01-01T00:00:00Z",
        error: "private provider detail",
      },
    }),
  ).message,
  "You have used your Maps allowance for this period.",
);
assert.equal(
  cloudMapsFailure(
    Object.assign(cloudError(429, "rate_limited"), {
      data: {
        code: "rate_limited",
        error: "private provider detail",
        retryAfterSeconds: "private provider detail",
      },
    }),
  ).message,
  "Maps request limit reached. Try again later.",
);

// Rate-limit reset-only hints use a bounded future wait, never an unbounded date.
{
  const originalNow = Date.now,
    now = Date.UTC(2026, 9, 19, 12);
  Date.now = () => now;
  try {
    const refusal = (resetAt) =>
      Object.assign(cloudError(429, "rate_limited"), {
        data: { code: "rate_limited", resetAt },
      });
    assert.match(
      cloudMapsFailure(refusal(new Date(now + 42000).toISOString())).message,
      /Try again in about 42 seconds/,
    );
    assert.match(
      cloudMapsFailure(refusal(new Date(now + 86400000).toISOString())).message,
      /Try again in about 24 hours/,
    );
    for (const reset of [
      "invalid",
      "private provider detail",
      new Date(now - 1000).toISOString(),
      new Date(now).toISOString(),
      new Date(now + 86400001).toISOString(),
      "9999-01-01T00:00:00Z",
    ])
      assert.equal(
        cloudMapsFailure(refusal(reset)).message,
        "Maps request limit reached. Try again later.",
      );
  } finally {
    Date.now = originalNow;
  }
}

// Cloud place IDs are opaque; provider syntax belongs to the Cloud adapter.
{
  let provider;
  const calls = [];
  const maps = createCloudMaps(
    () => async (path, _signal, body) => {
      if (path === "capabilities") return coverage;
      calls.push(body.id);
      return { place: { ...place, id: body.id } };
    },
    (_config, next) => {
      provider = next;
    },
  );
  await maps.initializeCloudMaps();
  for (const id of ["provider:opaque/place-42", "N0001234"]) {
    assert.equal(
      (await provider.detail(id, new AbortController().signal)).id,
      id,
    );
  }
  for (const id of ["", "x".repeat(513)])
    assert.equal(await provider.detail(id, new AbortController().signal), null);
  assert.deepEqual(calls, ["provider:opaque/place-42", "N0001234"]);
}

// Coverage keeps Cloud's sources and location disclosure for display; a malformed one is dropped, not invented.
{
  const disclosure = {
    recipients: [
      { role: "gateway", name: "Eliza Cloud Maps", operator: "Eliza Cloud" },
      { role: "search", name: "Nominatim", operator: "Acme" },
      { role: "routing", name: "GraphHopper", operator: "Acme" },
    ],
    cloudRecords: "operation-and-result-code",
  };
  const sources = {
    data: "OpenStreetMap",
    search: "Nominatim",
    routing: "GraphHopper",
  };
  const described = createCloudMaps(
    () => async () => ({ ...coverage, sources, disclosure }),
    () => {},
  );
  await described.initializeCloudMaps();
  assert.deepEqual(described.cloudMapsCoverage().disclosure, disclosure);
  assert.deepEqual(described.cloudMapsCoverage().sources, sources);
  for (const broken of [
    { ...disclosure, cloudRecords: "everything" },
    {
      ...disclosure,
      recipients: [{ role: "search", name: "", operator: "Acme" }],
    },
    "text",
  ]) {
    const maps = createCloudMaps(
      () => async () => ({ ...coverage, disclosure: broken }),
      () => {},
    );
    await maps.initializeCloudMaps();
    assert.equal(
      maps.cloudMapsDiagnostics().error,
      "",
      "a malformed disclosure does not refuse configured Maps",
    );
    assert.equal(maps.cloudMapsCoverage().disclosure, undefined);
  }
  assert.equal(
    describeMapsDisclosure(disclosure),
    "Searches and route points are sent to Eliza Cloud Maps and Nominatim for search, operated by Acme and GraphHopper for routing, operated by Acme. Cloud keeps only the request type and result, not your searches or locations.",
  );
  assert.equal(describeMapsDisclosure(undefined), "");
  console.log(
    "PASS Cloud Maps device provider: sources and location disclosure",
  );
}
