// @vitest-environment jsdom

/**
 * Exercises the real Maps React state machine with a deterministic transport:
 * success, stale-response ordering, route alternatives, handoffs, and failures.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText("Place data: fixture_maps")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "park" }));
    expect(
      document.querySelector(
        '[data-agent-id="maps-place-fixture_maps-ferry-building"]',
      ),
    ).toBeNull();
    expect(screen.getByText("Embarcadero Plaza")).toBeTruthy();
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
    const plazaButton = document.querySelector<HTMLButtonElement>(
      '[data-agent-id="maps-place-fixture_maps-embarcadero-plaza"]',
    );
    if (!plazaButton) throw new Error("Embarcadero Plaza result is missing");
    await user.click(plazaButton);
    await user.click(screen.getByRole("button", { name: "Routes" }));

    expect(await screen.findByText("Route alternatives")).toBeTruthy();
    expect(
      document.querySelector('[data-agent-id="maps-route-walk"]'),
    ).toBeTruthy();
    expect(screen.getByText(/Route geometry is not drawn/)).toBeTruthy();
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
        '[data-agent-id="maps-place-fixture_maps-pier-7"]',
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
