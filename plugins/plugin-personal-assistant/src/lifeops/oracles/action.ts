/**
 * Owner conversational surface over the registered external-fact sources:
 * point weather outlooks, local-activity discovery across every registered
 * source, deterministic activity curation of discovered results, and
 * childcare coverage-gap math.
 *
 * Observation only — this action never books, registers, purchases, or
 * cancels anything, and weather evidence never cancels a provider's program.
 * Source health is preserved end to end: an unavailable provider surfaces as
 * an explicit unavailable observation, never as an empty forecast or a
 * zero-activity result. Curation is fail-closed — facts the sources cannot
 * verify (capacity, eligibility, travel time, custody) become verification
 * questions and can never become selected coverage.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import {
  type LocalActivity,
  type LocalActivityOracleQuery,
  type OracleSnapshot,
  oracleError,
  type WeatherOraclePayload,
} from "./contracts.js";
import {
  type ActivityCurationCandidate,
  type ActivityCurationContext,
  type BusyWindow,
  type ChildcareCoverageSlot,
  type CurationChild,
  type CustodyWindow,
  computeChildcareCoverageGaps,
  curateLocalActivities,
  type ProtectedUnstructuredWindow,
  type TimeWindow,
} from "./curation.js";
import { isRfc3339Instant } from "./http.js";
import {
  getExternalOracleRegistry,
  getLocalActivityAdapterRegistry,
  type LocalActivitySourceObservation,
} from "./registry.js";

export const LOCAL_CONDITIONS_ACTION = "LOCAL_CONDITIONS";

const LOCAL_CONDITIONS_SUBACTIONS = [
  "weather_outlook",
  "discover_activities",
  "curate_discovered_activities",
  "childcare_coverage_gaps",
] as const;
type LocalConditionsSubaction = (typeof LOCAL_CONDITIONS_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<LocalConditionsSubaction> = {
  weather_outlook: {
    description:
      "Read the typed point forecast for exact coordinates from the registered weather source, with provenance, freshness, and explicit unavailable state.",
    descriptionCompressed: "typed point weather forecast w/ provenance",
    required: ["latitude", "longitude"],
    optional: ["includeHourly"],
  },
  discover_activities: {
    description:
      "Discover local activities and events across every registered activity source for a location, time window, and keywords. Reports per-source health; an unavailable source is never an empty result.",
    descriptionCompressed:
      "discover local activities across sources; per-source health",
    required: ["location", "startAt", "endAt", "keywords"],
    optional: ["pageSize", "maxPages"],
  },
  curate_discovered_activities: {
    description:
      "Discover activities, then deterministically curate them against stated children, custody knowledge, calendar windows, and caregiver capacity. Unverified source facts become verification questions, never selected coverage.",
    descriptionCompressed:
      "discover + fail-closed curate activities for stated children",
    required: [
      "location",
      "startAt",
      "endAt",
      "keywords",
      "children",
      "custodyHealth",
      "maxSuggestions",
    ],
    optional: [
      "pageSize",
      "maxPages",
      "caregiverParticipantIds",
      "custodyWindows",
      "busyWindows",
      "protectedUnstructuredWindows",
      "availableCaregiverHeadcount",
      "requiredCaregiverHeadcount",
    ],
  },
  childcare_coverage_gaps: {
    description:
      "Compute the exact uncovered time windows between required childcare coverage and confirmed care slots. Waitlisted, full, canceled, or unverified slots never count as coverage.",
    descriptionCompressed:
      "childcare coverage gaps; confirmed slots only count",
    required: ["requiredWindows"],
    optional: ["coverageSlots"],
  },
};

export interface LocalConditionsActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
}

function invalid(field: string, expected: string): never {
  throw oracleError(`${field} must be ${expected}`, "ORACLE_QUERY_INVALID", {
    field,
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(field, "an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(field, "an array");
  }
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(field, "a non-empty string");
  }
  return (value as string).trim();
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(field, "a finite number");
  }
  return value as number;
}

function integer(value: unknown, field: string, minimum: number): number {
  const numeric = finiteNumber(value, field);
  if (!Number.isSafeInteger(numeric) || numeric < minimum) {
    invalid(field, `an integer of at least ${minimum}`);
  }
  return numeric;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return integer(value, field, minimum);
}

function latitude(value: unknown, field: string): number {
  const numeric = finiteNumber(value, field);
  if (numeric < -90 || numeric > 90) {
    invalid(field, "a latitude between -90 and 90");
  }
  return numeric;
}

function longitude(value: unknown, field: string): number {
  const numeric = finiteNumber(value, field);
  if (numeric < -180 || numeric > 180) {
    invalid(field, "a longitude between -180 and 180");
  }
  return numeric;
}

function instant(value: unknown, field: string): string {
  const normalized = text(value, field);
  if (!isRfc3339Instant(normalized)) {
    invalid(field, "an RFC 3339 instant");
  }
  return normalized;
}

function stringArray(value: unknown, field: string): string[] {
  return array(value, field).map((entry, index) =>
    text(entry, `${field}[${index}]`),
  );
}

function activityLocation(
  value: unknown,
): LocalActivityOracleQuery["location"] {
  const input = record(value, "location");
  if (input.postalCode !== undefined) {
    return {
      kind: "postal-code",
      postalCode: text(input.postalCode, "location.postalCode"),
      countryCode: text(input.countryCode, "location.countryCode"),
    };
  }
  if (input.latitude !== undefined) {
    return {
      kind: "coordinates",
      latitude: latitude(input.latitude, "location.latitude"),
      longitude: longitude(input.longitude, "location.longitude"),
      radius: finiteNumber(input.radiusMiles, "location.radiusMiles"),
      unit: "miles",
    };
  }
  invalid(
    "location",
    "a postalCode+countryCode or latitude+longitude+radiusMiles object",
  );
}

function timeWindow(value: unknown, field: string): TimeWindow {
  const input = record(value, field);
  return {
    startAt: instant(input.startAt, `${field}.startAt`),
    endAt: instant(input.endAt, `${field}.endAt`),
  };
}

const COVERAGE_SLOT_STATES = [
  "confirmed",
  "waitlisted",
  "full",
  "canceled",
  "unknown",
] as const;

function coverageSlot(value: unknown, field: string): ChildcareCoverageSlot {
  const input = record(value, field);
  const state = text(input.state, `${field}.state`);
  if (!COVERAGE_SLOT_STATES.includes(state as ChildcareCoverageSlot["state"])) {
    invalid(
      `${field}.state`,
      "confirmed, waitlisted, full, canceled, or unknown",
    );
  }
  return {
    ...timeWindow(value, field),
    state: state as ChildcareCoverageSlot["state"],
  };
}

function curationChild(value: unknown, field: string): CurationChild {
  const input = record(value, field);
  return {
    childId: text(input.childId, `${field}.childId`),
    ageYears: finiteNumber(input.ageYears, `${field}.ageYears`),
    accessibilityNeeds:
      input.accessibilityNeeds === undefined
        ? []
        : stringArray(input.accessibilityNeeds, `${field}.accessibilityNeeds`),
    scheduledLoad: integer(input.scheduledLoad, `${field}.scheduledLoad`, 0),
    maxScheduledLoad: integer(
      input.maxScheduledLoad,
      `${field}.maxScheduledLoad`,
      0,
    ),
  };
}

function custodyWindow(value: unknown, field: string): CustodyWindow {
  const input = record(value, field);
  return {
    ...timeWindow(value, field),
    childId: text(input.childId, `${field}.childId`),
  };
}

function busyWindow(value: unknown, field: string): BusyWindow {
  const input = record(value, field);
  return {
    ...timeWindow(value, field),
    participantIds: stringArray(
      input.participantIds,
      `${field}.participantIds`,
    ),
  };
}

function protectedWindow(
  value: unknown,
  field: string,
): ProtectedUnstructuredWindow {
  const input = record(value, field);
  return {
    ...timeWindow(value, field),
    windowId: text(input.windowId, `${field}.windowId`),
    childIds: stringArray(input.childIds, `${field}.childIds`),
  };
}

function activityQuery(
  params: Record<string, unknown>,
): LocalActivityOracleQuery {
  const pageSize = optionalInteger(params.pageSize, "pageSize", 1);
  const maxPages = optionalInteger(params.maxPages, "maxPages", 1);
  return {
    kind: "local-activity",
    location: activityLocation(params.location),
    startAt: instant(params.startAt, "startAt"),
    endAt: instant(params.endAt, "endAt"),
    keywords: stringArray(params.keywords, "keywords"),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(maxPages === undefined ? {} : { maxPages }),
  };
}

function collectActivities(observations: LocalActivitySourceObservation[]): {
  activities: LocalActivity[];
  unavailableSources: string[];
} {
  const activities: LocalActivity[] = [];
  const unavailableSources: string[] = [];
  for (const observation of observations) {
    if (observation.snapshot.health === "unavailable") {
      unavailableSources.push(observation.source);
    } else {
      activities.push(...observation.snapshot.value.activities);
    }
  }
  return { activities, unavailableSources };
}

async function complete(
  callback: HandlerCallback | undefined,
  result: ActionResult,
): Promise<ActionResult> {
  const resultText = result.text?.trim();
  if (!resultText) return result;
  const canonical = {
    ...result,
    text: resultText,
    userFacingText: resultText,
    verifiedUserFacing: true,
  };
  await callback?.({ text: resultText });
  return canonical;
}

export function createLocalConditionsAction(
  deps: LocalConditionsActionDependencies,
): Action {
  return {
    name: LOCAL_CONDITIONS_ACTION,
    similes: [
      "WEATHER_FORECAST",
      "LOCAL_ACTIVITIES",
      "FAMILY_OUTING_SEARCH",
      "EVENT_DISCOVERY",
      "CHILDCARE_COVERAGE",
    ],
    tags: ["domain:household", "capability:read", "surface:internal"],
    description:
      "Observe external facts for household planning: a typed point weather forecast, local activity and event discovery across registered sources, fail-closed curation of discovered activities for stated children, and childcare coverage-gap math. Never books, registers, purchases, or cancels anything; weather is evidence, only a provider can cancel its program.",
    descriptionCompressed:
      "weather forecast|local activity discovery|fail-closed curation|childcare coverage gaps; observe only",
    routingHint:
      "weather outlook, local family activity/event search, weekend outing options for the kids, or childcare coverage gap question -> LOCAL_CONDITIONS",
    contexts: ["general", "calendar", "tasks"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "External-conditions verb.",
        required: true,
        schema: { type: "string", enum: [...LOCAL_CONDITIONS_SUBACTIONS] },
      },
      {
        name: "latitude",
        description: "Forecast point latitude in decimal degrees.",
        subactions: ["weather_outlook"],
        schema: { type: "number", minimum: -90, maximum: 90 },
      },
      {
        name: "longitude",
        description: "Forecast point longitude in decimal degrees.",
        subactions: ["weather_outlook"],
        schema: { type: "number", minimum: -180, maximum: 180 },
      },
      {
        name: "includeHourly",
        description: "Include hourly forecast periods only when true.",
        subactions: ["weather_outlook"],
        schema: { type: "boolean" },
      },
      {
        name: "location",
        description:
          "Search area: { postalCode, countryCode } or { latitude, longitude, radiusMiles }.",
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "startAt",
        description: "RFC 3339 start of the activity search window.",
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "endAt",
        description: "RFC 3339 end of the activity search window.",
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "keywords",
        description: 'Search keywords, e.g. ["kids", "summer camp"].',
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "pageSize",
        description: "Source page size.",
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "maxPages",
        description: "Maximum source pages to read.",
        subactions: ["discover_activities", "curate_discovered_activities"],
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "children",
        description:
          "Children the outing is for: { childId, ageYears, scheduledLoad, maxScheduledLoad, accessibilityNeeds? }. Omit accessibilityNeeds only when the child has none.",
        subactions: ["curate_discovered_activities"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "custodyHealth",
        description:
          "How complete the supplied custody windows are. Anything but complete makes custody a verification question, never assumed coverage.",
        subactions: ["curate_discovered_activities"],
        schema: {
          type: "string",
          enum: ["complete", "partial", "unavailable"],
        },
      },
      {
        name: "custodyWindows",
        description: "Known custody windows: { childId, startAt, endAt }.",
        subactions: ["curate_discovered_activities"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "busyWindows",
        description:
          "Known busy calendar windows: { participantIds, startAt, endAt }.",
        subactions: ["curate_discovered_activities"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "protectedUnstructuredWindows",
        description:
          "Protected unstructured family time: { windowId, childIds, startAt, endAt }.",
        subactions: ["curate_discovered_activities"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "caregiverParticipantIds",
        description:
          "Caregivers who would attend. Omit only when none are decided yet.",
        subactions: ["curate_discovered_activities"],
        schema: { type: "array", items: { type: "string" } },
      },
      {
        name: "availableCaregiverHeadcount",
        description:
          "Confirmed available caregiver headcount. Omit when unknown; unknown becomes a verification question.",
        subactions: ["curate_discovered_activities"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "requiredCaregiverHeadcount",
        description:
          "Caregivers each activity requires. Omit when unknown; unknown becomes a verification question.",
        subactions: ["curate_discovered_activities"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "maxSuggestions",
        description: "Maximum activities to select.",
        subactions: ["curate_discovered_activities"],
        schema: { type: "integer", minimum: 0 },
      },
      {
        name: "requiredWindows",
        description:
          "Time windows that must be covered by childcare: { startAt, endAt }.",
        subactions: ["childcare_coverage_gaps"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "coverageSlots",
        description:
          "Care slots with state (confirmed, waitlisted, full, canceled, unknown). Omit when no care is arranged.",
        subactions: ["childcare_coverage_gaps"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return complete(callback, {
          success: false,
          text: "External-condition lookups are restricted to the authenticated owner.",
          data: { error: "PERMISSION_DENIED" },
        });
      }
      const resolved = await resolveActionArgs<
        LocalConditionsSubaction,
        Record<string, unknown>
      >({
        runtime,
        message,
        state,
        options,
        actionName: LOCAL_CONDITIONS_ACTION,
        subactions: SUBACTIONS,
      });
      if (!resolved.ok) {
        return complete(callback, {
          success: false,
          text: resolved.clarification,
          data: {
            error: "MISSING_LOCAL_CONDITIONS_PARAMETERS",
            missing: resolved.missing,
          },
        });
      }
      const params = resolved.params;
      switch (resolved.subaction) {
        case "weather_outlook": {
          const registry = getExternalOracleRegistry(runtime);
          if (!registry) {
            throw oracleError(
              "No external oracle registry is registered for this runtime",
              "ORACLE_REGISTRY_UNAVAILABLE",
              { agentId: runtime.agentId },
            );
          }
          const snapshot = (await registry.observe({
            kind: "weather",
            latitude: latitude(params.latitude, "latitude"),
            longitude: longitude(params.longitude, "longitude"),
            includeHourly: params.includeHourly === true,
          })) as OracleSnapshot<WeatherOraclePayload>;
          if (snapshot.health === "unavailable") {
            return complete(callback, {
              success: false,
              text: `The weather source (${snapshot.provenance.provider}) is unavailable right now: ${snapshot.issues
                .map((issue) => issue.code)
                .join(", ")}. No forecast exists for this request.`,
              data: { snapshot },
            });
          }
          const first = snapshot.value.periods[0];
          return complete(callback, {
            success: true,
            text: first
              ? `${snapshot.provenance.provider} forecast (${snapshot.value.point.forecastOffice}): ${first.name} — ${first.shortForecast}, ${first.temperature}°${first.temperatureUnit}. ${snapshot.value.periods.length} period(s) observed at ${snapshot.freshness.observedAt}; source data is untrusted evidence, not a schedule decision.`
              : `${snapshot.provenance.provider} returned a forecast with no periods for this point; treat coverage as ${snapshot.health}.`,
            data: { snapshot },
          });
        }
        case "discover_activities": {
          const activities = getLocalActivityAdapterRegistry(runtime);
          if (!activities) {
            throw oracleError(
              "No local-activity adapter registry is registered for this runtime",
              "ORACLE_REGISTRY_UNAVAILABLE",
              { agentId: runtime.agentId },
            );
          }
          const observations = await activities.discoverAll(
            activityQuery(params),
          );
          if (observations.length === 0) {
            return complete(callback, {
              success: false,
              text: "No local-activity sources are registered, so nothing could be discovered.",
              data: { error: "ORACLE_REGISTRY_UNAVAILABLE", observations },
            });
          }
          const { activities: found, unavailableSources } =
            collectActivities(observations);
          if (unavailableSources.length === observations.length) {
            return complete(callback, {
              success: false,
              text: `Every activity source is unavailable right now (${unavailableSources.join(", ")}). This is a source outage, not an empty result.`,
              data: { observations },
            });
          }
          const unavailableNote =
            unavailableSources.length > 0
              ? ` Source(s) unavailable and excluded from this result: ${unavailableSources.join(", ")}.`
              : "";
          return complete(callback, {
            success: true,
            text: `${found.length} activit(ies) discovered across ${observations.length - unavailableSources.length} source(s).${unavailableNote} Registration, eligibility, capacity, and purchase remain unverified human steps.`,
            data: { observations },
          });
        }
        case "curate_discovered_activities": {
          const activities = getLocalActivityAdapterRegistry(runtime);
          if (!activities) {
            throw oracleError(
              "No local-activity adapter registry is registered for this runtime",
              "ORACLE_REGISTRY_UNAVAILABLE",
              { agentId: runtime.agentId },
            );
          }
          const children = array(params.children, "children").map(
            (entry, index) => curationChild(entry, `children[${index}]`),
          );
          if (children.length === 0) {
            invalid("children", "a non-empty array of children");
          }
          const custodyHealth = text(params.custodyHealth, "custodyHealth");
          if (
            custodyHealth !== "complete" &&
            custodyHealth !== "partial" &&
            custodyHealth !== "unavailable"
          ) {
            invalid("custodyHealth", "complete, partial, or unavailable");
          }
          const caregiverParticipantIds =
            params.caregiverParticipantIds === undefined
              ? []
              : stringArray(
                  params.caregiverParticipantIds,
                  "caregiverParticipantIds",
                );
          const requiredCaregiverHeadcount = optionalInteger(
            params.requiredCaregiverHeadcount,
            "requiredCaregiverHeadcount",
            0,
          );
          const context: ActivityCurationContext = {
            children,
            custodyWindows:
              params.custodyWindows === undefined
                ? []
                : array(params.custodyWindows, "custodyWindows").map(
                    (entry, index) =>
                      custodyWindow(entry, `custodyWindows[${index}]`),
                  ),
            custodyHealth,
            busyWindows:
              params.busyWindows === undefined
                ? []
                : array(params.busyWindows, "busyWindows").map((entry, index) =>
                    busyWindow(entry, `busyWindows[${index}]`),
                  ),
            protectedUnstructuredWindows:
              params.protectedUnstructuredWindows === undefined
                ? []
                : array(
                    params.protectedUnstructuredWindows,
                    "protectedUnstructuredWindows",
                  ).map((entry, index) =>
                    protectedWindow(
                      entry,
                      `protectedUnstructuredWindows[${index}]`,
                    ),
                  ),
            // No travel facts are composed here: unknown travel time becomes a
            // verification question instead of an assumed-free commute.
            travelFacts: [],
            availableCaregiverHeadcount:
              optionalInteger(
                params.availableCaregiverHeadcount,
                "availableCaregiverHeadcount",
                0,
              ) ?? null,
            maxSuggestions: integer(params.maxSuggestions, "maxSuggestions", 0),
          };
          const observations = await activities.discoverAll(
            activityQuery(params),
          );
          if (observations.length === 0) {
            return complete(callback, {
              success: false,
              text: "No local-activity sources are registered, so nothing could be discovered or curated.",
              data: { error: "ORACLE_REGISTRY_UNAVAILABLE", observations },
            });
          }
          const { activities: found, unavailableSources } =
            collectActivities(observations);
          if (unavailableSources.length === observations.length) {
            return complete(callback, {
              success: false,
              text: `Every activity source is unavailable right now (${unavailableSources.join(", ")}). This is a source outage, not an empty result.`,
              data: { observations },
            });
          }
          const candidates: ActivityCurationCandidate[] = found.map(
            (activity) => ({
              activity,
              intendedChildIds: children.map((child) => child.childId),
              caregiverParticipantIds,
              // Sources do not verify age eligibility; a null range makes it a
              // verification question rather than an assumed fit.
              eligibleAgeRange: null,
              requiredCaregiverHeadcount: requiredCaregiverHeadcount ?? null,
            }),
          );
          const curation = curateLocalActivities(candidates, context);
          const byStatus = (status: string) =>
            curation.decisions.filter((decision) => decision.status === status)
              .length;
          const unavailableNote =
            unavailableSources.length > 0
              ? ` Source(s) unavailable and excluded: ${unavailableSources.join(", ")}.`
              : "";
          return complete(callback, {
            success: true,
            text: `Curated ${found.length} discovered activit(ies): ${byStatus("selected")} selected, ${byStatus("eligible")} eligible, ${byStatus("needs-verification")} need verification, ${byStatus("excluded")} excluded.${unavailableNote} ${curation.verificationQuestions.length} verification question(s) must be answered by a human before anything counts as coverage.`,
            data: { observations, curation },
          });
        }
        case "childcare_coverage_gaps": {
          const gaps = computeChildcareCoverageGaps(
            array(params.requiredWindows, "requiredWindows").map(
              (entry, index) => timeWindow(entry, `requiredWindows[${index}]`),
            ),
            params.coverageSlots === undefined
              ? []
              : array(params.coverageSlots, "coverageSlots").map(
                  (entry, index) =>
                    coverageSlot(entry, `coverageSlots[${index}]`),
                ),
          );
          return complete(callback, {
            success: true,
            text:
              gaps.length === 0
                ? "Confirmed care slots cover every required window. Waitlisted, full, canceled, and unverified slots were not counted."
                : `${gaps.length} uncovered window(s) remain after counting only confirmed care slots.`,
            data: { gaps },
          });
        }
      }
    },
  };
}
