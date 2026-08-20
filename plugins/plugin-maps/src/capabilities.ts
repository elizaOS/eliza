/**
 * Planner-visible capabilities for the routed /maps view. Every declaration
 * maps one-to-one to the read-only dispatch table in `interact.ts`; writes stay
 * on the promoted MAPS_SAVE action so runtime receipt settlement is never
 * bypassed through the view broker.
 */

import type { ViewCapability, ViewCapabilityParameter } from "@elizaos/core";

const QUERY_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Free-text place search query, e.g. a name, address, or kind.",
  required: true,
  minLength: 1,
  maxLength: 500,
  pattern: "\\S",
};

const PLACE_ID_PARAM: ViewCapabilityParameter = {
  type: "string",
  description: "Opaque provider place id from a prior search or saved place.",
  required: true,
  minLength: 1,
  maxLength: 512,
};

const LATITUDE_PARAM: ViewCapabilityParameter = {
  type: "number",
  description: "Latitude in decimal degrees.",
  minimum: -90,
  maximum: 90,
};

const LONGITUDE_PARAM: ViewCapabilityParameter = {
  type: "number",
  description: "Longitude in decimal degrees.",
  minimum: -180,
  maximum: 180,
};

export const MAPS_VIEW_CAPABILITIES: ViewCapability[] = [
  {
    id: "get-maps-state",
    description:
      "Read the current maps snapshot: registered providers, their required attribution, and the owner's saved places.",
  },
  {
    id: "search-places",
    description:
      "Search the active maps provider for places, optionally biased near a coordinate, with cursor pagination.",
    params: {
      query: QUERY_PARAM,
      latitude: LATITUDE_PARAM,
      longitude: LONGITUDE_PARAM,
      cursor: {
        type: "string",
        description: "Opaque pagination cursor from a prior search page.",
        minLength: 1,
        maxLength: 2048,
      },
      limit: {
        type: "integer",
        description: "Maximum results per page, from 1 to 100.",
        minimum: 1,
        maximum: 100,
      },
    },
  },
  {
    id: "get-place",
    description: "Read one place's details by its provider place id.",
    params: { placeId: PLACE_ID_PARAM },
  },
  {
    id: "plan-route-alternatives",
    description:
      "Plan routes between two known places across every travel mode (drive, walk, bicycle, transit), reporting each mode's route or its explicit failure.",
    params: {
      originPlaceId: {
        ...PLACE_ID_PARAM,
        description: "Provider place id of the route origin.",
      },
      destinationPlaceId: {
        ...PLACE_ID_PARAM,
        description: "Provider place id of the route destination.",
      },
    },
  },
  {
    id: "get-saved-places",
    description: "List the owner's durable saved places.",
  },
];
