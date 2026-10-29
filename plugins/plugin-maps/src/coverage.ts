/**
 * States what a maps provider reports it serves, for the agent's reply: the
 * regions and dataset, travel modes, what is not served and who receives
 * search text and coordinates. Only reported facts are stated.
 */

import {
  describeLocationRecipients,
  describeMapsDisclosure,
} from "./client/cloud-provider.js";
import type { MapsCoverage, TravelMode } from "./types.js";

const MODE_NAME: Record<TravelMode, string> = {
  drive: "driving",
  walk: "walking",
  bicycle: "cycling",
  transit: "transit",
};

/** Canonical display order of travel modes. */
const MODE_ORDER: readonly TravelMode[] = [
  "drive",
  "walk",
  "bicycle",
  "transit",
];

/**
 * Travel modes to offer for a provider. A reported coverage is authoritative;
 * without one, the road modes are offered and transit is never advertised,
 * because no provider serves it unless it says so.
 */
export function offeredTravelModes(
  coverage: Pick<MapsCoverage, "travelModes"> | null | undefined,
): TravelMode[] {
  if (!coverage) return MODE_ORDER.filter((mode) => mode !== "transit");
  return MODE_ORDER.filter((mode) => coverage.travelModes.includes(mode));
}

function list(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** One paragraph describing a provider's reported coverage. */
export function describeMapsCoverage(coverage: MapsCoverage): string {
  const sentences: string[] = [];
  const regions = coverage.regions.map((region) => region.name);
  sentences.push(
    regions.length
      ? `Maps covers ${list(regions, "and")}${coverage.revision ? ` (dataset ${coverage.revision})` : ""}.`
      : "Maps does not report which regions it covers.",
  );
  sentences.push(
    coverage.travelModes.length
      ? `Routes: ${list(
          coverage.travelModes.map((mode) => MODE_NAME[mode]),
          "and",
        )}${coverage.alternatives ? ", with alternatives" : ""}.`
      : "Maps plans no routes.",
  );
  if (!coverage.reverseGeocode)
    sentences.push("It does not look up places from coordinates.");
  const absent = [
    ...(coverage.liveTraffic ? [] : ["live traffic"]),
    ...(coverage.transitSchedules ? [] : ["transit schedules"]),
    ...(coverage.offline ? [] : ["offline use"]),
  ];
  if (absent.length) sentences.push(`No ${list(absent, "or")}.`);
  if (coverage.recipients) {
    const disclosure = coverage.gatewayRecords
      ? describeMapsDisclosure({
          recipients: coverage.recipients,
          cloudRecords: coverage.gatewayRecords,
        })
      : describeLocationRecipients(coverage.recipients);
    if (disclosure) sentences.push(disclosure);
  }
  return sentences.join(" ");
}
