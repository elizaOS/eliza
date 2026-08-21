/**
 * Behavior tests for the `[MAPSCARD]` parser and the MapsCardWidget renderer:
 * payload validation bounds, link-target policy, per-kind rendering, the
 * locate card's idle/locating/sent/denied/unavailable states (jsdom with an
 * injected geolocation stub), and the share receipt line. Deterministic; no
 * network or real geolocation.
 */
// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMapsCardRegions,
  isAllowedMapsUri,
  type MapsCardSpec,
  parseMapsCardBody,
} from "../message-maps-parser";
import type { InlineWidgetContext } from "./inline-registry";
import {
  formatDistance,
  formatDuration,
  formatSharedAt,
  MapsCardWidget,
} from "./maps-card";

const place = {
  name: "Blue Bottle",
  latitude: 37.77,
  longitude: -122.42,
  provider: "contract-maps",
  providerPlaceId: "p-1",
  formattedAddress: "300 Webster St",
  categories: ["coffee"],
};

function ctx(
  overrides: Partial<InlineWidgetContext> = {},
): InlineWidgetContext {
  return {
    sendAction: vi.fn(),
    navigate: vi.fn(),
    prefillComposer: vi.fn(),
    submitForm: vi.fn(),
    ...overrides,
  };
}

function marker(card: unknown): string {
  return `Here you go\n\n[MAPSCARD]\n${JSON.stringify(card)}\n[/MAPSCARD]`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("message-maps-parser", () => {
  it("parses a valid place card region", () => {
    const regions = findMapsCardRegions(marker({ kind: "place", place }));
    expect(regions).toHaveLength(1);
    expect(regions[0]?.card).toMatchObject({
      kind: "place",
      place: { name: "Blue Bottle" },
    });
  });

  it("rejects malformed JSON, unknown kinds, and out-of-range coordinates", () => {
    expect(parseMapsCardBody("not json")).toBeNull();
    expect(parseMapsCardBody(JSON.stringify({ kind: "teleport" }))).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ kind: "place", place: { ...place, latitude: 91 } }),
      ),
    ).toBeNull();
    expect(
      findMapsCardRegions("[MAPSCARD]\n{broken\n[/MAPSCARD]"),
    ).toHaveLength(0);
  });

  it("rejects handoff cards whose links leave the allowed targets", () => {
    const handoff = {
      kind: "handoff",
      handoffKind: "share",
      place,
      geoUri: "geo:37.77,-122.42?q=x",
      appleMapsUri: "https://maps.apple.com/?ll=37.77,-122.42",
      webUri: "https://www.openstreetmap.org/?mlat=37.77&mlon=-122.42",
    };
    expect(parseMapsCardBody(JSON.stringify(handoff))).not.toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...handoff, webUri: "https://evil.example/track" }),
      ),
    ).toBeNull();
    expect(
      parseMapsCardBody(
        JSON.stringify({ ...handoff, geoUri: "javascript:alert(1)" }),
      ),
    ).toBeNull();
    expect(isAllowedMapsUri("http://maps.apple.com/")).toBe(false);
  });

  it("caps places lists and requires at least one entry", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      ...place,
      providerPlaceId: `p-${index}`,
    }));
    const card = parseMapsCardBody(
      JSON.stringify({
        kind: "places",
        query: "coffee",
        places: many,
        nextCursor: "next",
      }),
    );
    if (card?.kind !== "places") throw new Error("expected places card");
    expect(card.places).toHaveLength(10);
    expect(
      parseMapsCardBody(
        JSON.stringify({ kind: "places", query: "q", places: [] }),
      ),
    ).toBeNull();
  });
});

describe("MapsCardWidget", () => {
  it("renders a place card with a directions action", () => {
    const context = ctx();
    render(
      <MapsCardWidget
        card={{ kind: "place", place, attribution: null }}
        ctx={context}
      />,
    );
    expect(screen.getByText("Blue Bottle")).toBeTruthy();
    fireEvent.click(screen.getByTestId("maps-directions-p-1"));
    expect(context.sendAction).toHaveBeenCalledWith(
      "Get directions to Blue Bottle (contract-maps place p-1)",
    );
    expect(screen.queryByTestId("maps-attribution")).toBeNull();
  });

  it("renders a paginated places list", () => {
    render(
      <MapsCardWidget
        card={{
          kind: "places",
          query: "coffee",
          places: [place, { ...place, providerPlaceId: "p-2", name: "Ritual" }],
          nextCursor: "next",
          attribution: "Places by Contract Maps",
        }}
        ctx={ctx()}
      />,
    );
    expect(screen.getByText("Ritual")).toBeTruthy();
    expect(screen.getByTestId("maps-more")).toBeTruthy();
    expect(screen.getByTestId("maps-attribution").textContent).toBe(
      "Places by Contract Maps",
    );
  });

  it("renders a route summary with formatted distance, duration, warnings", () => {
    render(
      <MapsCardWidget
        card={{
          kind: "route",
          origin: place,
          destination: { ...place, name: "Office", providerPlaceId: "p-3" },
          travelMode: "transit",
          distanceMeters: 12_345,
          durationSeconds: 4_020,
          warnings: ["Toll road"],
          attribution: null,
        }}
        ctx={ctx()}
      />,
    );
    expect(screen.getByTestId("maps-route-summary").textContent).toContain(
      "Transit · 12.3 km · 1 h 7 min",
    );
    expect(screen.getByTestId("maps-route-warnings").textContent).toContain(
      "Toll road",
    );
  });

  it("renders a share handoff with the receipt line and copy control", () => {
    render(
      <MapsCardWidget
        card={{
          kind: "handoff",
          handoffKind: "share",
          place,
          geoUri: "geo:37.77,-122.42?q=37.77,-122.42(Blue%20Bottle)",
          appleMapsUri: "https://maps.apple.com/?ll=37.77,-122.42",
          webUri: "https://www.openstreetmap.org/?mlat=37.77&mlon=-122.42",
          sharedAt: "2026-08-20T18:30:00.000Z",
        }}
        ctx={ctx()}
      />,
    );
    expect(screen.getByTestId("maps-handoff-receipt").textContent).toContain(
      "2026-08-20 18:30 UTC",
    );
    expect(screen.getByTestId("maps-handoff-copy")).toBeTruthy();
    const open = screen.getByTestId("maps-handoff-open");
    expect(open.getAttribute("target")).toBe("_blank");
  });

  it("walks the locate card through locating to sent", () => {
    const context = ctx();
    const getCurrentPosition = vi.fn(
      (
        onSuccess: (position: {
          coords: { latitude: number; longitude: number };
        }) => void,
      ) => {
        onSuccess({ coords: { latitude: 37.77, longitude: -122.42 } });
      },
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition },
    });
    render(
      <MapsCardWidget
        card={{
          kind: "locate",
          intent: "route-origin",
          prompt: "I need your precise location.",
        }}
        ctx={context}
      />,
    );
    fireEvent.click(screen.getByTestId("maps-locate-start"));
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true }),
    );
    expect(context.sendAction).toHaveBeenCalledWith(
      "My current location is latitude 37.77, longitude -122.42 (precise device location).",
    );
    expect(screen.getByTestId("maps-locate-sent")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("shows a distinct denied state with retry when permission is refused", () => {
    const getCurrentPosition = vi.fn(
      (_onSuccess: unknown, onError: (error: { code: number }) => void) => {
        onError({ code: 1 });
      },
    );
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: { getCurrentPosition },
    });
    render(
      <MapsCardWidget
        card={{ kind: "locate", intent: "place-near", prompt: "Locate?" }}
        ctx={ctx()}
      />,
    );
    fireEvent.click(screen.getByTestId("maps-locate-start"));
    expect(screen.getByTestId("maps-locate-denied")).toBeTruthy();
    expect(screen.getByTestId("maps-locate-retry")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("shows the unavailable state when geolocation is missing", () => {
    vi.stubGlobal("navigator", { ...navigator, geolocation: undefined });
    render(
      <MapsCardWidget
        card={{ kind: "locate", intent: "place-near", prompt: "Locate?" }}
        ctx={ctx()}
      />,
    );
    fireEvent.click(screen.getByTestId("maps-locate-start"));
    expect(screen.getByTestId("maps-locate-unavailable")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("formatting helpers", () => {
  it("formats distance, duration, and share timestamps deterministically", () => {
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(1_500)).toBe("1.5 km");
    expect(formatDistance(120_000)).toBe("120 km");
    expect(formatDuration(50)).toBe("1 min");
    expect(formatDuration(3_600)).toBe("1 h");
    expect(formatSharedAt("2026-08-20T18:30:00.000Z")).toBe(
      "2026-08-20 18:30 UTC",
    );
    expect(formatSharedAt("garbage")).toBe("garbage");
  });
});

// Type-level guard: the parser union stays exhaustive for the widget.
const _spec: MapsCardSpec["kind"][] = [
  "place",
  "places",
  "route",
  "handoff",
  "locate",
];
void _spec;
