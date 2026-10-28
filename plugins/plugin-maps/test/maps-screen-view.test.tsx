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
import { afterEach, describe, expect, it } from "vitest";
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

function setup() {
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
    start: async () => {},
    stop: async () => {},
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

afterEach(cleanup);

describe("MapsScreen view", () => {
  it("searches, opens a place, plans directions and starts guidance", async () => {
    const handle = setup();
    render(
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
});
