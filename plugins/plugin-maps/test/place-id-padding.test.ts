/**
 * A place id or a page cursor that a model copies out of a rendered answer can
 * carry the space or line break that framed it there. Google accepts only the
 * exact place resource name, so `MapsService` must hand the provider the
 * trimmed token: "/v1/places/%20ChIJ...%20" answers 404 and the place is
 * reported as absent.
 *
 * The real `GoogleMapsAdapter` and `MapsService` run here; only the HTTP
 * transport is stubbed, and it answers like Google Maps.
 */
import { describe, expect, it } from "vitest";
import { GoogleMapsAdapter } from "../src/google.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";

const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";

function harness() {
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const adapter = new GoogleMapsAdapter({
    connectionId: "conn_0123456789abcdefgh",
    credential: { mode: "api-key", apiKey: "test-key" },
    placesEndpoint: "https://places.example.test",
    routesEndpoint: "https://routes.example.test",
    placeCacheTtlMs: 0,
    testTransport: {
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
        if (url.pathname.includes("searchText")) {
          return Response.json({ places: [] });
        }
        const resource = decodeURIComponent(
          url.pathname.split("/v1/places/")[1] ?? "",
        );
        if (resource !== PLACE_ID) {
          return Response.json(
            { error: { code: 404, status: "NOT_FOUND" } },
            { status: 404 },
          );
        }
        return Response.json({
          id: PLACE_ID,
          displayName: { text: "Eliza Cafe" },
          location: { latitude: 51.5, longitude: -0.12 },
          formattedAddress: "1 Test Street",
          types: ["cafe"],
        });
      },
    },
  });
  const service = new MapsService(undefined, {} as SavedPlaceStore);
  service.registerAdapter(adapter);
  return { service, paths, bodies };
}

describe("MapsService trims provider tokens the model copied with framing", () => {
  it("reads a place whose id arrives with the space that framed it", async () => {
    const { service, paths } = harness();

    const place = await service.getPlace(` ${PLACE_ID} `, "google_maps");

    expect(paths).toEqual([`/v1/places/${PLACE_ID}`]);
    expect(place?.name).toBe("Eliza Cafe");
  });

  it("asks for page two with the token, not with its trailing line break", async () => {
    const { service, bodies } = harness();

    await service.searchPlaces(
      { query: "coffee", cursor: "CURSOR_TOKEN\n", limit: 5 },
      "google_maps",
    );

    expect(bodies).toEqual([
      { textQuery: "coffee", pageSize: 5, pageToken: "CURSOR_TOKEN" },
    ]);
  });

  it("still refuses a cursor that is only whitespace", async () => {
    const { service, bodies } = harness();

    await expect(
      service.searchPlaces({ query: "coffee", cursor: "  \n" }, "google_maps"),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    expect(bodies).toHaveLength(0);
  });
});
