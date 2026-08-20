/**
 * Live-model proof for the provider-neutral Maps save path.
 *
 * The model must select the promoted receipt-enforced action and extract a
 * coordinate-defined place without an external maps provider. The final check
 * then verifies both the action receipt and the saved row through the real
 * scenario runtime's PGlite-backed Maps service.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const MAPS_SAVE = "MAPS_SAVE";
const LATITUDE = 47.6097;
const LONGITUDE = -122.3425;

interface SavedPlaceArtifact {
  id: string;
  ownerEntityId: string;
  label: string;
  place: {
    provider: string;
    providerPlaceId: string;
    name: string;
    formattedAddress?: string;
    coordinates: { latitude: number; longitude: number };
  };
}

interface MapsServiceSurface {
  listSavedPlaces(ownerEntityId: string): Promise<SavedPlaceArtifact[]>;
}

interface RuntimeSurface {
  getService(name: string): unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export default scenario({
  lane: "live-only",
  id: "maps.save-coordinate-live",
  title: "Save a coordinate-defined place with Maps",
  domain: "maps",
  tags: ["maps", "saved-place", "live-model", "receipt", "pglite"],
  description:
    "Asks a live model to save Pike Place Market from explicit coordinates, then verifies selection, extracted tool arguments, the canonical effect receipt, and durable Maps state.",

  requires: { plugins: ["@elizaos/plugin-maps"] },
  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Maps saved-place proof",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "save-pike-place",
      room: "main",
      text: "Please use my Maps integration to save Pike Place Market as a Favorite. It is at 85 Pike Street, Seattle, WA 98101, at latitude 47.6097 and longitude -122.3425. Avoid creating a duplicate if this request is retried.",
      expectedActions: [MAPS_SAVE],
      timeoutMs: 180_000,
      responseIncludesAny: ["saved", "already saved", "Favorite"],
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: MAPS_SAVE,
    },
    {
      type: "selectedActionArguments",
      actionName: MAPS_SAVE,
      includesAll: [
        "Pike Place Market",
        "Favorite",
        "47.6097",
        "-122.3425",
        "85 Pike Street",
      ],
    },
    {
      type: "actionCalled",
      actionName: MAPS_SAVE,
      status: "success",
      minCount: 1,
    },
    {
      type: "modelCallOccurred",
      purpose: "action",
      includesAny: [MAPS_SAVE, "Pike Place Market"],
      minCount: 1,
    },
    {
      type: "custom",
      name: "maps-save-receipt-and-durable-state",
      predicate: async (ctx) => {
        const calls = ctx.actionsCalled.filter(
          (entry) => entry.actionName === MAPS_SAVE,
        );
        if (calls.length !== 1) {
          return `expected exactly one ${MAPS_SAVE} call, saw ${calls.length}`;
        }
        const call = calls[0];
        if (!call?.result?.success) {
          return `the sole ${MAPS_SAVE} call did not succeed`;
        }

        const data = record(call.result.data);
        const savedPlace = record(data?.savedPlace) as
          | (Record<string, unknown> & SavedPlaceArtifact)
          | null;
        if (!savedPlace) return "MAPS_SAVE returned no savedPlace artifact";
        const place = record(savedPlace.place) as
          | (Record<string, unknown> & SavedPlaceArtifact["place"])
          | null;
        if (
          savedPlace.label !== "Favorite" ||
          place?.provider !== "coordinates" ||
          place.name !== "Pike Place Market" ||
          place.coordinates?.latitude !== LATITUDE ||
          place.coordinates?.longitude !== LONGITUDE
        ) {
          return `unexpected saved-place artifact: ${JSON.stringify(savedPlace)}`;
        }
        if (data?.replayed !== false || data?.currentlyApplied !== true) {
          return `expected a newly applied save, saw ${JSON.stringify(data)}`;
        }

        const raw = record(call.result.raw);
        const receipts = Array.isArray(raw?.effectReceipts)
          ? raw.effectReceipts
          : [];
        const receipt = record(receipts[0]);
        const idempotency = record(receipt?.idempotency);
        const commit = record(receipt?.commit);
        if (
          receipts.length !== 1 ||
          receipt?.operation !== "maps.saved-place.save" ||
          receipt.outcome !== "applied" ||
          typeof idempotency?.key !== "string" ||
          idempotency.key.trim().length === 0 ||
          idempotency.replayed !== false ||
          commit?.kind !== "durable" ||
          commit.id !== data?.commitId ||
          commit.committedAt !== data?.committedAt
        ) {
          return `invalid MAPS_SAVE effect receipt: ${JSON.stringify(receipts)}`;
        }

        const runtime = ctx.runtime as RuntimeSurface | undefined;
        const service = runtime?.getService("maps") as
          | MapsServiceSurface
          | null
          | undefined;
        if (!service || typeof service.listSavedPlaces !== "function") {
          return "the live scenario runtime did not expose the Maps service";
        }
        const persisted = await service.listSavedPlaces(
          savedPlace.ownerEntityId,
        );
        if (
          persisted.length !== 1 ||
          persisted[0]?.id !== savedPlace.id ||
          persisted[0]?.label !== "Favorite" ||
          persisted[0]?.place.coordinates.latitude !== LATITUDE ||
          persisted[0]?.place.coordinates.longitude !== LONGITUDE
        ) {
          return `PGlite-backed Maps state did not match the action artifact: ${JSON.stringify(persisted)}`;
        }
      },
    },
  ],
});
