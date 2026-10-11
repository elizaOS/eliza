/**
 * Planner-facing JSON Schema for the nested HOUSEHOLD_RESOURCE_CAPACITY
 * parameters.
 *
 * Mirrors the shape types.ts normalizes, so the tool schema shows the planner
 * the contract (including the required schemaVersion constant) and
 * validateToolArgs rejects a wrong shape before the handler. Enum values come
 * from types.ts; cross-field rules (window ordering, authorization state vs.
 * revocation, need/child references) stay in the domain normalizers.
 */
import type { ActionParameterSchema } from "@elizaos/core";
import {
  CAR_SEAT_CLASSES,
  CAR_SEAT_INSTALLATION_STATES,
  RESOURCE_ASSIGNMENT_ROLES,
  RESOURCE_AUTHORIZATION_STATES,
  RESOURCE_AVAILABILITY_STATES,
  RESOURCE_CAPACITY_POLICY_VERSION,
} from "./types.js";

type Properties = Record<string, ActionParameterSchema>;

const text = (description?: string): ActionParameterSchema => ({
  type: "string",
  minLength: 1,
  ...(description ? { description } : {}),
});

const TIMESTAMP = "ISO-8601 timestamp with Z or an explicit UTC offset";

const timestamp = (description?: string): ActionParameterSchema =>
  text(description ? `${description} ${TIMESTAMP}.` : `${TIMESTAMP}.`);

/** Required key that carries either a value or an explicit null. */
const nullable = (
  schema: ActionParameterSchema,
  description: string,
): ActionParameterSchema => ({
  anyOf: [schema, { type: "null" }],
  description,
});

const nullableTimestamp = (description: string): ActionParameterSchema =>
  nullable(
    { type: "string", minLength: 1 },
    `${description} ${TIMESTAMP}, or null.`,
  );

const ids = (description?: string): ActionParameterSchema => ({
  type: "array",
  items: { type: "string", minLength: 1 },
  ...(description ? { description } : {}),
});

const integer = (minimum: number, maximum: number): ActionParameterSchema => ({
  type: "integer",
  minimum,
  maximum,
});

/** Closed object whose every declared property is required. */
function record(
  properties: Properties,
  description?: string,
): ActionParameterSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

const seatClass: ActionParameterSchema = {
  type: "string",
  enum: [...CAR_SEAT_CLASSES],
};

const authorization = record({
  state: { type: "string", enum: [...RESOURCE_AUTHORIZATION_STATES] },
  validFrom: timestamp(),
  expiresAt: nullableTimestamp("Required for an expired authorization."),
  revokedAt: nullableTimestamp("Set only for a revoked authorization."),
  authorizedByEntityIds: ids("Non-empty; adults who granted the authority."),
  evidenceRefs: ids("Non-empty; evidence for the authority."),
});

const availabilityWindow = record({
  windowId: text(),
  state: { type: "string", enum: [...RESOURCE_AVAILABILITY_STATES] },
  startsAt: timestamp(),
  endsAt: timestamp(),
  sourceRef: text("Source that asserted this availability."),
  observedAt: timestamp(),
  expiresAt: nullableTimestamp("When the evidence stops being current."),
});

function resourceVariant(
  kind: "caregiver" | "vehicle" | "car_seat",
  specific: Properties,
): ActionParameterSchema {
  return record(
    {
      schemaVersion: {
        type: "string",
        enum: [RESOURCE_CAPACITY_POLICY_VERSION],
      },
      resourceId: text("Stable resource identifier."),
      householdId: text(),
      kind: { type: "string", enum: [kind] },
      label: text("Owner-visible resource name."),
      active: { type: "boolean" },
      capabilityIds: ids("May be empty."),
      authorization,
      availability: {
        type: "array",
        items: availabilityWindow,
        description: "Non-empty source-grounded availability windows.",
      },
      ...specific,
    },
    `A ${kind} resource.`,
  );
}

export const RESOURCE_DEFINITION_SCHEMA: ActionParameterSchema = {
  anyOf: [
    resourceVariant("caregiver", {
      caregiverEntityId: text("Knowledge-graph entity ID of the caregiver."),
      authorizedChildEntityIds: ids("Non-empty."),
      maximumConcurrentChildren: integer(1, 100),
      trainingCapabilityIds: ids("May be empty."),
    }),
    resourceVariant("vehicle", {
      assetRef: text("Stable reference to the vehicle asset."),
      passengerCapacity: integer(1, 100),
      authorizedOperatorEntityIds: ids("Non-empty."),
      supportedCarSeatResourceIds: ids("May be empty."),
      accessibilityCapabilityIds: ids("May be empty."),
    }),
    resourceVariant("car_seat", {
      seatClass,
      compatibleChildEntityIds: ids("Non-empty."),
      compatibleVehicleResourceIds: ids("Non-empty."),
      installationState: {
        type: "string",
        enum: [...CAR_SEAT_INSTALLATION_STATES],
      },
      installationEvidenceRef: nullable(
        { type: "string", minLength: 1 },
        "Evidence reference; required when installationState is confirmed, otherwise may be null.",
      ),
      installationObservedAt: nullableTimestamp(
        "Required when installationState is confirmed.",
      ),
      installationExpiresAt: nullableTimestamp(
        "Must follow installationObservedAt.",
      ),
    }),
  ],
};

const handoff = record({
  handoffId: text(),
  kind: { type: "string", enum: ["pickup", "dropoff"] },
  startsAt: timestamp(),
  endsAt: timestamp(),
  locationRef: text(),
  requiredPrincipalEntityIds: ids("May be empty."),
});

const requirements = record({
  caregiverCount: integer(0, 20),
  caregiverCapabilityIds: ids("May be empty."),
  vehicleRequired: {
    type: "boolean",
    description: "Must be true when passengers or car seats are required.",
  },
  passengerCount: integer(0, 100),
  carSeats: {
    type: "array",
    items: record({ childEntityId: text(), seatClass }),
    description: "One entry per child of this need who needs a restraint.",
  },
  accessibilityCapabilityIds: ids("May be empty."),
});

const need = record({
  needId: text("Unique within the plan."),
  title: text(),
  startsAt: timestamp(),
  endsAt: timestamp(),
  preparationMinutes: integer(0, 24 * 60),
  recoveryMinutes: integer(0, 24 * 60),
  originLocationRef: text(),
  destinationLocationRef: text(),
  childEntityIds: ids("Non-empty subset of plan.childEntityIds."),
  requirements,
  handoffs: { type: "array", items: handoff },
  sourceRefs: ids("Non-empty; sources that ground this need."),
});

export const CAPACITY_PLAN_SCHEMA = record({
  householdId: text(),
  title: text(),
  childEntityIds: ids("Non-empty; every child any need covers."),
  needs: { type: "array", items: need, description: "Non-empty." },
});

export const CAPACITY_ASSIGNMENTS_SCHEMA: ActionParameterSchema = {
  type: "array",
  items: record({
    needId: text("A needId from plan.needs."),
    resourceId: text(),
    role: { type: "string", enum: [...RESOURCE_ASSIGNMENT_ROLES] },
  }),
};

export const CAPACITY_TRANSITIONS_SCHEMA: ActionParameterSchema = {
  type: "array",
  items: record({
    resourceId: text(),
    fromNeedId: text("A needId from plan.needs."),
    toNeedId: text("A different needId from plan.needs."),
    minimumMinutes: integer(0, 7 * 24 * 60),
    sourceRef: text(),
    observedAt: timestamp(),
    expiresAt: nullableTimestamp("When the evidence stops being current."),
  }),
};
