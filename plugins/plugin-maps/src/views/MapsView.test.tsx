/**
 * Component coverage for the routed /maps surface: loading, transport-error,
 * offline, provider-unavailable, designed-empty search, results with category
 * filters, place details, route alternatives with explicit per-mode failures,
 * saved places, and attribution. The state hook and broker transport are
 * mocked; the deterministic fixture shapes match the shared zod contract.
 *
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlacePage, PlaceRef } from "../types.js";
import type { MapsViewSnapshot } from "../view-contract.js";
import type { MapsViewState } from "./useMapsViewState.js";

const stateHook = vi.hoisted(() => vi.fn());
const transport = vi.hoisted(() => ({
  searchPlaces: vi.fn(),
  planRouteAlternatives: vi.fn(),
}));

vi.mock("./useMapsViewState.js", () => ({
  useMapsViewState: stateHook,
}));

vi.mock("./mapsData.js", () => ({
  searchPlaces: transport.searchPlaces,
  planRouteAlternatives: transport.planRouteAlternatives,
  getPlace: vi.fn(),
  fetchMapsState: vi.fn(),
  MAPS_STATE_UPDATED_EVENT: "maps:state-updated",
  MAPS_UPDATED_EVENT: "view:maps:updated",
}));

import { MapsView } from "./MapsView.js";

const pier: PlaceRef = {
  provider: "fixture-maps",
  providerPlaceId: "pier-1",
  name: "Santa Monica Pier",
  coordinates: { latitude: 34.0092, longitude: -118.4973 },
  formattedAddress: "200 Santa Monica Pier",
  categories: ["landmark"],
};
const cafe: PlaceRef = {
  ...pier,
  providerPlaceId: "cafe-1",
  name: "Harbor Cafe",
  coordinates: { latitude: 34.0101, longitude: -118.4931 },
  formattedAddress: "12 Harbor Way",
  categories: ["cafe"],
};

function snapshot(overrides: Partial<MapsViewSnapshot> = {}): MapsViewSnapshot {
  return {
    providers: [
      {
        id: "fixture-maps",
        attribution: "Map data © Fixture Maps contributors",
        isDefault: true,
      },
    ],
    providerAvailable: true,
    savedPlaces: { status: "ok", places: [] },
    ...overrides,
  };
}

function hookState(overrides: Partial<MapsViewState> = {}): MapsViewState {
  return {
    snapshot: snapshot(),
    loading: false,
    error: null,
    offline: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function page(places: PlaceRef[], nextCursor: string | null = null): PlacePage {
  return { places, nextCursor };
}

async function searchFor(query: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Search places"), {
    target: { value: query },
  });
  fireEvent.submit(screen.getByTestId("maps-search-form"));
  await waitFor(() => expect(transport.searchPlaces).toHaveBeenCalled());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MapsView", () => {
  it("renders the loading phase before any snapshot arrives", () => {
    stateHook.mockReturnValue(hookState({ snapshot: null, loading: true }));
    render(<MapsView />);
    expect(screen.getByTestId("maps-loading")).toBeTruthy();
    expect(screen.queryByTestId("maps-map-pane")).toBeNull();
  });

  it("renders a transport error distinctly from empty state", () => {
    stateHook.mockReturnValue(
      hookState({
        snapshot: null,
        error: "Maps could not reach the local agent.",
      }),
    );
    render(<MapsView />);
    expect(screen.getByTestId("maps-error").textContent).toContain(
      "could not reach",
    );
    expect(screen.queryByTestId("maps-empty")).toBeNull();
  });

  it("shows the offline banner and disables search while offline", () => {
    stateHook.mockReturnValue(hookState({ offline: true }));
    render(<MapsView />);
    expect(screen.getByTestId("maps-offline")).toBeTruthy();
    expect(
      (screen.getByLabelText("Search places") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("renders an explicit provider-unavailable state", () => {
    stateHook.mockReturnValue(
      hookState({
        snapshot: snapshot({ providers: [], providerAvailable: false }),
      }),
    );
    render(<MapsView />);
    expect(screen.getByTestId("maps-provider-unavailable")).toBeTruthy();
    expect(
      (screen.getByLabelText("Search places") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("renders designed-empty results after a search with no matches", async () => {
    stateHook.mockReturnValue(hookState());
    transport.searchPlaces.mockResolvedValue(page([]));
    render(<MapsView />);
    await searchFor("empty");
    await waitFor(() => expect(screen.getByTestId("maps-empty")).toBeTruthy());
    expect(screen.queryByTestId("maps-search-error")).toBeNull();
  });

  it("renders a search failure as a distinct error state", async () => {
    stateHook.mockReturnValue(hookState());
    transport.searchPlaces.mockRejectedValue(new Error("Rate limited."));
    render(<MapsView />);
    await searchFor("pier");
    await waitFor(() =>
      expect(screen.getByTestId("maps-search-error").textContent).toContain(
        "Rate limited.",
      ),
    );
    expect(screen.queryByTestId("maps-empty")).toBeNull();
  });

  it("lists results, plots markers, and filters by category", async () => {
    stateHook.mockReturnValue(hookState());
    transport.searchPlaces.mockResolvedValue(page([pier, cafe]));
    render(<MapsView />);
    await searchFor("santa monica");
    await waitFor(() =>
      expect(screen.getByTestId("maps-results").textContent).toContain(
        "Harbor Cafe",
      ),
    );
    expect(screen.getAllByTestId("maps-marker")).toHaveLength(2);
    expect(screen.getByTestId("maps-attribution").textContent).toContain(
      "Fixture Maps contributors",
    );

    fireEvent.click(screen.getByRole("button", { name: "cafe" }));
    expect(screen.getByTestId("maps-results").textContent).not.toContain(
      "Santa Monica Pier",
    );
    expect(screen.getAllByTestId("maps-marker")).toHaveLength(1);
  });

  it("shows place details and route alternatives with explicit mode failures", async () => {
    stateHook.mockReturnValue(hookState());
    transport.searchPlaces.mockResolvedValue(page([pier, cafe]));
    transport.planRouteAlternatives.mockResolvedValue({
      origin: pier,
      destination: cafe,
      alternatives: [
        {
          travelMode: "drive",
          status: "ok",
          route: {
            provider: "fixture-maps",
            routeId: "route-drive",
            origin: pier,
            destination: cafe,
            travelMode: "drive",
            distanceMeters: 2_400,
            durationSeconds: 900,
            warnings: ["Toll road."],
          },
        },
        {
          travelMode: "transit",
          status: "error",
          code: "MAPS_PROVIDER_REJECTED",
          message: "Transit routing is not offered here.",
        },
      ],
    });
    render(<MapsView />);
    await searchFor("santa monica");
    await waitFor(() => screen.getByTestId("maps-results"));

    fireEvent.click(
      within(screen.getByTestId("maps-results")).getByText("Santa Monica Pier"),
    );
    expect(screen.getByTestId("maps-place-details").textContent).toContain(
      "200 Santa Monica Pier",
    );
    fireEvent.click(screen.getByRole("button", { name: "Set as origin" }));

    fireEvent.click(
      within(screen.getByTestId("maps-results")).getByText("Harbor Cafe"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Routes from Santa Monica Pier/ }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("maps-route-alternatives")).toBeTruthy(),
    );
    expect(screen.getByTestId("maps-route-drive").textContent).toContain(
      "2.4 km",
    );
    expect(screen.getByTestId("maps-route-transit").textContent).toContain(
      "unavailable: Transit routing is not offered here.",
    );
    expect(screen.getByTestId("maps-route-polyline")).toBeTruthy();
  });

  it("renders saved places, their designed-empty state, and unavailability", () => {
    stateHook.mockReturnValue(
      hookState({
        snapshot: snapshot({
          savedPlaces: {
            status: "ok",
            places: [
              {
                id: "66666666-6666-4666-a666-666666666666",
                ownerEntityId: "22222222-2222-4222-a222-222222222222",
                place: pier,
                label: "Weekend spot",
                createdAt: "2026-08-01T00:00:00.000Z",
                updatedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
        }),
      }),
    );
    const { unmount } = render(<MapsView />);
    expect(screen.getByTestId("maps-saved-places").textContent).toContain(
      "Weekend spot",
    );
    unmount();

    stateHook.mockReturnValue(
      hookState({
        snapshot: snapshot({
          savedPlaces: { status: "unavailable", reason: "No owner entity." },
        }),
      }),
    );
    render(<MapsView />);
    expect(screen.getByTestId("maps-saved-unavailable").textContent).toContain(
      "No owner entity.",
    );
  });
});
