/**
 * Parsing of `[MAPSCARD]` wire blocks into validated card specs: per-kind field
 * bounds, handoff URI allowlisting, the place-cap overflow rule, and region
 * detection. Pure functions over string fixtures — no model, no render, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  findMapsCardRegions,
  isAllowedMapsUri,
  MAX_MAPS_CARD_PLACES,
  type MapsCardSpec,
  parseMapsCardBody,
} from "./message-maps-parser";

const FERRY_BUILDING = {
  name: "Ferry Building",
  latitude: 37.7955,
  longitude: -122.3937,
  provider: "openstreetmap",
  providerPlaceId: "w6p4v9",
};

const GOLDEN_GATE = {
  name: "Golden Gate Bridge",
  latitude: 37.8199,
  longitude: -122.4783,
  provider: "openstreetmap",
  providerPlaceId: "w9tz2s",
};

function placeCard(placeOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "place",
    attribution: "(c) OpenStreetMap contributors",
    place: { ...FERRY_BUILDING, categories: [], ...placeOverrides },
  });
}

function placesList(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    ...FERRY_BUILDING,
    name: `Spot ${i}`,
    providerPlaceId: `id-${i}`,
    categories: [],
  }));
}

describe("parseMapsCardBody", () => {
  it("returns null for payloads that are not card objects", () => {
    expect(parseMapsCardBody("{")).toBeNull();
    expect(parseMapsCardBody("[1,2]")).toBeNull();
    expect(parseMapsCardBody("null")).toBeNull();
    expect(parseMapsCardBody("42")).toBeNull();
    expect(parseMapsCardBody('"text"')).toBeNull();
    expect(parseMapsCardBody('{"kind":"mystery"}')).toBeNull();
  });

  it("parses a place card with bounds-checked coordinates", () => {
    const spec = parseMapsCardBody(
      placeCard({ formattedAddress: "1 Ferry Building, San Francisco" }),
    );
    expect(spec).toEqual({
      kind: "place",
      place: {
        ...FERRY_BUILDING,
        categories: [],
        formattedAddress: "1 Ferry Building, San Francisco",
      },
      attribution: "(c) OpenStreetMap contributors",
    });
  });

  it("omits formattedAddress when the value is empty", () => {
    const spec = parseMapsCardBody(placeCard({ formattedAddress: "" }));
    expect(spec?.kind).toBe("place");
    if (spec?.kind === "place") {
      expect("formattedAddress" in spec.place).toBe(false);
    }
  });

  it("degrades an over-long attribution to null instead of rejecting the place card", () => {
    const spec = parseMapsCardBody(
      JSON.stringify({
        kind: "place",
        attribution: "x".repeat(501),
        place: { ...FERRY_BUILDING, categories: [] },
      }),
    );
    expect(spec?.kind).toBe("place");
    if (spec?.kind === "place") {
      expect(spec.attribution).toBeNull();
    }
  });

  it("rejects places outside the coordinate ranges", () => {
    expect(parseMapsCardBody(placeCard({ latitude: 90.0001 }))).toBeNull();
    expect(parseMapsCardBody(placeCard({ latitude: -90.0001 }))).toBeNull();
    expect(parseMapsCardBody(placeCard({ longitude: 180.0001 }))).toBeNull();
    expect(parseMapsCardBody(placeCard({ latitude: "37.8" }))).toBeNull();
    expect(parseMapsCardBody(placeCard({ longitude: Number.NaN }))).toBeNull();
  });

  it("accepts places exactly on the coordinate boundaries", () => {
    expect(
      parseMapsCardBody(placeCard({ latitude: 90, longitude: -180 })),
    ).not.toBeNull();
    expect(
      parseMapsCardBody(placeCard({ latitude: -90, longitude: 180 })),
    ).not.toBeNull();
  });

  it("enforces the string-length bound on place fields", () => {
    expect(
      parseMapsCardBody(placeCard({ name: "a".repeat(300) })),
    ).not.toBeNull();
    expect(parseMapsCardBody(placeCard({ name: "b".repeat(301) }))).toBeNull();
    expect(
      parseMapsCardBody(placeCard({ providerPlaceId: undefined })),
    ).toBeNull();
  });

  it("drops invalid category entries before capping at eight", () => {
    const nineValid = Array.from({ length: 9 }, (_, i) => `cat-${i}`);
    const capped = parseMapsCardBody(placeCard({ categories: nineValid }));
    expect(capped?.kind).toBe("place");
    if (capped?.kind === "place") {
      expect(capped.place.categories).toEqual([
        "cat-0",
        "cat-1",
        "cat-2",
        "cat-3",
        "cat-4",
        "cat-5",
        "cat-6",
        "cat-7",
      ]);
    }

    const withGarbageFirst = ["", 42, null, ...nineValid];
    const filtered = parseMapsCardBody(
      placeCard({ categories: withGarbageFirst }),
    );
    expect(filtered?.kind).toBe("place");
    if (filtered?.kind === "place") {
      expect(filtered.place.categories).toHaveLength(8);
    }

    const notAnArray = parseMapsCardBody(placeCard({ categories: "dining" }));
    expect(notAnArray?.kind).toBe("place");
    if (notAnArray?.kind === "place") {
      expect(notAnArray.place.categories).toEqual([]);
    }
  });

  it("parses a places list and keeps at most MAX_MAPS_CARD_PLACES entries", () => {
    const body = JSON.stringify({
      kind: "places",
      query: "coffee near the ferry building",
      places: placesList(MAX_MAPS_CARD_PLACES + 2),
      nextCursor: "cursor-token",
      attribution: "(c) OpenStreetMap contributors",
    });
    const spec = parseMapsCardBody(body);
    expect(spec?.kind).toBe("places");
    if (spec?.kind === "places") {
      expect(spec.places).toHaveLength(MAX_MAPS_CARD_PLACES);
      expect(spec.places[MAX_MAPS_CARD_PLACES - 1].providerPlaceId).toBe(
        `id-${MAX_MAPS_CARD_PLACES - 1}`,
      );
      expect(spec.nextCursor).toBe("cursor-token");
    }
  });

  it("stops at the cap before parsing later entries, so trailing garbage after a full page is ignored", () => {
    const fullPagePlusGarbage = [
      ...placesList(MAX_MAPS_CARD_PLACES),
      { name: 12345 },
    ];
    const body = JSON.stringify({
      kind: "places",
      query: "q",
      places: fullPagePlusGarbage,
    });
    const spec = parseMapsCardBody(body);
    expect(spec?.kind).toBe("places");
    if (spec?.kind === "places") {
      expect(spec.places).toHaveLength(MAX_MAPS_CARD_PLACES);
    }
  });

  it("rejects a places card whose entries fail validation below the cap", () => {
    const shortListWithGarbage = [...placesList(9), { name: 12345 }];
    const body = JSON.stringify({
      kind: "places",
      query: "q",
      places: shortListWithGarbage,
    });
    expect(parseMapsCardBody(body)).toBeNull();
  });

  it("requires a bounded query and at least one place", () => {
    const base = { kind: "places", places: placesList(1) };
    expect(parseMapsCardBody(JSON.stringify(base))).toBeNull();
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, query: "q".repeat(501) })),
    ).toBeNull();
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, query: "ok", places: [] })),
    ).toBeNull();
  });

  it("degrades an over-long nextCursor to null instead of rejecting the card", () => {
    const body = JSON.stringify({
      kind: "places",
      query: "q",
      places: placesList(1),
      nextCursor: "c".repeat(2049),
    });
    const spec = parseMapsCardBody(body);
    expect(spec?.kind).toBe("places");
    if (spec?.kind === "places") {
      expect(spec.nextCursor).toBeNull();
    }
  });

  it("parses a route card with a known travel mode", () => {
    const body = JSON.stringify({
      kind: "route",
      origin: FERRY_BUILDING,
      destination: GOLDEN_GATE,
      travelMode: "walk",
      distanceMeters: 8500,
      durationSeconds: 6600,
      warnings: ["Steep climb up Filbert Street"],
      attribution: "(c) OpenStreetMap contributors",
    });
    const spec = parseMapsCardBody(body);
    expect(spec).toEqual({
      kind: "route",
      origin: { ...FERRY_BUILDING, categories: [] },
      destination: { ...GOLDEN_GATE, categories: [] },
      travelMode: "walk",
      distanceMeters: 8500,
      durationSeconds: 6600,
      warnings: ["Steep climb up Filbert Street"],
      attribution: "(c) OpenStreetMap contributors",
    });
  });

  it("rejects routes with unknown travel modes or out-of-range metrics", () => {
    const base = {
      kind: "route",
      origin: FERRY_BUILDING,
      destination: GOLDEN_GATE,
      travelMode: "drive",
      distanceMeters: 100,
      durationSeconds: 60,
    };
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, travelMode: "fly" })),
    ).toBeNull();
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, distanceMeters: -1 })),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...base, durationSeconds: 10_000_001 }),
      ),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...base, distanceMeters: 50_000_000 }),
      ),
    ).not.toBeNull();
  });

  it("defaults warnings to empty, drops oversized ones, and caps at eight", () => {
    const base = {
      kind: "route",
      origin: FERRY_BUILDING,
      destination: GOLDEN_GATE,
      travelMode: "transit",
      distanceMeters: 100,
      durationSeconds: 60,
    };
    const defaulted = parseMapsCardBody(JSON.stringify({ ...base }));
    expect(defaulted?.kind).toBe("route");
    if (defaulted?.kind === "route") {
      expect(defaulted.warnings).toEqual([]);
    }

    const mixed = [
      "w".repeat(501),
      ...Array.from({ length: 9 }, (_, i) => `w${i}`),
    ];
    const filtered = parseMapsCardBody(
      JSON.stringify({ ...base, warnings: mixed }),
    );
    expect(filtered?.kind).toBe("route");
    if (filtered?.kind === "route") {
      expect(filtered.warnings).toEqual([
        "w0",
        "w1",
        "w2",
        "w3",
        "w4",
        "w5",
        "w6",
        "w7",
      ]);
    }

    const notAnArray = parseMapsCardBody(
      JSON.stringify({ ...base, warnings: "icy road" }),
    );
    if (notAnArray?.kind === "route") {
      expect(notAnArray.warnings).toEqual([]);
    }
  });

  it("allows handoff cards only toward whitelisted map origins", () => {
    const base = {
      kind: "handoff",
      handoffKind: "share",
      place: FERRY_BUILDING,
      geoUri: "geo:37.7955,-122.3937",
      appleMapsUri: "https://maps.apple.com/?q=Ferry+Building",
      webUri: "https://www.openstreetmap.org/?mlat=37.7955&mlon=-122.3937",
      sharedAt: "2026-08-24T12:00:00Z",
    };
    const spec: MapsCardSpec | null = parseMapsCardBody(JSON.stringify(base));
    expect(spec?.kind).toBe("handoff");

    expect(
      parseMapsCardBody(JSON.stringify({ ...base, handoffKind: "navigate" })),
    ).not.toBeNull();
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, handoffKind: "open" })),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...base, webUri: "https://evil.example/maps" }),
      ),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...base, geoUri: "geo:not-a-coordinate" }),
      ),
    ).toBeNull();
    expect(
      parseMapsCardBody(JSON.stringify({ ...base, appleMapsUri: 123 })),
    ).toBeNull();
  });

  it("omits sharedAt when it is absent or unbounded-valid", () => {
    const base = {
      kind: "handoff",
      handoffKind: "share",
      place: FERRY_BUILDING,
      geoUri: "geo:37.7955,-122.3937",
      appleMapsUri: "https://maps.apple.com/?q=Ferry+Building",
      webUri: "https://maps.apple.com/?q=Ferry+Building",
    };
    const withoutSharedAt = parseMapsCardBody(JSON.stringify(base));
    expect(withoutSharedAt?.kind).toBe("handoff");
    if (withoutSharedAt?.kind === "handoff") {
      expect("sharedAt" in withoutSharedAt).toBe(false);
    }

    const withEmptySharedAt = parseMapsCardBody(
      JSON.stringify({ ...base, sharedAt: "" }),
    );
    if (withEmptySharedAt?.kind === "handoff") {
      expect("sharedAt" in withEmptySharedAt).toBe(false);
    }
  });

  it("parses locate cards for both intents", () => {
    expect(
      parseMapsCardBody(
        '{"kind":"locate","intent":"place-near","prompt":"ramen near me"}',
      ),
    ).toEqual({
      kind: "locate",
      intent: "place-near",
      prompt: "ramen near me",
    });
    expect(
      parseMapsCardBody(
        '{"kind":"locate","intent":"route-origin","prompt":"start at home"}',
      )?.kind,
    ).toBe("locate");
    expect(
      parseMapsCardBody(
        '{"kind":"locate","intent":"somewhere-else","prompt":"ramen"}',
      ),
    ).toBeNull();
    expect(
      parseMapsCardBody('{"kind":"locate","intent":"place-near","prompt":""}'),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        `{"kind":"locate","intent":"place-near","prompt":"${"p".repeat(501)}"}`,
      ),
    ).toBeNull();
  });
});

describe("isAllowedMapsUri", () => {
  it("accepts geo URIs that begin with a coordinate digit", () => {
    expect(isAllowedMapsUri("geo:37.7955,-122.3937")).toBe(true);
    expect(isAllowedMapsUri("geo:-33.8688,151.2093")).toBe(true);
  });

  it("rejects geo-shaped strings without a leading digit", () => {
    expect(isAllowedMapsUri("geo:")).toBe(false);
    expect(isAllowedMapsUri("geo:not-a-coordinate")).toBe(false);
    expect(isAllowedMapsUri("geo:+120.5,-45")).toBe(false);
    expect(isAllowedMapsUri("geography:1")).toBe(false);
  });

  it("accepts https links only to Apple Maps or OpenStreetMap", () => {
    expect(isAllowedMapsUri("https://maps.apple.com/?q=Ferry+Building")).toBe(
      true,
    );
    expect(
      isAllowedMapsUri("https://www.openstreetmap.org/#map=17/37.79/-122.39"),
    ).toBe(true);
  });

  it("rejects other schemes and lookalike hosts", () => {
    expect(isAllowedMapsUri("http://maps.apple.com/?q=x")).toBe(false);
    expect(isAllowedMapsUri("https://evil.example/?q=x")).toBe(false);
    expect(isAllowedMapsUri("https://maps.apple.com.evil.example/x")).toBe(
      false,
    );
    expect(isAllowedMapsUri("ftp://www.openstreetmap.org/x")).toBe(false);
  });

  it("rejects unparseable URIs from untrusted payloads", () => {
    expect(isAllowedMapsUri("not a uri")).toBe(false);
  });
});

describe("findMapsCardRegions", () => {
  it("reports exact fence-to-fence offsets for a single card", () => {
    const body = '{"kind":"locate","intent":"place-near","prompt":"coffee"}';
    const block = `[MAPSCARD]\n${body}\n[/MAPSCARD]`;
    const text = `Look here:\n${block}\nThat was a card.`;
    const regions = findMapsCardRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].start).toBe(text.indexOf("[MAPSCARD]"));
    expect(regions[0].end - regions[0].start).toBe(block.length);
    expect(text.slice(regions[0].start, regions[0].end)).toBe(block);
    expect(regions[0].card).toEqual({
      kind: "locate",
      intent: "place-near",
      prompt: "coffee",
    });
  });

  it("collects every valid card and keeps scanning past malformed ones", () => {
    const good1 = '{"kind":"locate","intent":"place-near","prompt":"a"}';
    const bad = '{"kind":"mystery"}';
    const good2 = '{"kind":"locate","intent":"route-origin","prompt":"b"}';
    const text = [
      `[MAPSCARD]\n${good1}\n[/MAPSCARD]`,
      "middle prose",
      `[MAPSCARD]\n${bad}\n[/MAPSCARD]`,
      "tail prose",
      `[MAPSCARD]\n${good2}\n[/MAPSCARD]`,
    ].join("\n");
    const regions = findMapsCardRegions(text);
    expect(regions).toHaveLength(2);
    expect(regions[0].card.kind).toBe("locate");
    if (regions[0].card.kind === "locate") {
      expect(regions[0].card.intent).toBe("place-near");
    }
    expect(regions[1].start).toBeGreaterThan(regions[0].end);
    if (regions[1].card.kind === "locate") {
      expect(regions[1].card.intent).toBe("route-origin");
    }
  });

  it("tolerates padded fences and CRLF line endings", () => {
    const body = '{"kind":"locate","intent":"place-near","prompt":"tea"}';
    const text = `[ MAPSCARD ]\r\n${body}\r\n[ / MAPSCARD ]`;
    const regions = findMapsCardRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].card.kind).toBe("locate");
  });

  it("returns nothing for text without a well-formed card", () => {
    expect(findMapsCardRegions("just prose, no cards")).toEqual([]);
    expect(findMapsCardRegions("[MAPSCARD]no newline body[/MAPSCARD]")).toEqual(
      [],
    );
    expect(findMapsCardRegions("[MAPSCARD]\n{}\n[/MAPSCARD")).toEqual([]);
  });

  it("does not leak global-regex state between calls", () => {
    const twoCards = [
      `[MAPSCARD]\n${'{"kind":"locate","intent":"place-near","prompt":"a"}'}\n[/MAPSCARD]`,
      `[MAPSCARD]\n${'{"kind":"locate","intent":"place-near","prompt":"b"}'}\n[/MAPSCARD]`,
    ].join("\n");
    expect(findMapsCardRegions(twoCards)).toHaveLength(2);

    const singleCard = `[MAPSCARD]\n${'{"kind":"locate","intent":"place-near","prompt":"c"}'}\n[/MAPSCARD]`;
    expect(findMapsCardRegions(singleCard)).toHaveLength(1);
  });
});
