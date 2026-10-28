import { describe, expect, test } from "bun:test";
import type { PlannerTrajectory } from "@elizaos/core";
import {
  type CurrentNwsObservation,
  isVerifiedCurrentNwsObservation,
} from "./shared-current-weather";
import { matchesTypedPublicReadQaPolicy } from "./shared-public-read-qa";
import { createSharedReadEvidencePort, readSharedOriginReadEvidence } from "./shared-read-evidence";
import {
  isSimpleCurrentCelsiusTemperature,
  isSimpleCurrentTemperatureRequest,
  resolveTypedPublicReadParts,
  sharedReplyWantsSourceLinks,
  typedReadRequirementId,
} from "./shared-typed-read-domain";
import {
  createSharedTypedReadReplyResolver,
  createSharedTypedReadTurn,
} from "./shared-typed-read-reply";

const now = Date.now();
const ownerScope = "server-owner:canonical-private-dm";
const turnId = "synthetic-current-input";
const exactApprovedSF = "What's the current temperature in San Francisco? Please include a source.";
const eligibleCelsius =
  "What's the current temperature in San Francisco, California? Celsius. Source?";
const observation: CurrentNwsObservation = {
  format: "elizaos.current-weather.nws-observation.v1",
  city: "San Francisco",
  state: "CA",
  cityLatitude: 37.77,
  cityLongitude: -122.42,
  gnisId: 9991,
  pointLatitude: 37.77,
  pointLongitude: -122.42,
  advisoryNearestCity: null,
  advisoryNearestState: null,
  stationId: "SYN01",
  stationName: "Synthetic station",
  stationLatitude: 37.77,
  stationLongitude: -122.42,
  observationLatitude: 37.77,
  observationLongitude: -122.42,
  timestamp: new Date(now - 1000).toISOString(),
  temperatureC: 18.3,
  temperatureF: 64.9,
  temperatureQuality: "qc:V",
  conditions: "Synthetic clear conditions",
  sourceUrl: "https://api.weather.gov/stations/SYN01/observations/latest",
};
function resolverFor(message: string) {
  const parts = resolveTypedPublicReadParts(message, [], now);
  return parts
    ? createSharedTypedReadReplyResolver({
        ownerScope,
        turnId,
        turnStartedAtMs: now - 2000,
        parts,
        includeSources: sharedReplyWantsSourceLinks(message),
      })
    : undefined;
}
function trajectory(query: string, value = observation): PlannerTrajectory {
  return {
    context: { id: "synthetic-public-read", events: [] },
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
    steps: [
      {
        iteration: 1,
        toolCall: { id: "actual-call-1", name: "WEB_SEARCH", params: { query } },
        result: {
          success: true,
          text: "Synthetic station result",
          data: { actionName: "WEB_SEARCH", query, provider: "nws", weatherObservation: value },
        },
      },
    ],
  };
}

describe("default-off owner-scoped typed public reads", () => {
  test("the existing selector defaults off and cannot be widened by payload flags or another owner", () => {
    const scope = {
      organizationId: "org",
      userId: "owner",
      agentId: "personal:agent",
      roomKey: "personal:agent",
      channelSource: "blooio" as const,
    };
    const policy = JSON.stringify({ version: 1, ...scope });
    expect(matchesTypedPublicReadQaPolicy(undefined, scope)).toBe(false);
    expect(matchesTypedPublicReadQaPolicy(policy, scope)).toBe(true);
    expect(matchesTypedPublicReadQaPolicy(policy, { ...scope, userId: "other" })).toBe(false);
    for (const key of ["organizationId", "agentId", "roomKey", "channelSource"] as const) {
      expect(matchesTypedPublicReadQaPolicy(policy, { ...scope, [key]: "other" })).toBe(false);
    }
    for (const malformed of [
      "",
      "{",
      "null",
      "[]",
      JSON.stringify({ ...scope, version: 2 }),
      JSON.stringify({ ...scope, version: 1, roomKey: " " }),
      "x".repeat(4097),
    ]) {
      expect(matchesTypedPublicReadQaPolicy(malformed, scope)).toBe(false);
    }
    expect(
      matchesTypedPublicReadQaPolicy(
        JSON.stringify({ version: 1, ...scope, typedPublicReadReplies: true }),
        scope,
      ),
    ).toBe(false);
  });

  test("public search dispatch uses constructor-known bytes and rejects private or unrelated model queries", () => {
    const input = {
      enabled: true as const,
      authenticatedPersonalSharedUser: true as const,
      channelSource: "blooio",
      channelType: "DM",
      agentKey: "canonical-agent",
      roomKey: "canonical-room",
      userEntityId: "canonical-owner",
      turnId,
      message: exactApprovedSF,
      history: [],
      turnStartedAtMs: now,
    };
    expect(createSharedTypedReadTurn({ ...input, enabled: undefined })).toBeUndefined();
    expect(createSharedTypedReadTurn({ ...input, channelSource: "telegram" })).toBeUndefined();
    for (const message of [
      "What's the latest tech news today? Please include a source.",
      "What's the current temperature in Tokyo, Japan? Please include a source.",
      "What's the current temperature in Tokyo? Please include a source.",
      "What's the current temperature in San Francisco, Canada? Please include a source.",
    ])
      expect(createSharedTypedReadTurn({ ...input, message })).toBeUndefined();
    for (const message of [
      exactApprovedSF,
      "What's the current temperature in San Francisco, California? Please include a source.",
      "What's the current temperature in San Francisco, United States? Please include a source.",
    ])
      expect(createSharedTypedReadTurn({ ...input, message })).toBeDefined();
    const turn = createSharedTypedReadTurn(input);
    if (!turn) throw new Error("Expected scoped synthetic public request");
    expect(turn.authorizedPublicQueries).toEqual(["current public weather in San Francisco"]);
    expect(turn.authorizePublicSearch(" CURRENT PUBLIC WEATHER IN SAN FRANCISCO ")).toMatchObject({
      kind: "search",
      query: "current public weather in San Francisco",
    });
    expect(
      turn.authorizePublicSearch(" CURRENT PUBLIC WEATHER IN SAN FRANCISCO, CALIFORNIA "),
    ).toMatchObject({
      kind: "nws",
      query: "current public weather in San Francisco, CA",
      namedPlaceAlternative: true,
    });
    expect(
      turn.authorizePublicSearch("current public weather in Los Angeles, California"),
    ).toBeUndefined();
    expect(
      turn.authorizePublicSearch(
        "current public weather in San Francisco PRIVATE_HISTORY_SENTINEL",
      ),
    ).toBeUndefined();
    expect(turn.authorizePublicSearch("search for my private calendar")).toBeUndefined();
    const another = createSharedTypedReadTurn({
      ...input,
      message: "What's the current temperature in Los Angeles? Please include a source.",
    });
    expect(another?.requirementIds[0]).not.toBe(turn.requirementIds[0]);
  });

  test("source discovery keeps one scoped observation attempt open, then honors its settled outcome", () => {
    const resolve = resolverFor(exactApprovedSF);
    if (!resolve) throw new Error("Expected scoped temperature resolver");
    const search = trajectory("current public weather in San Francisco");
    const first = search.steps[0];
    if (!first?.result) throw new Error("Expected synthetic search step");
    first.result = {
      success: true,
      text: JSON.stringify({
        results: [
          {
            url: "https://weather.example/sf",
            title: "San Francisco, California",
            excerpt: "Public source identifies this city.",
          },
        ],
      }),
      data: {
        actionName: "WEB_SEARCH",
        query: "current public weather in San Francisco",
        provider: "parallel",
      },
    };
    const check = (value: PlannerTrajectory) =>
      resolve({ trajectory: value, nowMs: now, admittedToolNames: ["WEB_SEARCH"] });
    expect(check(search)?.phase).toBe("planning");
    expect(check(search)?.remainingReadActionNames).toEqual(["WEB_SEARCH"]);
    expect(check(search)?.facts).toEqual([]);
    const wrongCity = trajectory("current public weather in Los Angeles, California");
    expect(check({ ...search, steps: [...search.steps, ...wrongCity.steps] })?.phase).toBe(
      "planning",
    );
    const failedNws = trajectory("current public weather in San Francisco, California");
    if (!failedNws.steps[0]) throw new Error("Expected synthetic producer step");
    failedNws.steps[0].result = {
      success: false,
      text: "A recent, location-matched weather observation is unavailable.",
      data: {
        actionName: "WEB_SEARCH",
        query: "current public weather in San Francisco, CA",
        unavailableReason: "CURRENT_WEATHER_RECENT_VERIFIED_OBSERVATION_MISSING",
      },
    };
    const failed = check({ ...search, steps: [...search.steps, ...failedNws.steps] });
    expect(failed?.phase).toBe("final-answer");
    expect(failed?.remainingReadActionNames).toEqual([]);
    expect(failed?.facts).toEqual([]);
    const success = check({
      ...search,
      steps: [
        ...search.steps,
        ...trajectory("current public weather in San Francisco, California").steps,
      ],
    });
    expect(success?.phase).toBe("final-answer");
    expect(success?.facts).toHaveLength(1);
    const noSources = structuredClone(search);
    if (noSources.steps[0]?.result) noSources.steps[0].result.text = "No source evidence";
    expect(check(noSources)?.phase).toBe("final-answer");
  });

  test("the exact approved SF question admits source-unit evidence without inventing a requested unit", () => {
    expect(isSimpleCurrentCelsiusTemperature(exactApprovedSF)).toBe(false);
    expect(isSimpleCurrentTemperatureRequest(exactApprovedSF)).toBe(true);
    expect(resolverFor(exactApprovedSF)).toBeDefined();
    expect(
      resolverFor("What's the current temperature in San Francisco with a source?"),
    ).toBeDefined();
    expect(isSimpleCurrentCelsiusTemperature(eligibleCelsius)).toBe(true);
    expect(resolverFor(eligibleCelsius)).toBeDefined();
    expect(
      resolverFor("What is the current temperature in San Francisco in Fahrenheit? Source?"),
    ).toBeUndefined();
    expect(resolverFor("Current temperature in San Francisco in Kelvin? Source?")).toBeUndefined();
    expect(
      resolverFor("Current temperature in San Francisco and the wind speed? Source?"),
    ).toBeUndefined();
    expect(
      resolverFor("Current temperature in San Francisco? What is 17 plus 26?"),
    ).toBeUndefined();
    expect(
      resolverFor("Current temperature in San Francisco and latest AI news today?"),
    ).toBeUndefined();
    expect(
      resolveTypedPublicReadParts(
        "What is in my calendar and the current temperature in San Francisco?",
      ),
    ).toBeUndefined();
    expect(sharedReplyWantsSourceLinks("Current temperature in Celsius. No sources.")).toBe(false);
  });

  test("reuses the current NWS producer validator and keeps the actual fact unit, owner and turn", () => {
    const parts = resolveTypedPublicReadParts(eligibleCelsius, [], now);
    const part = parts?.[0];
    if (!part) throw new Error("Expected an eligible synthetic requirement");
    const query = part.requirement.query;
    expect(isVerifiedCurrentNwsObservation(observation, query, now)).toBe(true);
    const resolver = resolverFor(eligibleCelsius);
    if (!resolver) throw new Error("Expected the scoped resolver");
    const read = resolver({
      trajectory: trajectory(query),
      nowMs: now,
      admittedToolNames: ["WEB_SEARCH"],
    });
    expect(read?.facts).toHaveLength(1);
    expect(read?.facts[0]).toMatchObject({
      ownerScope,
      sourceUrl: observation.sourceUrl,
      value: 18.3,
      unit: "°C",
    });
    expect(read?.policy.turnId).toBe(turnId);
    expect(read?.phase).toBe("final-answer");
    const wrongPlace = resolver({
      trajectory: trajectory(query, { ...observation, city: "Another city" }),
      nowMs: now,
      admittedToolNames: ["WEB_SEARCH"],
    });
    expect(wrongPlace?.facts).toHaveLength(0);
    const wrongQuery = resolver({
      trajectory: trajectory("current public weather in Another city, California"),
      nowMs: now,
      admittedToolNames: ["WEB_SEARCH"],
    });
    expect(wrongQuery?.facts).toHaveLength(0);
  });

  test("a bare-city answer requires an independently validated fully qualified source alternative", () => {
    const resolver = resolverFor(exactApprovedSF);
    if (!resolver) throw new Error("Expected structurally eligible no-unit question");
    const sourceQuery = "current public weather in San Francisco, California";
    const read = resolver({
      trajectory: trajectory(sourceQuery),
      nowMs: now,
      admittedToolNames: ["WEB_SEARCH"],
    });
    expect(read?.facts[0]).toMatchObject({
      kind: "quantity-report",
      qualification: "named-place-alternative",
      providerLocality: "San Francisco, CA",
      value: 18.3,
      unit: "°C",
    });
    expect(read?.policy.requirements[0]?.qualifiedFactIds).toHaveLength(1);
    expect(read?.policy.requirements[0]?.admittedFactIds).toHaveLength(0);
    expect(read?.policy.requirements[0]?.unverifiedText).toBe(
      "I couldn't verify the current temperature.",
    );
    const empty: PlannerTrajectory = {
      context: { id: "empty-read", events: [] },
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    };
    expect(
      resolver({ trajectory: empty, nowMs: now, admittedToolNames: ["WEB_SEARCH"] })?.facts,
    ).toHaveLength(0);
    expect(
      resolver({
        trajectory: trajectory("current public weather in Los Angeles, California", {
          ...observation,
          city: "Los Angeles",
        }),
        nowMs: now,
        admittedToolNames: ["WEB_SEARCH"],
      })?.facts,
    ).toHaveLength(0);
    const unbound = trajectory(sourceQuery);
    if (!unbound.steps[0]?.result) throw new Error("Expected synthetic source result");
    unbound.steps[0].result.data = { ...unbound.steps[0].result.data, provider: "parallel" };
    expect(
      resolver({ trajectory: unbound, nowMs: now, admittedToolNames: ["WEB_SEARCH"] })?.facts,
    ).toHaveLength(0);
    const wrongCountry = resolverFor(
      "What's the current temperature in San Francisco, Canada? Please include a source.",
    );
    expect(
      wrongCountry?.({
        trajectory: trajectory(sourceQuery),
        nowMs: now,
        admittedToolNames: ["WEB_SEARCH"],
      })?.facts,
    ).toHaveLength(0);
    const wrongSource = resolver({
      trajectory: trajectory(sourceQuery, {
        ...observation,
        sourceUrl: "https://unknown.example/current",
      }),
      nowMs: now,
      admittedToolNames: ["WEB_SEARCH"],
    });
    expect(wrongSource?.facts).toHaveLength(0);
  });

  test("typed origin dispatch cannot append private bytes or use unrelated public URLs", () => {
    const message = "What's the latest AI news today? Source?";
    const parts = resolveTypedPublicReadParts(message, [], now);
    const part = parts?.[0];
    if (!part) throw new Error("Expected a synthetic public news requirement");
    const port = createSharedReadEvidencePort({
      ownerScope,
      turnId,
      turnStartedAtMs: now - 2000,
      parts,
    });
    if (!port) throw new Error("Expected a scoped evidence port");
    const url = "https://news.example.org/public-story";
    expect(port.authorizeUrl?.(url)).toBe(false);
    const result = {
      success: true,
      text: JSON.stringify({
        results: [
          { url, title: "Synthetic AI headline", excerpts: ["A public synthetic AI event."] },
        ],
        errors: [],
      }),
      data: { actionName: "WEB_SEARCH", query: part.requirement.query, provider: "parallel" },
    };
    port.observePublicSearch?.(result, part.requirement.query);
    expect(port.authorizeUrl?.(url)).toBe(true);
    expect(port.authorizeUrl?.(`${url}?note=PRIVATE_SENTINEL`)).toBe(false);
    expect(port.authorizeUrl?.("https://another.example.org/unrelated")).toBe(false);
    const other = "https://news.example.org/from-another-query";
    port.observePublicSearch?.(
      {
        ...result,
        text: JSON.stringify({ results: [{ url: other, excerpts: ["Other topic"] }] }),
        data: { ...result.data, query: "another topic" },
      },
      part.requirement.query,
    );
    expect(port.authorizeUrl?.(other)).toBe(false);
  });

  test("origin evidence must match the actual owner, turn, request and transport receipt", () => {
    const parts = resolveTypedPublicReadParts(eligibleCelsius, [], now);
    const part = parts?.[0];
    if (!part) throw new Error("Expected a requirement");
    const scope = { ownerScope, turnId, turnStartedAtMs: now - 2000, parts };
    const url = "https://wttr.in/37.77,-122.42?format=j1";
    const originRead = {
      format: "elizaos.web-fetch.origin.v1",
      requestedAt: now - 1000,
      retrievedAt: now,
      url,
      status: 200,
      redirect: "manual",
      cache: "no-store",
    };
    const value = {
      format: "elizaos.shared-origin-read.v1",
      ownerScope,
      turnId,
      turnStartedAtMs: scope.turnStartedAtMs,
      requirementId: typedReadRequirementId(part, 0),
      query: part.requirement.query,
      kind: "wttr-origin",
      operation: {
        url,
        requestedAt: now - 1000,
        retrievedAt: now,
        requestPolicy: { method: "GET", redirect: "manual", cache: "no-store" },
      },
    };
    const input = {
      value,
      scope,
      requirementId: typedReadRequirementId(part, 0),
      part,
      url,
      originRead,
      nowMs: now,
    };
    expect(readSharedOriginReadEvidence(input)?.kind).toBe("wttr-origin");
    expect(
      readSharedOriginReadEvidence({ ...input, value: { ...value, ownerScope: "other" } }),
    ).toBeUndefined();
    expect(
      readSharedOriginReadEvidence({ ...input, value: { ...value, turnId: "prior-turn" } }),
    ).toBeUndefined();
    expect(
      readSharedOriginReadEvidence({
        ...input,
        originRead: { ...originRead, retrievedAt: now - 1 },
      }),
    ).toBeUndefined();
    expect(
      readSharedOriginReadEvidence({ ...input, originRead: { ...originRead, cache: "default" } }),
    ).toBeUndefined();
  });
});
