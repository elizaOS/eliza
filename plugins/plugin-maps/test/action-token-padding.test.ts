/**
 * A model can copy an opaque provider token out of a rendered answer together
 * with the space or line break that framed it there. Google accepts only the
 * exact place resource name and page token, so `MapsService` must hand the
 * provider the token without that framing: "/v1/places/%20ChIJ...%20" answers
 * 404 and the place is reported as absent, and a page token with a trailing
 * line break is rejected as invalid.
 *
 * The trim belongs at the model-facing boundary in `action.ts`. `MapsService`
 * itself stays lossless, because a programmatic caller or a custom adapter can
 * hand it a token whose own content starts or ends with a space.
 *
 * The real `mapsAction` handler, `MapsService`, and `GoogleMapsAdapter` run
 * here; only the HTTP transport is stubbed, and it answers like Google Maps.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { mapsAction } from "../src/action.js";
import { GoogleMapsAdapter } from "../src/google.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";

const PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";

function harness() {
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const adapter = new GoogleMapsAdapter({
    connectionId: "conn_0123456789abcdefgh",
    credential: { mode: "api-key", apiKey: "test-api-key" },
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
  const runtime = {
    getService: () => service,
  } as unknown as IAgentRuntime;
  return { service, runtime, paths, bodies };
}

async function run(params: NonNullable<HandlerOptions["parameters"]>) {
  const { runtime, service, paths, bodies } = harness();
  const message = { content: { text: "maps request" } } as unknown as Memory;
  const result = await mapsAction.handler(
    runtime,
    message,
    undefined,
    { parameters: params },
    undefined,
  );
  return { result, service, paths, bodies };
}

describe("mapsAction trims the framing a model adds to a copied token", () => {
  it("reads a place whose id arrives with the space that framed it", async () => {
    const { result, paths } = await run({
      action: "place",
      placeId: ` ${PLACE_ID} `,
      provider: "google_maps",
    });

    expect(paths).toEqual([`/v1/places/${PLACE_ID}`]);
    expect(result?.success).toBe(true);
  });

  it("asks for page two with the token, not with its trailing line break", async () => {
    const { bodies } = await run({
      action: "place",
      query: "coffee",
      cursor: "CURSOR_TOKEN\n",
      limit: 5,
    });

    expect(bodies).toEqual([
      { textQuery: "coffee", pageSize: 5, pageToken: "CURSOR_TOKEN" },
    ]);
  });
});

describe("MapsService keeps a programmatic token lossless", () => {
  it("forwards an adapter token with its own surrounding spaces", async () => {
    const { service, bodies } = harness();

    await service.searchPlaces(
      { query: "coffee", cursor: " token " },
      "google_maps",
    );

    expect(bodies).toEqual([{ textQuery: "coffee", pageToken: " token " }]);
  });

  it("forwards a place id with its own surrounding spaces", async () => {
    const { service, paths } = harness();

    await service.getPlace(` ${PLACE_ID} `, "google_maps");

    expect(paths).toEqual([
      `/v1/places/${encodeURIComponent(` ${PLACE_ID} `)}`,
    ]);
  });

  it("still rejects a cursor that holds only whitespace", async () => {
    const { service, bodies } = harness();

    await expect(
      service.searchPlaces({ query: "coffee", cursor: "  \n" }, "google_maps"),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    expect(bodies).toHaveLength(0);
  });
});
