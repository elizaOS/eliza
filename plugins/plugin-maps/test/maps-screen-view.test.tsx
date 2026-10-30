// @vitest-environment jsdom
/**
 * The shared phone Maps view rendered from the real screen and domain
 * controllers with scripted provider and device ports. It checks rendered
 * controls and their wiring, not a live provider, map tiles or device GPS.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapsProvider, ProviderConfig } from "../src/client/contracts.ts";
import { createMapsScreen } from "../src/client/maps-screen.ts";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { MapsController } from "../src/client/state.ts";
import { MapsScreen } from "../src/screen.ts";

const START = { latitude: 43.73, longitude: 7.42 };
const END = { latitude: 43.74, longitude: 7.42 };

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function setup(watch?: { start(): void; stop(): void }) {
  const config: ProviderConfig = {
    status: "configured",
    providerId: "fixture",
    connectionId: "conn_fixture_123456789",
    revision: "1",
    capabilities: {
      map: false,
      search: true,
      placeDetails: true,
      modes: ["drive", "walk"],
      traffic: "none",
      transit: "none",
      offline: { map: false, search: false, routing: false },
    },
  };
  const place = {
    providerId: "fixture",
    id: "harbour",
    name: "Harbour",
    coordinate: END,
    address: "Quai Albert 1er",
    attribution: "Fixture data",
    fetchedAt: Date.now(),
  };
  const provider: MapsProvider = {
    providerId: "fixture",
    connectionId: "conn_fixture_123456789",
    search: async () => [place],
    detail: async () => place,
    route: async (from, to, mode) => ({
      providerId: "fixture",
      id: "route_0123456789abcdef",
      from,
      to,
      mode,
      geometry: [from, to],
      distanceMeters: 1200,
      durationSeconds: 300,
      steps: [
        {
          instruction: "Head north",
          coordinate: from,
          distanceMeters: 1200,
          maneuver: "depart",
        },
        {
          instruction: "Arrive",
          coordinate: to,
          distanceMeters: 0,
          maneuver: "arrive",
        },
      ],
      attribution: "Fixture data",
      fetchedAt: Date.now(),
      traffic: "none",
    }),
  };
  const quiet = {
    awaitingPermission: () => false,
    start: async () => {
      watch?.start();
    },
    stop: async () => {
      watch?.stop();
    },
  };
  let voiceEnabled = true;
  const handle = createMapsScreen({
    connection: () => ({ config, provider }),
    onConnectionChange: () => () => {},
    initialize: async () => {},
    diagnostics: () => ({ configured: true, error: "" }),
    coverage: () => undefined,
    attribution: () => "Fixture data",
    createController: (current, maps) =>
      new MapsController(
        current,
        maps,
        new SavedPlaces("view.test", memory()),
        quiet,
      ),
    navigationLocation: quiet,
    agentLocation: quiet,
    locationGranted: async () => true,
    voice: {
      get enabled() {
        return voiceEnabled;
      },
      update: () => {},
      pause: () => {},
      toggle: () => {
        voiceEnabled = !voiceEnabled;
      },
    },
    background: {
      active: () => false,
      start: async () => false,
      update: () => {},
      stop: async () => {},
    },
    share: async () => "closed",
    openWebsite: () => {},
    active: () => true,
    toast: () => {},
  });
  return handle;
}

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const resizeObservers = new Set<() => void>();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {
        resizeObservers.add(callback);
      }
      observe() {}
      disconnect() {
        resizeObservers.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function plan(handle: ReturnType<typeof setup>) {
  act(() => {
    handle.controller.setQuery("Harbour");
    handle.controller.submit();
  });
  await settle();
  act(() => handle.controller.choose("place:fixture:harbour"));
  await settle();
  act(() => {
    handle.controller.openDirections();
    handle.controller.setOriginText(`${START.latitude}, ${START.longitude}`);
    handle.controller.planOrigin();
  });
  await settle();
}

describe("MapsScreen view", () => {
  it("measures scaled hosts in layout pixels so sheets keep their clearance", async () => {
    const handle = setup();
    const { container } = render(
      <MapsScreen screen={handle} attribution="credits" />,
    );
    await plan(handle);
    const root = container.querySelector<HTMLElement>("[data-maps-root]");
    const sheet = container.querySelector<HTMLElement>(
      '[data-maps-sheet="directions"]',
    );
    if (!root || !sheet) throw Error("Maps layout is missing");
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 450, 250),
    );
    vi.spyOn(root, "clientWidth", "get").mockReturnValue(900);
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(500);
    vi.spyOn(sheet, "getBoundingClientRect").mockReturnValue(
      new DOMRect(300, 100, 150, 100),
    );
    act(() => {
      for (const resize of resizeObservers) resize();
    });
    expect(root.style.display).not.toBe("flex");
    expect(sheet.style.left).toBe("auto");
    expect(
      container.querySelector<HTMLElement>("[data-maps-credits]")?.style.bottom,
    ).toContain("212px");
  });
  it("searches, opens a place, plans directions and starts guidance", async () => {
    const handle = setup();
    const { container } = render(
      <MapsScreen
        screen={handle}
        attribution="© Fixture contributors"
        disclosure="Searches and route points are sent to Fixture Maps."
        categories={[{ label: "Coffee" }]}
      />,
    );
    expect(screen.getByText("© Fixture contributors")).toBeTruthy();
    expect(
      screen.getByText("Searches and route points are sent to Fixture Maps."),
    ).toBeTruthy();
    const search = screen.getByRole("textbox", { name: "Search places" });
    const plane = container.querySelector("[data-map-plane]");
    if (!plane) throw Error("Map plane is missing");
    expect(
      search.compareDocumentPosition(plane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(search);
    await settle();
    expect(screen.getByRole("button", { name: "Coffee" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "Harbour" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Harbour/ }));
    await settle();
    expect(
      screen.getByRole("button", { name: "Rename place" }).textContent,
    ).toBe("Harbour");
    expect(screen.getByText("Quai Albert 1er")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(
      screen
        .getByRole("button", { name: "Remove from saved" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Directions" }));
    await settle();
    expect(
      screen
        .getByRole("button", { name: "Drive" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const origin = screen.getByRole("textbox", {
      name: "Route origin coordinates",
    });
    expect(
      origin.compareDocumentPosition(plane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.change(origin, {
      target: { value: `${START.latitude}, ${START.longitude}` },
    });
    fireEvent.keyDown(origin, { key: "Enter" });
    await settle();
    expect(screen.getByText("5 min")).toBeTruthy();
    expect(screen.getByText("1.2 km · no live traffic")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    await settle();
    expect(screen.getByRole("button", { name: "End navigation" })).toBeTruthy();
    const guidance = container.querySelector("[data-maps-guidance]");
    if (!guidance) throw Error("Navigation guidance is missing");
    expect(
      guidance.compareDocumentPosition(plane) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      plane.compareDocumentPosition(
        screen.getByRole("button", { name: "End navigation" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Waiting for location")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Mute voice guidance" }),
    );
    await settle();
    expect(
      screen.getByRole("button", { name: "Enable voice guidance" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End navigation" }));
    await settle();
    expect(screen.queryByRole("button", { name: "End navigation" })).toBeNull();
  });

  it("drives the host map plane and reports its readiness", async () => {
    const handle = setup();
    const updates: unknown[] = [];
    let destroyed = 0;
    let element: HTMLElement | undefined;
    const { unmount } = render(
      <MapsScreen
        screen={handle}
        attribution="credits"
        createPlane={(container) => {
          element = container;
          return {
            update: (selected) => updates.push(selected),
            destroy: () => {
              destroyed++;
            },
          };
        }}
      />,
    );
    expect(element?.getAttribute("aria-label")).toBe("Map");
    expect(handle.controller.view().status.map).toBe("loading");
    await act(async () => {
      if (element) element.dataset.mapReady = "true";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handle.controller.view().status.map).toBe("ready");
    const search = screen.getByRole("textbox", { name: "Search places" });
    fireEvent.change(search, { target: { value: "43.7397, 7.4276" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await settle();
    expect(updates.at(-1)).toEqual({ latitude: 43.7397, longitude: 7.4276 });
    unmount();
    expect(destroyed).toBe(1);
  });

  it("retries a failed plane without replacing the selected place or route", async () => {
    const handle = setup(),
      errors: (() => void)[] = [];
    let destroyed = 0;
    const updates: unknown[] = [];
    render(
      <MapsScreen
        screen={handle}
        attribution="credits"
        createPlane={(_element, onError) => {
          errors.push(onError);
          return {
            update: (selected, route) => updates.push({ selected, route }),
            destroy: () => {
              destroyed++;
            },
          };
        }}
      />,
    );
    await plan(handle);
    const before = handle.controller.view().map;
    act(() => errors[0]());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry map" }));
    await settle();
    expect(destroyed).toBe(1);
    expect(errors).toHaveLength(2);
    expect(handle.controller.view().map).toEqual(before);
    expect(updates.at(-1)).toEqual({
      selected: before.selected,
      route: before.route,
    });
    act(() => errors[0]());
    expect(handle.controller.view().status.map).toBe("loading");
    act(() => handle.controller.start());
    await settle();
    act(() => errors[1]());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry map" }));
    await settle();
    expect(errors).toHaveLength(3);
    expect(destroyed).toBe(2);
    expect(handle.controller.isNavigating()).toBe(true);
    expect(handle.controller.view().map.route).toEqual(before.route);
  });

  it("shows navigation notices while preserving guidance controls", async () => {
    const handle = setup();
    const { container } = render(
      <MapsScreen screen={handle} attribution="credits" />,
    );
    await plan(handle);
    act(() => handle.controller.start());
    await settle();
    act(() =>
      handle.controller.notify(
        "Voice guidance paused. Tap Enable voice guidance to retry.",
      ),
    );
    await settle();
    const notice = container.querySelector<HTMLElement>(
      "[data-maps-navigation-status]",
    );
    expect(notice?.textContent).toContain("Voice guidance paused");
    expect(notice?.style.clip).toBe("");
    expect(
      container.querySelector<HTMLElement>("[data-maps-primary]")?.style
        .overflowY,
    ).toBe("auto");
    expect(screen.getByRole("button", { name: "End navigation" })).toBeTruthy();
    expect(handle.controller.isNavigating()).toBe(true);
  });

  it("bounds sheets above host controls and separates panels in a wide, short view", async () => {
    const handle = setup();
    const { container } = render(
      <MapsScreen
        screen={handle}
        attribution="credits"
        style={
          {
            "--maps-inset-top": "44px",
            "--maps-bottom-clearance": "96px",
          } as CSSProperties
        }
      />,
    );
    const root = container.querySelector<HTMLElement>("[data-maps-root]");
    if (!root) throw Error("Maps root is missing");
    let bounds = new DOMRect(0, 0, 390, 600);
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => bounds);
    act(() => {
      for (const resize of resizeObservers) resize();
    });
    await plan(handle);
    const sheet = container.querySelector<HTMLElement>(
      '[data-maps-sheet="directions"]',
    );
    if (!sheet) throw Error("Directions sheet is missing");
    expect(sheet.style.maxHeight).toContain("--maps-inset-top");
    expect(sheet.style.bottom).toContain("--maps-bottom-clearance");
    expect(sheet.style.overflowY).toBe("auto");
    expect(sheet.style.left).not.toBe("auto");
    const before = handle.controller.view().map;
    bounds = new DOMRect(0, 0, 860, 390);
    act(() => {
      for (const resize of resizeObservers) resize();
    });
    expect(sheet.style.left).toBe("auto");
    expect(sheet.style.width).toContain("440px");
    const origin = container.querySelector<HTMLElement>(
      "[data-maps-directions]",
    );
    if (!origin) throw Error("Directions origin panel is missing");
    const primary = container.querySelector<HTMLElement>("[data-maps-primary]");
    if (!primary) throw Error("Primary controls are missing");
    expect(primary.style.right).toContain("440px");
    expect(primary.style.overflowY).toBe("auto");
    expect(handle.controller.view().map).toEqual(before);
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("reflows enlarged text into one reading column with sticky navigation actions", async () => {
    let starts = 0,
      stops = 0;
    const handle = setup({
      start: () => {
        starts++;
      },
      stop: () => {
        stops++;
      },
    });
    const { container, rerender } = render(
      <MapsScreen
        screen={handle}
        attribution="credits"
        style={
          {
            fontSize: 48,
            "--maps-text-scale": 3,
          } as CSSProperties
        }
      />,
    );
    await plan(handle);
    const root = container.querySelector<HTMLElement>("[data-maps-root]");
    const primary = container.querySelector<HTMLElement>("[data-maps-primary]");
    const sheet = container.querySelector<HTMLElement>(
      '[data-maps-sheet="directions"]',
    );
    expect(root?.style.overflowY).toBe("hidden");
    expect(
      container.querySelector<HTMLElement>("[data-maps-scroll]")?.style
        .overflowY,
    ).toBe("auto");
    expect(primary?.style.position).toBe("relative");
    expect(primary?.style.maxHeight).toBe("none");
    expect(sheet?.style.position).toBe("relative");
    act(() => handle.controller.start());
    await settle();
    expect(
      container.querySelector<HTMLElement>("[data-maps-navigation-controls]")
        ?.style.position,
    ).toBe("sticky");
    expect(primary?.textContent).toContain("Waiting for location");
    expect(screen.getByRole("button", { name: "End navigation" })).toBeTruthy();
    const running = { starts, stops };
    rerender(<MapsScreen screen={handle} attribution="credits" />);
    act(() => {
      for (const resize of resizeObservers) resize();
    });
    await settle();
    expect(handle.controller.isNavigating()).toBe(true);
    expect({ starts, stops }).toEqual(running);
  });
});
