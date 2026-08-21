/** Declares the read-only server capabilities exposed by the Maps view. */

import type { ViewCapability } from "@elizaos/core";

const PROVIDER_PARAM = {
  type: "string",
  description: "Optional registered maps provider id.",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$",
} as const;

export const MAPS_VIEW_CAPABILITIES: ViewCapability[] = [
  {
    id: "maps-describe-providers",
    description:
      "Read registered provider identities and adapter-owned attribution metadata.",
    params: {},
  },
  {
    id: "maps-search-places",
    description:
      "Search registered maps providers for normalized places. This capability is read-only.",
    params: {
      query: {
        type: "string",
        description: "Place, landmark, category, or address to find.",
        required: true,
        minLength: 1,
        maxLength: 500,
        pattern: "\\S",
      },
      provider: PROVIDER_PARAM,
      cursor: {
        type: "string",
        description: "Opaque next-page cursor from the preceding result.",
        minLength: 1,
        maxLength: 2_048,
      },
      limit: {
        type: "integer",
        description: "Maximum normalized places to return.",
        minimum: 1,
        maximum: 100,
      },
    },
  },
  {
    id: "maps-get-place",
    description:
      "Read one normalized place by its provider-owned opaque place id.",
    params: {
      placeId: {
        type: "string",
        description: "Opaque provider place id returned by search.",
        required: true,
        minLength: 1,
        maxLength: 512,
      },
      provider: PROVIDER_PARAM,
    },
  },
  {
    id: "maps-plan-route",
    description:
      "Plan one provider-backed route between two normalized places for one travel mode.",
    params: {
      origin: {
        type: "object",
        description: "Normalized PlaceRef chosen as the route origin.",
        required: true,
      },
      destination: {
        type: "object",
        description: "Normalized PlaceRef chosen as the route destination.",
        required: true,
      },
      travelMode: {
        type: "string",
        description: "Requested travel mode.",
        required: true,
        enum: ["drive", "walk", "bicycle", "transit"],
      },
      provider: PROVIDER_PARAM,
    },
  },
];
