/**
 * Keyless runtime proof for a coordinate-only Maps share handoff, exercising
 * the promoted action without a provider credential or external request.
 * Sharing a location is consent-gated: the first turn must only ask, and the
 * handoff exists only after the explicit confirm turn.
 */

import {
  describeCalls,
  scenario,
  successfulActionData,
  toRecord,
} from "@elizaos/testing";

const MAPS_SHARE = "MAPS_SHARE";
const PLACE = {
  name: "Eliza Research",
  address: "San Francisco, California",
};
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
          ...PLACE,
          latitude: LATITUDE,
          longitude: LONGITUDE,
        },
      },
      timeoutMs: 120_000,
    },
    {
      kind: "action",
      name: "confirm-share",
      actionName: MAPS_SHARE,
      text: `Yes, share the location of ${PLACE.name} (confirmed).`,
      options: {
        parameters: {
          ...PLACE,
          latitude: LATITUDE,
          longitude: LONGITUDE,
          confirm: true,
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
      name: "share-asks-before-handoff",
      predicate: (ctx) => {
        const calls = ctx.actionsCalled.filter(
          (call) => call.actionName === MAPS_SHARE,
        );
        const first = toRecord(calls[0]?.result?.data);
        if (calls[0]?.result?.success !== false || !first) {
          return `the unconfirmed share must not succeed; calls: ${describeCalls(ctx)}`;
        }
        if (first.reason !== "confirmation_required" || first.handoff) {
          return `the unconfirmed share must ask without a handoff, saw ${JSON.stringify(first)}`;
        }
        if (calls.length !== 2) {
          return `expected the ask and the confirmed share, saw ${describeCalls(ctx)}`;
        }
      },
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
