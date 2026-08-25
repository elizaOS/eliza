/**
 * Keyless runtime proof for a coordinate-only Maps share handoff, exercising
 * the promoted action without a provider credential or external request.
 */

import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const MAPS_SHARE = "MAPS_SHARE";
const LATITUDE = 37.7749;
const LONGITUDE = -122.4194;

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "model-free",
    reason:
      "Direct action turns exercise runtime contracts without model calls.",
  },
  id: "maps.share-coordinate",
  title: "Maps: share a coordinate-defined place",
  domain: "maps",
  tags: ["maps", "share", "coordinates", "deterministic"],
  description:
    "Creates a geo handoff for explicit coordinates through the promoted MAPS_SHARE action with no provider or credentials.",
  requires: { plugins: ["@elizaos/plugin-maps"] },
  isolation: "per-scenario",
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Maps" },
  ],
  turns: [
    {
      kind: "action",
      name: "share-coordinate",
      actionName: MAPS_SHARE,
      text: "Share Eliza Research in San Francisco.",
      options: {
        parameters: {
          name: "Eliza Research",
          address: "San Francisco, California",
          latitude: LATITUDE,
          longitude: LONGITUDE,
        },
      },
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: MAPS_SHARE,
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "coordinate-share-handoff",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, MAPS_SHARE);
        const handoff = toRecord(data?.handoff);
        if (!handoff) {
          return `no successful ${MAPS_SHARE} handoff; calls: ${describeCalls(ctx)}`;
        }
        if (data?.action !== "share") {
          return `expected share action, saw ${String(data?.action)}`;
        }
        const uri = String(handoff.uri ?? "");
        if (!uri.startsWith(`geo:${LATITUDE},${LONGITUDE}`)) {
          return `expected coordinate geo URI, saw ${uri}`;
        }
      },
    },
  ],
});
