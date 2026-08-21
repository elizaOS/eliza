// @vitest-environment jsdom

/**
 * Exercises the real Maps React state machine with a deterministic transport:
 * success, stale-response ordering, route alternatives, handoffs, and failures.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAPS_TEST_CHAT_PREFILL_EVENT,
  type MapsTestChatPrefillDetail,
} from "../../test/shims/ui-events.js";
import {
  mapsTestActionNotices,
  resetMapsTestActionNotices,
} from "../../test/shims/ui-state.js";
import type { PlacePage, PlaceRef, RoutePlan, TravelMode } from "../types.js";
import { MapsView } from "./MapsView.js";
import type { MapsViewTransport } from "./maps-view-data.js";

function place(
  id: string,
  name: string,
  categories: string[],
  latitude: number,
  longitude: number,
): PlaceRef {
  return {
    provider: "fixture_maps",
    providerPlaceId: id,
    name,
    formattedAddress: `${id} Market Street, San Francisco`,
    coordinates: { latitude, longitude },
    categories,
  };
}

const FERRY = place(
  "ferry-building",
  "Ferry Building",
  ["landmark", "food"],
  37.7955,
  -122.3937,
);
const PLAZA = place(
  "embarcadero-plaza",
  "Embarcadero Plaza",
  ["park"],
  37.7951,
  -122.3964,
);
const PIER = place("pier-7", "Pier 7", ["landmark"], 37.8, -122.394);

function route(mode: TravelMode): RoutePlan {
  return {
    provider: "fixture_maps",
    routeId: `route-${mode}`,
    origin: FERRY,
    destination: PLAZA,
    travelMode: mode,
    distanceMeters: mode === "walk" ? 450 : 620,
    durationSeconds: mode === "walk" ? 360 : 240,
    warnings: mode === "bicycle" ? ["Walk bicycles on the promenade."] : [],
  };
}

function transport(over: Partial<MapsViewTransport> = {}): MapsViewTransport {
  return {
    describeProviders: vi.fn(async () => [
      {
        id: "fixture_maps",
        attribution: "Map data © Fixture Maps",
      },
    ]),
    search: vi.fn(async () => ({ places: [FERRY, PLAZA], nextCursor: null })),
    getPlace: vi.fn(async (value) => value),
    planRoute: vi.fn(async (_origin, _destination, mode) => route(mode)),
    ...over,
  };
}

async function searchFor(
  user: ReturnType<typeof userEvent.setup>,
  query: string,
) {
  const input = screen.getByRole("textbox", {
    name: "Search places or addresses",
  });
  await user.clear(input);
  await user.type(input, query);
  await user.click(screen.getByRole("button", { name: /^search(?:ing)?$/i }));
}

describe("MapsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMapsTestActionNotices();
  });
  afterEach(cleanup);

  it("searches, filters, selects details, and exposes provider attribution", async () => {
    const user = userEvent.setup();
    render(<MapsView transport={transport()} online />);

    expect(
      screen.getAllByText("Find somewhere worth going").length,
    ).toBeGreaterThan(0);
    await searchFor(user, "waterfront");

    expect(
      (await screen.findAllByText("Ferry Building")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Embarcadero Plaza")).toBeTruthy();
    expect(await screen.findByText("Map data © Fixture Maps")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "park" }));
    expect(
      document.querySelector(
        '[data-agent-id="maps-place-fixture_maps:ferry-building"]',
      ),
    ).toBeNull();
    expect(screen.getByText("Embarcadero Plaza")).toBeTruthy();
  });

  it("loads provider metadata after provider-backed results become available", async () => {
    let providerReady = false;
    const describeProviders = vi.fn(async () =>
      providerReady
        ? [{ id: "fixture_maps", attribution: "Late legal attribution" }]
        : [],
    );
    const user = userEvent.setup();
    render(
      <MapsView
        transport={transport({
          describeProviders,
          search: vi.fn(async () => {
            providerReady = true;
            return { places: [FERRY], nextCursor: null };
          }),
        })}
        online
      />,
    );

    expect(describeProviders).not.toHaveBeenCalled();
    await searchFor(user, "waterfront");
    expect(await screen.findByText("Late legal attribution")).toBeTruthy();
    expect(describeProviders).toHaveBeenCalledTimes(1);
  });

  it("retries failed metadata after a successful repeat search", async () => {
    const describeProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata temporarily unavailable"))
      .mockResolvedValueOnce([
        { id: "fixture_maps", attribution: "Recovered legal attribution" },
      ]);
    const user = userEvent.setup();
    render(<MapsView transport={transport({ describeProviders })} online />);

    await searchFor(user, "waterfront");
    expect(
      await screen.findByText("Legal attribution unavailable for fixture_maps"),
    ).toBeTruthy();

    await searchFor(user, "waterfront");
    expect(await screen.findByText("Recovered legal attribution")).toBeTruthy();
    expect(describeProviders).toHaveBeenCalledTimes(2);
  });

  it("keeps prior results and attribution coherent while a replacement search is pending, and after it fails", async () => {
    const describeProviders = vi.fn<
      NonNullable<MapsViewTransport["describeProviders"]>
    >(async () => [
      { id: "fixture_maps", attribution: "Current legal attribution" },
    ]);
    let rejectReplacementSearch: ((reason: unknown) => void) | undefined;
    const search = vi
      .fn<MapsViewTransport["search"]>()
      .mockResolvedValueOnce({ places: [FERRY], nextCursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectReplacementSearch = reject;
          }),
      );
    const user = userEvent.setup();
    render(
      <MapsView transport={transport({ describeProviders, search })} online />,
    );

    await searchFor(user, "first");
    expect(
      (await screen.findAllByText("Ferry Building")).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText("Current legal attribution")).toBeTruthy();
    await waitFor(() => expect(describeProviders).toHaveBeenCalledTimes(1));

    await searchFor(user, "second");
    // The replacement search is still in flight: the places list shows its
    // loading skeleton (expected UI), but the map's attribution — driven by
    // the still-unchanged `places`/`providers` state, not by search phase —
    // must keep showing the prior search's legal notice untouched, never a
    // stripped/mismatched "unavailable" placeholder.
    expect(screen.getByText("Current legal attribution")).toBeTruthy();
    expect(screen.queryByText(/attribution unavailable/i)).toBeNull();
    expect(describeProviders).toHaveBeenCalledTimes(1);

    rejectReplacementSearch?.(new Error("search backend unavailable"));
    await screen.findByText("search backend unavailable");

    // A failed replacement search must not clear the still-valid prior
    // results or strip their attribution — the {places, providers} pair only
    // swaps once a replacement search actually succeeds.
    expect(
      (await screen.findAllByText("Ferry Building")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Current legal attribution")).toBeTruthy();
    expect(screen.queryByText(/attribution unavailable/i)).toBeNull();
    expect(describeProviders).toHaveBeenCalledTimes(1);
  });

  it("explicitly reports unavailable legal attribution", async () => {
    const user = userEvent.setup();
    render(
      <MapsView
        transport={transport({
          describeProviders: vi.fn(async () => [
            { id: "fixture_maps", attribution: null },
          ]),
        })}
        online
      />,
    );

    await searchFor(user, "waterfront");
    expect(
      await screen.findByText("Legal attribution unavailable for fixture_maps"),
    ).toBeTruthy();
  });

  it.each([
    ["unsupported", undefined],
    [
      "failed",
      vi.fn(async () => {
        throw new Error("provider metadata unavailable");
      }),
    ],
  ] as const)(
    "degrades explicitly when provider metadata is %s",
    async (_state, describeProviders) => {
      const user = userEvent.setup();
      render(<MapsView transport={transport({ describeProviders })} online />);

      await searchFor(user, "waterfront");
      expect(
        await screen.findByText(
          "Legal attribution unavailable for fixture_maps",
        ),
      ).toBeTruthy();
    },
  );

  it("gives every rendered control a unique collision-safe agent id", async () => {
    const collisionPlaces = [
      place("space", "Space", ["a b"], 37.79, -122.39),
      place("dash", "Dash", ["a-b"], 37.8, -122.4),
      place("slash", "Slash", ["a/b"], 37.81, -122.41),
      place("sentinel", "Sentinel", ["ALL"], 37.82, -122.42),
    ];
    const user = userEvent.setup();
    render(
      <MapsView
        transport={transport({
          search: vi.fn(async () => ({
            places: collisionPlaces,
            nextCursor: null,
          })),
        })}
        online
      />,
    );

    await searchFor(user, "collision test");
    const view = screen.getByTestId("maps-view");
    const controls = Array.from(
      view.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href]",
      ),
    );
    const ids = controls.map((control) =>
      control.getAttribute("data-agent-id"),
    );
    expect(ids.every((id): id is string => Boolean(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "maps-filter-all")).toHaveLength(1);
    expect(ids).toEqual(
      expect.arrayContaining([
        "maps-search-query",
        "maps-search-submit",
        "maps-filter-a%20b",
        "maps-filter-a-b",
        "maps-filter-a%2Fb",
        "maps-place-fixture_maps:space",
        "maps-marker-fixture_maps:space",
      ]),
    );
  });

  it("shows only provider-returned route alternatives and hands writes to actions", async () => {
    const user = userEvent.setup();
    const fake = transport();
    const handoffs: MapsTestChatPrefillDetail[] = [];
    window.addEventListener(MAPS_TEST_CHAT_PREFILL_EVENT, (event) => {
      handoffs.push((event as CustomEvent<MapsTestChatPrefillDetail>).detail);
    });
    render(<MapsView transport={fake} online />);
    await searchFor(user, "waterfront");
    expect(
      (await screen.findAllByText("Ferry Building")).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Start here" }));
    expect(
      document.querySelector('[data-agent-id="maps-clear-origin"]'),
    ).toBeTruthy();
    const plazaButton = document.querySelector<HTMLButtonElement>(
      '[data-agent-id="maps-place-fixture_maps:embarcadero-plaza"]',
    );
    if (!plazaButton) throw new Error("Embarcadero Plaza result is missing");
    await user.click(plazaButton);
    await user.click(screen.getByRole("button", { name: "Routes" }));

    expect(await screen.findByText("Route alternatives")).toBeTruthy();
    expect(
      document.querySelector('[data-agent-id="maps-route-walk"]'),
    ).toBeTruthy();
    expect(screen.getByText(/Route geometry is not drawn/)).toBeTruthy();
    expect(screen.getByTestId("maps-bottom-overlays").className).toContain(
      "pointer-events-none",
    );
    expect(screen.getByTestId("maps-schematic-label").className).toContain(
      "pointer-events-none",
    );
    expect(fake.planRoute).toHaveBeenCalledTimes(4);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(screen.getByRole("button", { name: "Navigate" }));
    expect(mapsTestActionNotices).toContainEqual([
      expect.stringContaining("Review and send"),
      "info",
      5000,
    ]);
    expect(handoffs).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Use MAPS_SAVE"),
        select: false,
      }),
      expect.objectContaining({
        text: expect.stringContaining("Use MAPS_SHARE"),
        select: false,
      }),
      expect.objectContaining({
        text: expect.stringContaining("Use MAPS_NAVIGATE"),
        select: false,
      }),
    ]);
  });

  it("loads cursor pages and deduplicates stable provider place ids", async () => {
    const user = userEvent.setup();
    const search = vi
      .fn<MapsViewTransport["search"]>()
      .mockResolvedValueOnce({ places: [FERRY, PLAZA], nextCursor: "page-2" })
      .mockResolvedValueOnce({ places: [PLAZA, PIER, PIER], nextCursor: null });
    render(<MapsView transport={transport({ search })} online />);

    await searchFor(user, "waterfront");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect((await screen.findAllByText("Pier 7")).length).toBeGreaterThan(0);
    expect(
      document.querySelectorAll(
        '[data-agent-id="maps-place-fixture_maps:pier-7"]',
      ),
    ).toHaveLength(1);
    expect(search).toHaveBeenNthCalledWith(
      2,
      "waterfront",
      expect.any(AbortSignal),
      "page-2",
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the newest result when searches resolve out of order", async () => {
    const pending = new Map<
      string,
      { resolve: (value: { places: PlaceRef[]; nextCursor: null }) => void }
    >();
    const fake = transport({
      search: vi.fn<MapsViewTransport["search"]>(
        (query) =>
          new Promise<PlacePage>((resolve) => {
            pending.set(query, { resolve });
          }),
      ),
    });
    const user = userEvent.setup();
    render(<MapsView transport={fake} online />);

    await searchFor(user, "first");
    await searchFor(user, "second");
    pending.get("second")?.resolve({ places: [PLAZA], nextCursor: null });
    expect(
      (await screen.findAllByText("Embarcadero Plaza")).length,
    ).toBeGreaterThan(0);
    pending.get("first")?.resolve({ places: [FERRY], nextCursor: null });
    await Promise.resolve();
    expect(screen.queryByText("Ferry Building")).toBeNull();
  });

  it("ignores an old place detail after a new search even when transport ignores abort", async () => {
    let resolveOldDetail: ((value: PlaceRef) => void) | undefined;
    let oldDetailSignal: AbortSignal | undefined;
    const staleDetail = { ...PLAZA, name: "Stale Plaza Detail" };
    const fake = transport({
      search: vi.fn<MapsViewTransport["search"]>(async (query) => ({
        places: query === "new search" ? [PIER] : [FERRY, PLAZA],
        nextCursor: null,
      })),
      getPlace: vi.fn<MapsViewTransport["getPlace"]>((value, signal) =>
        value.providerPlaceId === PLAZA.providerPlaceId
          ? new Promise<PlaceRef>((resolve) => {
              oldDetailSignal = signal;
              resolveOldDetail = resolve;
            })
          : Promise.resolve(value),
      ),
    });
    const user = userEvent.setup();
    render(<MapsView transport={fake} online />);

    await searchFor(user, "old search");
    const plazaButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-agent-id="maps-place-fixture_maps:embarcadero-plaza"]',
      );
      if (!button) throw new Error("Embarcadero Plaza result is missing");
      return button;
    });
    await user.click(plazaButton);
    expect(
      screen.getByRole("heading", { name: "Embarcadero Plaza" }),
    ).toBeTruthy();

    await searchFor(user, "new search");
    expect(oldDetailSignal?.aborted).toBe(true);
    expect(await screen.findByRole("heading", { name: "Pier 7" })).toBeTruthy();
    await act(async () => {
      resolveOldDetail?.(staleDetail);
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale Plaza Detail")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pier 7" })).toBeTruthy();
  });

  it("ignores old routes after the destination changes even when transport ignores abort", async () => {
    const pendingRoutes: Array<{
      destination: PlaceRef;
      mode: TravelMode;
      signal?: AbortSignal;
      resolve: (value: RoutePlan) => void;
    }> = [];
    const fake = transport({
      search: vi.fn(async () => ({
        places: [FERRY, PLAZA, PIER],
        nextCursor: null,
      })),
      planRoute: vi.fn<MapsViewTransport["planRoute"]>(
        (_origin, destination, mode, signal) =>
          new Promise<RoutePlan>((resolve) => {
            pendingRoutes.push({ destination, mode, signal, resolve });
          }),
      ),
    });
    const user = userEvent.setup();
    render(<MapsView transport={fake} online />);

    await searchFor(user, "waterfront");
    await screen.findByRole("heading", { name: "Ferry Building" });
    await user.click(screen.getByRole("button", { name: "Start here" }));
    const selectResult = async (id: string) => {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-agent-id="maps-place-fixture_maps:${id}"]`,
      );
      if (!button) throw new Error(`Maps result ${id} is missing`);
      await user.click(button);
    };

    await selectResult("embarcadero-plaza");
    await user.click(screen.getByRole("button", { name: "Routes" }));
    await waitFor(() => expect(fake.planRoute).toHaveBeenCalledTimes(4));

    await selectResult("pier-7");
    expect(
      pendingRoutes
        .filter(
          ({ destination }) =>
            destination.providerPlaceId === PLAZA.providerPlaceId,
        )
        .every(({ signal }) => signal?.aborted === true),
    ).toBe(true);
    expect(screen.queryByText("Route alternatives")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Routes" }));
    await waitFor(() => expect(fake.planRoute).toHaveBeenCalledTimes(8));

    const settleRoutes = async (
      destinationId: string,
      distanceMeters: number,
    ) => {
      await act(async () => {
        for (const pending of pendingRoutes.filter(
          ({ destination }) => destination.providerPlaceId === destinationId,
        )) {
          pending.resolve({
            provider: "fixture_maps",
            routeId: `${destinationId}-${pending.mode}`,
            origin: FERRY,
            destination: pending.destination,
            travelMode: pending.mode,
            distanceMeters,
            durationSeconds: 300,
            warnings: [],
          });
        }
        await Promise.resolve();
      });
    };

    await settleRoutes(PIER.providerPlaceId, 222);
    expect(await screen.findByText("Route alternatives")).toBeTruthy();
    expect(screen.getAllByText("222 m")).toHaveLength(4);

    await settleRoutes(PLAZA.providerPlaceId, 111);
    expect(screen.queryByText("111 m")).toBeNull();
    expect(screen.getAllByText("222 m")).toHaveLength(4);

    await selectResult("embarcadero-plaza");
    expect(screen.queryByText("Route alternatives")).toBeNull();
    expect(screen.queryByText("222 m")).toBeNull();
  });

  it("clears a stale route error when a new search starts", async () => {
    const fake = transport({
      search: vi.fn<MapsViewTransport["search"]>(async (query) => ({
        places: query === "new search" ? [PIER] : [FERRY, PLAZA],
        nextCursor: null,
      })),
      planRoute: vi.fn(async () => {
        throw new Error("Old route failure");
      }),
    });
    const user = userEvent.setup();
    render(<MapsView transport={fake} online />);

    await searchFor(user, "old search");
    await screen.findByRole("heading", { name: "Ferry Building" });
    await user.click(screen.getByRole("button", { name: "Start here" }));
    const plazaButton = document.querySelector<HTMLButtonElement>(
      '[data-agent-id="maps-place-fixture_maps:embarcadero-plaza"]',
    );
    if (!plazaButton) throw new Error("Embarcadero Plaza result is missing");
    await user.click(plazaButton);
    await user.click(screen.getByRole("button", { name: "Routes" }));
    expect(await screen.findByText("Old route failure")).toBeTruthy();

    await searchFor(user, "new search");
    expect(await screen.findByRole("heading", { name: "Pier 7" })).toBeTruthy();
    expect(screen.queryByText("Old route failure")).toBeNull();
  });

  it("renders loading, error, retry, designed-empty, and offline states", async () => {
    let rejectSearch: ((error: Error) => void) | undefined;
    const fake = transport({
      search: vi.fn<MapsViewTransport["search"]>(
        () =>
          new Promise<PlacePage>((_resolve, reject) => {
            rejectSearch = reject;
          }),
      ),
    });
    const user = userEvent.setup();
    const { rerender } = render(<MapsView transport={fake} online />);
    await searchFor(user, "museum");
    expect(screen.getByText("Loading place results")).toBeTruthy();
    rejectSearch?.(new Error("Provider temporarily unavailable."));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Provider temporarily unavailable.",
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /retry/i })
        .getAttribute("data-agent-id"),
    ).toBe("maps-retry-search");

    rerender(<MapsView transport={transport()} online={false} />);
    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Reconnect to search/)).toBeTruthy();
  });

  it("clears selected details with Escape and keeps every control agent-addressable", async () => {
    const user = userEvent.setup();
    render(<MapsView transport={transport()} online />);
    await searchFor(user, "waterfront");
    expect(
      (await screen.findAllByText("Ferry Building")).length,
    ).toBeGreaterThan(0);
    expect(
      document.querySelector('[data-agent-id="maps-search-query"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-agent-id="maps-save-place"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-agent-id="maps-search-submit"]'),
    ).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByText("Choose a place")).toBeTruthy(),
    );
  });

  it("keeps search controls visually clear of the open modal chat sheet", async () => {
    const overlay = document.createElement("div");
    overlay.dataset.testid = "chat-overlay";
    overlay.dataset.open = "true";
    document.body.append(overlay);
    render(<MapsView transport={transport()} online />);

    const form = document.querySelector<HTMLFormElement>(
      'form[aria-label="Search places"]',
    );
    if (!form) throw new Error("Maps search form is missing");
    await waitFor(() => expect(form.style.visibility).toBe("hidden"));
    expect(form.getAttribute("aria-hidden")).toBe("true");

    overlay.removeAttribute("data-open");
    await waitFor(() => expect(form.style.visibility).toBe(""));
  });
});
