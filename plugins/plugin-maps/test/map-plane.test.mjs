import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { visibleMapPadding } from "../src/client/map-layout.ts";

function fixture(basemap, effects = {}) {
  const maps = [],
    protocols = effects.protocols ?? [],
    removedProtocols = effects.removedProtocols ?? [];
  let nativeRequests = 0,
    errors = 0;
  const element = () => ({
    style: {},
    dataset: {},
    attributes: {},
    events: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, callback) {
      this.events[name] = callback;
    },
    append(...children) {
      this.children.push(...children);
    },
    querySelector() {
      return (
        this.children.find((child) => child.dataset.mapHeading !== undefined) ||
        null
      );
    },
  });
  class ControlledMap {
    constructor(options) {
      if (effects.failMap) throw new Error("GPU context unavailable");
      this.options = options;
      this.events = {};
      this.sources = {};
      this.canvas = { style: {} };
      maps.push(this);
    }
    on(name, callback) {
      this.events[name] = callback;
    }
    getCanvas() {
      return this.canvas;
    }
    isStyleLoaded() {
      return true;
    }
    queryRenderedFeatures(options) {
      this.query = options;
      return [{ id: 1 }];
    }
    easeTo(value) {
      this.center = value;
      this.easeCalls = (this.easeCalls ?? 0) + 1;
      if (!effects.deferAnimations || value.duration === 0)
        this.options.zoom = value.zoom ?? this.options.zoom;
    }
    setPadding(value) {
      this.padding = value;
    }
    getBearing() {
      return 0;
    }
    getZoom() {
      return this.options.zoom;
    }
    getBounds() {
      return {
        getNorth: () => this.bounds?.north ?? 43.76,
        getSouth: () => this.bounds?.south ?? 43.72,
        getEast: () => this.bounds?.east ?? 7.45,
        getWest: () => this.bounds?.west ?? 7.4,
      };
    }
    getSource(id) {
      return this.sources[id];
    }
    addSource(id, value) {
      this.sources[id] = {
        ...value,
        setData: (data) => (this.sources[id].data = data),
      };
    }
    addLayer(value) {
      this.layer = value;
    }
    fitBounds(bounds, options) {
      this.fit = { bounds, options };
    }
    remove() {
      this.removed = true;
      this.removeCalls = (this.removeCalls ?? 0) + 1;
    }
  }
  class Marker {
    constructor(input) {
      this.element = input?.element || element();
    }
    getElement() {
      return this.element;
    }
    setRotation(value) {
      this.rotation = value;
      return this;
    }
    setLngLat(point) {
      this.point = point;
      return this;
    }
    addTo(map) {
      map.marker = this;
      (map.markers ??= []).push(this);
      return this;
    }
    remove() {
      this.removed = true;
    }
  }
  const box = {
    crypto: webcrypto,
    document: { createElement: element },
    MapLibre: ControlledMap,
    Marker,
    URL,
    AbortController,
    setWorkerUrl() {},
    setWorkerCount() {},
    addProtocol: (...input) => protocols.push(input),
    removeProtocol: (name) => removedProtocols.push(name),
  };
  const source = fs
    .readFileSync(
      process.env.CORE_MAP_PLANE_SOURCE ||
        new URL("../src/client/map-plane.ts", import.meta.url),
      "utf8",
    )
    .replace(/^import[\s\S]*?from [^;]+;\n/gm, "")
    .replace("export class MapPlane", "class MapPlane");
  vm.runInNewContext(
    stripTypeScriptTypes(source, { mode: "transform" }) +
      ";globalThis.MapPlane=MapPlane;",
    box,
  );
  const container = { dataset: {}, style: {} };
  const create = (overrides = {}, target = { dataset: {}, style: {} }) =>
    new box.MapPlane(
      target,
      basemap,
      () => errors++,
      { land: "#fff" },
      {
        fontUrl: "/font.woff2",
        workerUrl: "/worker.js",
        accent: "#00f",
        protocol: "test-region",
        routePadding: { top: 1, bottom: 1, left: 1, right: 1 },
        selectionPadding: effects.selectionPadding,
        onPin: effects.onPin,
        nativeRegion: effects.nativeRegion ?? (() => false),
        nativeRequest: async () => {
          nativeRequests++;
          return { status: 200, bytes: new Uint8Array() };
        },
        ...overrides,
      },
    );
  const plane = create({}, container);
  return {
    plane,
    map: maps[0],
    container,
    protocols,
    removedProtocols,
    create,
    maps,
    get nativeRequests() {
      return nativeRequests;
    },
    get errors() {
      return errors;
    },
  };
}
const regional = {
  base: "https://regional.invalid",
  region: "Monaco",
  bounds: [7.409, 43.724, 7.449, 43.752],
  attribution: "OSM",
};
const global = {
  kind: "global",
  styleUrl: "https://tiles.openfreemap.org/styles/bright",
  attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
};

test("regional maps keep separate tile transports and retire their own protocol", async () => {
  const f = fixture(regional);
  let secondRequests = 0;
  const second = f.create({
    nativeRequest: async () => {
      secondRequests++;
      return { status: 204, bytes: new Uint8Array() };
    },
  });
  const [[firstName, firstHandler], [secondName, secondHandler]] = f.protocols;
  assert.notEqual(firstName, secondName);
  const request = (name) => ({ url: `${name}://tiles/1/0/1.pbf` });
  const abort = { signal: new AbortController().signal };
  await firstHandler(request(firstName), abort);
  await secondHandler(request(secondName), abort);
  await assert.rejects(
    firstHandler(request(secondName), abort),
    /Invalid regional tile/,
  );
  assert.equal(f.nativeRequests, 1);
  assert.equal(secondRequests, 1);
  f.plane.destroy();
  assert.deepEqual(f.removedProtocols, [firstName]);
  await assert.rejects(firstHandler(request(firstName), abort), /disposed/);
  await secondHandler(request(secondName), abort);
  assert.equal(secondRequests, 2);
  second.destroy();
  assert.deepEqual(f.removedProtocols, [firstName, secondName]);
});

test("invalid regional options do not register a tile protocol", () => {
  const effects = {
    protocols: [],
    nativeRegion() {
      throw new Error("Region configuration unavailable");
    },
  };
  assert.throws(
    () => fixture(regional, effects),
    /Region configuration unavailable/,
  );
  assert.deepEqual(effects.protocols, []);
});

test("failed map construction releases its registered protocol", async () => {
  const effects = { failMap: true, protocols: [], removedProtocols: [] };
  assert.throws(() => fixture(regional, effects), /GPU context unavailable/);
  assert.equal(effects.protocols.length, 1);
  assert.deepEqual(effects.removedProtocols, [effects.protocols[0][0]]);
  const [name, handler] = effects.protocols[0];
  await assert.rejects(
    handler(
      { url: `${name}://tiles/1/0/1.pbf` },
      { signal: new AbortController().signal },
    ),
    /disposed/,
  );
});

test("a retired map rejects a late in-flight tile response", async () => {
  const f = fixture(regional);
  let complete;
  const plane = f.create({
    nativeRequest: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const [name, handler] = f.protocols[1];
  const pending = handler(
    { url: `${name}://tiles/1/0/1.pbf` },
    { signal: new AbortController().signal },
  );
  plane.destroy();
  complete({ status: 204, bytes: new Uint8Array() });
  await assert.rejects(pending, /disposed/);
  f.plane.destroy();
});

test("destroy is idempotent and ignores late map callbacks and updates", () => {
  const f = fixture(regional);
  f.plane.destroy();
  f.plane.destroy();
  f.map.events.error({ error: Error("late tile failure") });
  f.map.events.load();
  f.map.events.idle();
  f.plane.update({ latitude: 43.74, longitude: 7.42 });
  assert.equal(f.errors, 0);
  assert.equal(f.map.removeCalls, 1);
  assert.equal(f.map.marker, undefined);
  assert.equal(f.container.dataset.mapReady, undefined);
});
test("updates wait for the style to load, then draw while tiles are still loading", () => {
  const f = fixture(regional);
  // MapLibre's isStyleLoaded() is false before "load" and again whenever
  // in-view tiles load, for example after a camera move.
  let styleLoaded = false;
  f.map.isStyleLoaded = () => styleLoaded;
  const place = { latitude: 43.74, longitude: 7.42 };
  f.plane.update(place);
  assert.equal(f.map.marker, undefined, "nothing is drawn before load");
  styleLoaded = true;
  f.map.events.load();
  assert.deepEqual(Array.from(f.map.marker.point), [7.42, 43.74]);
  styleLoaded = false;
  f.plane.update(
    place,
    {
      id: "route-1",
      geometry: [{ latitude: 43.73, longitude: 7.41 }, place],
    },
    {
      pins: [
        {
          id: "pin-1",
          label: "Cafe",
          coordinate: { latitude: 43.735, longitude: 7.415 },
        },
      ],
    },
  );
  assert.ok(f.map.sources.route, "the route line is drawn");
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.map.sources.route.data.geometry.coordinates)),
    [
      [7.41, 43.73],
      [7.42, 43.74],
    ],
  );
  assert.ok(f.map.fit, "the new route is framed");
  const pin = f.map.markers.find(
    (marker) => marker.element.dataset.mapPin === "pin-1",
  );
  assert.deepEqual(pin && Array.from(pin.point), [7.415, 43.735]);
});
test("explicit global style starts at world scale, permits global manual pins and retains existing ownership cleanup", () => {
  const f = fixture(global);
  assert.equal(f.map.options.style, global.styleUrl);
  assert.equal(f.map.options.zoom, 2);
  assert.equal(f.map.options.minZoom, 0);
  assert.equal(f.map.options.maxBounds, undefined);
  assert.deepEqual(Array.from(f.map.options.center), [0, 20]);
  assert.equal(f.nativeRequests, 0);
  assert.equal(f.protocols.length, 0);
  f.map.events.load();
  assert.equal(f.container.dataset.mapReady, "true");
  f.plane.update({ longitude: -122.42, latitude: 37.77 });
  assert.deepEqual(Array.from(f.map.marker.point), [-122.42, 37.77]);
  f.map.events.idle();
  assert.equal(f.map.query, undefined);
  assert.equal(f.container.dataset.mapFeatureCount, "1");
  f.plane.destroy();
  assert.equal(f.map.removed, true);
});
test("a host chooses where a worldwide basemap opens; a regional map keeps its coverage", () => {
  const f = fixture(global);
  f.create({
    initialView: { center: { longitude: -98, latitude: 45 }, zoom: 2.4 },
  });
  assert.deepEqual(Array.from(f.maps[1].options.center), [-98, 45]);
  assert.equal(f.maps[1].options.zoom, 2.4);
  f.create({ initialView: { center: { longitude: -98, latitude: 45 } } });
  assert.equal(f.maps[2].options.zoom, 2);
  const r = fixture(regional);
  r.create({
    initialView: { center: { longitude: -98, latitude: 45 }, zoom: 2.4 },
  });
  assert.deepEqual(
    Array.from(r.maps[1].options.center),
    Array.from(r.map.options.center),
  );
  assert.equal(r.maps[1].options.zoom, 14);
});
test("new result pins are brought into view once; selection, routes and following keep the camera", () => {
  const f = fixture(global, {
    selectionPadding: () => ({ top: 10, bottom: 300, left: 20, right: 20 }),
  });
  const pin = (id, longitude, latitude) => ({
    id,
    label: id,
    coordinate: { longitude, latitude },
  });
  const pins = [pin("a", 7.42, 43.73), pin("b", 7.27, 43.7)];
  f.plane.update(undefined, null, { pins });
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.fit.bounds)), [
    [7.27, 43.7],
    [7.42, 43.73],
  ]);
  assert.equal(f.map.fit.options.maxZoom, 14);
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.fit.options.padding)), {
    top: 10,
    bottom: 300,
    left: 20,
    right: 20,
  });
  // The same results again leave a camera the user may have moved.
  f.map.fit = undefined;
  f.plane.update(undefined, null, { pins });
  assert.equal(f.map.fit, undefined);
  // Provider ids may include delimiters. Distinct complete pin records must refit.
  f.plane.update(undefined, null, {
    pins: [pin("a", 1, 2), pin("b", 3, 4)],
  });
  f.map.fit = undefined;
  f.plane.update(undefined, null, { pins: [pin("a:1,2|b", 3, 4)] });
  assert.ok(f.map.fit, "A different complete pin input must fit");
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.fit.bounds)), [
    [3, 4],
    [3, 4],
  ]);
  f.map.fit = undefined;
  // A selected place owns the camera; its result pins do not refit.
  f.plane.update({ longitude: 7.42, latitude: 43.73 }, null, {
    pins: [pin("c", 2.35, 48.85)],
  });
  assert.equal(f.map.fit, undefined);
  // Following navigation keeps the camera too.
  f.plane.update(undefined, null, {
    pins: [pin("d", 12.49, 41.9)],
    position: {
      coordinate: { longitude: 7.42, latitude: 43.73 },
      accuracyMeters: 10,
    },
    follow: true,
  });
  assert.equal(f.map.fit, undefined);
  // A regional map already shows its whole coverage.
  const r = fixture(regional);
  r.plane.update(undefined, null, { pins: [pin("e", 7.42, 43.73)] });
  assert.equal(r.map.fit, undefined);
});
test("global style resources stay on the selected public origin; no arbitrary or credential-bearing target", () => {
  const f = fixture(global),
    request = f.map.options.transformRequest;
  assert.equal(
    request("https://tiles.openfreemap.org/planet/1/1/1.pbf").url,
    "https://tiles.openfreemap.org/planet/1/1/1.pbf",
  );
  assert.throws(
    () => request("https://foreign.invalid/track"),
    /origin changed/,
  );
  assert.throws(
    () => request("https://user:secret@tiles.openfreemap.org/tile"),
    /origin changed/,
  );
  assert.throws(
    () =>
      fixture({
        ...global,
        styleUrl: "http://tiles.openfreemap.org/styles/bright",
      }),
    /HTTPS/,
  );
});
test("regional renderer keeps its original zoom, coverage, bundled font and owned tile protocol", async () => {
  const f = fixture(regional);
  assert.equal(f.map.options.zoom, 14);
  assert.equal(f.map.options.minZoom, 11);
  assert.equal(f.map.options.style["font-faces"]["Map Labels"], "/font.woff2");
  assert.equal(
    f.map.options.style.sources.regional.tiles[0],
    `${regional.base}/tiles/{z}/{x}/{y}.pbf`,
  );
  assert.equal(f.map.options.transformRequest, undefined);
  assert.ok(f.map.options.maxBounds);
  f.map.events.idle();
  assert.deepEqual(Array.from(f.map.query.layers), ["roads"]);
  const handler = f.protocols[0][1];
  const protocol = f.protocols[0][0];
  await handler(
    { url: `${protocol}://tiles/1/0/1.pbf` },
    { signal: new AbortController().signal },
  );
  assert.equal(f.nativeRequests, 1);
  await assert.rejects(
    handler(
      { url: `${protocol}://tiles/1/4/1.pbf` },
      { signal: new AbortController().signal },
    ),
    /Invalid regional tile/,
  );
  f.map.events.error({ error: Error("tile fetch failed") });
  assert.equal(f.errors, 1);
  assert.equal(f.container.dataset.mapError, "resource-load");
});

test("invalid global descriptor registers no protocol", () => {
  const effects = { protocols: [] };
  assert.throws(
    () =>
      fixture(
        { ...global, styleUrl: "http://tiles.openfreemap.org/styles/bright" },
        effects,
      ),
    /HTTPS style without credentials/,
  );
  assert.equal(effects.protocols.length, 0);
});

test("global selection follows changed host layout without resetting zoom, replacing its marker or stealing navigation", () => {
  let padding = { top: 80, bottom: 430, left: 30, right: 30 };
  const f = fixture(global, { selectionPadding: () => padding });
  const point = { longitude: -122.42, latitude: 37.77 };
  f.plane.update(point);
  assert.equal(f.map.center.zoom, 14);
  assert.deepEqual(Array.from(f.map.center.offset), [
    (padding.left - padding.right) / 2,
    (padding.top - padding.bottom) / 2,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.padding)), {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });
  assert.equal(f.map.easeCalls, 1);
  f.plane.update(point);
  assert.equal(f.map.easeCalls, 1);
  const marker = f.map.marker;
  f.map.options.zoom = 16;
  padding = { top: 80, bottom: 250, left: 30, right: 340 };
  f.map.events.idle();
  assert.equal(f.map.easeCalls, 2);
  assert.equal(f.map.getZoom(), 16);
  assert.equal(f.map.marker, marker);
  assert.deepEqual(Array.from(f.map.center.offset), [-155, -85]);
  f.map.events.idle();
  f.plane.update(point);
  assert.equal(f.map.easeCalls, 2);
  padding = { top: 80, bottom: 250, left: 30, right: 30 };
  f.plane.update({ ...point, latitude: 37.78 });
  assert.deepEqual(Array.from(f.map.center.offset), [
    (padding.left - padding.right) / 2,
    (padding.top - padding.bottom) / 2,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.padding)), {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  });
  assert.equal(f.map.easeCalls, 3);
  f.map.events.idle();
  assert.equal(f.container.dataset.mapZoom, "14");
  f.plane.update(
    { ...point, latitude: 37.78 },
    { id: "route", geometry: [point, { longitude: -122.41, latitude: 37.78 }] },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(f.map.fit.options.padding)), {
    top: 1,
    bottom: 1,
    left: 1,
    right: 1,
  });
  assert.equal(f.map.easeCalls, 3);
  padding = { top: 20, bottom: 100, left: 30, right: 30 };
  f.map.events.idle();
  assert.equal(
    f.map.easeCalls,
    3,
    "route keeps camera ownership after layout change",
  );
  f.plane.update({ ...point, latitude: 37.78 }, null, { follow: true });
  padding = { top: 10, bottom: 10, left: 10, right: 10 };
  f.map.events.idle();
  assert.equal(
    f.map.easeCalls,
    3,
    "following keeps camera ownership after layout change",
  );
  const regionalMap = fixture(regional);
  regionalMap.plane.update(point);
  assert.equal("zoom" in regionalMap.map.center, false);
  assert.equal("padding" in regionalMap.map.center, false);
});

test("a sheet reflow cannot cancel the initial global selection zoom", () => {
  let padding = { top: 80, bottom: 430, left: 30, right: 30 };
  const f = fixture(global, {
    deferAnimations: true,
    selectionPadding: () => padding,
  });
  const point = { longitude: -122.42, latitude: 37.77 };
  f.plane.update(point);
  padding = { top: 80, bottom: 250, left: 30, right: 30 };
  f.plane.update(point);
  assert.equal(f.map.getZoom(), 14);
  f.map.options.zoom = 12;
  padding = { top: 80, bottom: 250, left: 30, right: 340 };
  f.plane.update(point);
  assert.equal(f.map.getZoom(), 12, "later reflow preserves the user's zoom");
});

test("canonical overlays leave camera space in landscape and keyboard viewports", () => {
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  let bounds = rect(100, 50, 600, 300);
  const boxes = {
    "[data-maps-search]": rect(112, 62, 324, 54),
    "[data-maps-sheet]": rect(460, 62, 228, 276),
  };
  const container = {
    getBoundingClientRect: () => bounds,
    parentElement: {
      querySelector: (selector) =>
        boxes[selector] && {
          getBoundingClientRect: () => boxes[selector],
        },
    },
  };
  const padding = () => visibleMapPadding(container);
  assert.deepEqual(padding(), { top: 114, bottom: 48, left: 24, right: 264 });
  const routePadding = Object.fromEntries(
    ["top", "bottom", "left", "right"].map((edge) => [edge, 0]),
  );
  for (const edge of Object.keys(routePadding))
    Object.defineProperty(routePadding, edge, { get: () => padding()[edge] });
  const f = fixture(global, { selectionPadding: padding });
  const routed = f.create({ routePadding });
  const point = { longitude: -122.42, latitude: 37.77 };
  routed.update(point, {
    id: "landscape",
    geometry: [point, { ...point, latitude: 37.78 }],
  });
  assert.equal(f.maps[1].fit.options.padding.right, 264);
  bounds = rect(100, 50, 600, 180);
  boxes["[data-maps-credits]"] = rect(112, 200, 200, 18);
  routed.update(point, {
    id: "keyboard",
    geometry: [point, { ...point, latitude: 37.78 }],
  });
  const fitted = f.maps[1].fit.options.padding;
  assert.equal(fitted.top + fitted.bottom, 160);
  assert.ok(
    bounds.top + fitted.top - 41 >= boxes["[data-maps-search]"].bottom,
    "the selected pin's head clears the panel, not only its coordinate",
  );
  assert.ok(
    bounds.bottom - fitted.bottom <= boxes["[data-maps-credits]"].top - 16,
  );
  assert.ok(fitted.left + fitted.right <= 520);
  assert.ok(
    Object.values(padding()).every(
      (value) => Number.isFinite(value) && value >= 0,
    ),
  );
});

test("flow controls outside the map do not move the selected pin", () => {
  const bounds = {
    left: 0,
    top: 100,
    right: 400,
    bottom: 300,
    width: 400,
    height: 200,
  };
  const outside = {
    "[data-maps-search]": { left: 0, top: 0, right: 400, bottom: 100 },
    "[data-maps-credits]": { left: 0, top: 300, right: 400, bottom: 330 },
    "[data-maps-sheet]": { left: 0, top: 350, right: 400, bottom: 900 },
  };
  const container = {
    getBoundingClientRect: () => bounds,
    parentElement: {
      querySelector: (selector) => ({
        getBoundingClientRect: () => outside[selector],
      }),
    },
  };
  const f = fixture(global, {
    selectionPadding: () => visibleMapPadding(container),
  });
  f.plane.update({ longitude: -122.42, latitude: 37.77 });
  assert.deepEqual(Array.from(f.map.center.offset), [0, 0]);
  assert.deepEqual(visibleMapPadding(container), {
    top: 48,
    bottom: 48,
    left: 24,
    right: 24,
  });
});

test("canonical overlay pins and following survive the global rendering port", () => {
  const chosen = [],
    f = fixture(global, { onPin: (id) => chosen.push(id) });
  const point = { longitude: -122.42, latitude: 37.77 },
    pin = { id: "owned-pin", label: "Result", coordinate: point };
  f.plane.update(undefined, null, {
    pins: [pin],
    position: { coordinate: point, accuracyMeters: 15, headingDegrees: 35 },
    follow: true,
  });
  const marker = f.map.markers[0];
  let stopped = false;
  marker.element.events.click({
    stopPropagation() {
      stopped = true;
    },
  });
  assert.deepEqual(chosen, ["owned-pin"]);
  assert.equal(stopped, true);
  assert.equal(marker.element.attributes["aria-label"], "Result");
  assert.equal(f.map.center.bearing, 35);
  const count = f.map.markers.length;
  f.plane.update(undefined, null, {
    pins: [pin],
    position: { coordinate: point, accuracyMeters: 15, headingDegrees: 35 },
    follow: true,
  });
  assert.equal(f.map.markers.length, count);
  f.plane.update(undefined, null, { pins: [], position: null, follow: false });
  assert.equal(marker.removed, true);
  assert.equal(f.map.center.bearing, 0);
  f.plane.destroy();
  assert.equal(f.map.removed, true);
});

test("route fitting clears the whole primary panel and sibling navigation controls", () => {
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const boxes = {
    "[data-maps-primary]": rect(12, 12, 400, 180),
    "[data-maps-sheet]": rect(540, 12, 248, 376),
    "[data-maps-credits]": rect(12, 370, 480, 18),
    "[data-maps-navigation-controls]": rect(552, 312, 224, 76),
  };
  const root = {
    querySelector: (selector) =>
      boxes[selector] && { getBoundingClientRect: () => boxes[selector] },
  };
  const container = {
    getBoundingClientRect: () => rect(0, 0, 800, 400),
    parentElement: { querySelector: () => null },
    closest: (selector) => (selector === "[data-maps-root]" ? root : null),
  };
  assert.deepEqual(visibleMapPadding(container), {
    top: 240,
    bottom: 48,
    left: 24,
    right: 284,
  });
  delete boxes["[data-maps-sheet]"];
  delete boxes["[data-maps-primary]"];
  delete boxes["[data-maps-credits]"];
  boxes["[data-maps-navigation-controls]"] = rect(0, 300, 800, 100);
  assert.deepEqual(visibleMapPadding(container), {
    top: 48,
    bottom: 116,
    left: 24,
    right: 24,
  });
});

test("scaled screen overlays return MapLibre layout-pixel insets", () => {
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const boxes = {
    "[data-maps-primary]": rect(6, 6, 200, 90),
    "[data-maps-sheet]": rect(270, 6, 124, 188),
    "[data-maps-credits]": rect(6, 185, 240, 9),
  };
  const root = {
    querySelector: (selector) =>
      boxes[selector] && { getBoundingClientRect: () => boxes[selector] },
  };
  const container = {
    clientWidth: 800,
    clientHeight: 400,
    getBoundingClientRect: () => rect(0, 0, 400, 200),
    closest: () => root,
  };
  assert.deepEqual(visibleMapPadding(container), {
    top: 240,
    bottom: 48,
    left: 24,
    right: 284,
  });
});

/** Objects built inside the VM realm compare structurally after a JSON round trip. */
const plain = (value) => JSON.parse(JSON.stringify(value));
test("a Cloud raster basemap draws Cloud tiles through its own protocol and reports the copyright", async () => {
  const tiles = [];
  const views = [];
  const copyrights = [];
  let failCopyright = false;
  const raster = {
    kind: "cloud-raster",
    attribution: "Map data © Google",
    minZoom: 0,
    maxZoom: 22,
    tileSize: 256,
    tile: async (z, x, y) => {
      tiles.push([z, x, y]);
      return new Uint8Array([1, 2, 3]).buffer;
    },
    copyright: async (view) => {
      views.push(view);
      if (failCopyright) throw new Error("Viewport metadata unavailable");
      return "Map data ©2026 Google";
    },
  };
  const f = fixture(raster);
  const [[name, handler]] = f.protocols;
  assert.match(name, /^test-region-/);
  const style = f.map.options.style;
  assert.deepEqual(plain(style.sources.cloud), {
    type: "raster",
    tiles: [`${name}://tiles/{z}/{x}/{y}.png`],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 22,
  });
  assert.deepEqual(plain(style.layers.map((layer) => layer.id)), [
    "land",
    "cloud-raster",
  ]);
  assert.deepEqual(plain(f.map.options.center), [0, 20]);
  assert.equal(f.map.options.maxBounds, undefined);
  assert.equal(f.map.options.maxZoom, 20);
  const signal = new AbortController();
  const result = await handler({ url: `${name}://tiles/3/4/2.png` }, signal);
  assert.deepEqual([...new Uint8Array(result.data)], [1, 2, 3]);
  assert.deepEqual(tiles, [[3, 4, 2]]);
  for (const url of [
    `${name}://tiles/3/8/2.png`,
    `${name}://tiles/3/4/2.pbf`,
    `${name}://tiles/3/4/2.png?key=x`,
    `other://tiles/3/4/2.png`,
  ])
    await assert.rejects(handler({ url }, signal), /Invalid Cloud tile/);
  assert.equal(tiles.length, 1);
  assert.equal(f.nativeRequests, 0);
  // The copyright follows the visible area once the map loads and after each move.
  const plane = f.create(
    { onCopyright: (text) => copyrights.push(text) },
    f.container,
  );
  const map = f.maps.at(-1);
  map.events.load();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(plain(views.at(-1)), {
    zoom: 2,
    north: 43.76 + (43.76 - 43.72),
    south: 43.72 - (43.76 - 43.72),
    east: 7.45 + (7.45 - 7.4),
    west: 7.4 - (7.45 - 7.4),
  });
  assert.equal(f.container.dataset.mapCopyright, "Map data ©2026 Google");
  assert.deepEqual(copyrights.filter(Boolean), ["Map data ©2026 Google"]);
  assert.equal(map.canvas.style.visibility, undefined);
  assert.equal(f.container.dataset.mapReady, "true");
  for (let fix = 1; fix <= 25; fix++) {
    const delta = fix / 10000;
    map.bounds = {
      north: 43.76 + delta,
      south: 43.72 + delta,
      east: 7.45,
      west: 7.4,
    };
    map.events.move();
    map.events.moveend();
    assert.equal(map.canvas.style.visibility, undefined);
    assert.equal(f.container.dataset.mapReady, "true");
  }
  assert.equal(views.length, 1);
  map.bounds = { north: 44, south: 43.9, east: 7.6, west: 7.55 };
  map.events.move();
  assert.equal(map.canvas.style.visibility, "hidden");
  assert.equal(f.container.dataset.mapCopyright, undefined);
  assert.equal(f.container.dataset.mapReady, undefined);
  assert.equal(copyrights.at(-1), "");
  failCopyright = true;
  map.events.moveend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(map.canvas.style.visibility, "hidden");
  assert.equal(f.container.dataset.mapError, "copyright");
  assert.equal(f.errors, 1);
  failCopyright = false;
  map.events.moveend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(map.canvas.style.visibility, undefined);
  assert.equal(f.container.dataset.mapReady, "true");
  assert.equal(f.container.dataset.mapError, undefined);
  map.events.error({ error: new Error("Tile load failed") });
  assert.equal(f.container.dataset.mapError, "resource-load");
  assert.equal(f.container.dataset.mapReady, undefined);
  map.bounds = { north: 46, south: 45.9, east: 9.6, west: 9.55 };
  failCopyright = true;
  map.events.move();
  map.events.moveend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.container.dataset.mapError, "resource-load");
  failCopyright = false;
  map.events.moveend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.container.dataset.mapError, "resource-load");
  assert.equal(f.container.dataset.mapReady, undefined);
  plane.destroy();
  f.plane.destroy();
  assert.equal(f.removedProtocols.length, 2);
});

test("Cloud copyright replies retire on movement and map disposal", async () => {
  const pending = [];
  const credits = [];
  const f = fixture(
    {
      kind: "cloud-raster",
      attribution: "Google Maps",
      minZoom: 0,
      maxZoom: 18,
      tileSize: 256,
      tile: async () => new ArrayBuffer(1),
      copyright: (_view, signal) =>
        new Promise((resolve) => pending.push({ signal, resolve })),
    },
    { onCopyright: (text) => credits.push(text) },
  );
  f.map.events.load();
  f.map.bounds = { north: 44, south: 43.9, east: 7.6, west: 7.55 };
  f.map.events.move();
  f.map.events.moveend();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve("Old viewport");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.container.dataset.mapCopyright, undefined);
  assert.equal(f.map.canvas.style.visibility, "hidden");
  pending[1].resolve("Current viewport");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.container.dataset.mapCopyright, "Current viewport");
  assert.equal(f.map.canvas.style.visibility, undefined);
  f.map.bounds = { north: 45, south: 44.9, east: 8.6, west: 8.55 };
  f.map.events.move();
  f.map.events.moveend();
  f.plane.destroy();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve("Disposed viewport");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.container.dataset.mapCopyright, undefined);
  assert.equal(f.errors, 0);
});

test("a settled map reports its centre and zoom; only a direct gesture is an interaction", () => {
  const viewports = [];
  let interactions = 0;
  const f = fixture(global);
  f.map.getCenter = () => ({
    lat: 37.77,
    lng: -122.42,
    wrap: () => ({ lat: 37.77, lng: -122.42 }),
  });
  f.map.events.idle();
  assert.deepEqual(viewports, [], "a host without the port is not called");
  const plane = f.create({
    onViewport: (center, zoom) => viewports.push([center, zoom]),
    onInteraction: () => interactions++,
  });
  const map = f.maps.at(-1);
  map.getCenter = () => ({
    lat: 37.77,
    lng: -122.42,
    wrap: () => ({ lat: 37.77, lng: -122.42 }),
  });
  map.options.zoom = 13;
  map.events.movestart({});
  assert.equal(interactions, 0, "a camera move by the plane is not a gesture");
  map.events.movestart({ originalEvent: {} });
  assert.equal(interactions, 1);
  map.events.idle();
  assert.equal(
    JSON.stringify(viewports),
    JSON.stringify([[{ latitude: 37.77, longitude: -122.42 }, 13]]),
  );
  plane.destroy();
});

test("a settled world-copy viewport reports a valid wrapped search coordinate", () => {
  const f = fixture(global);
  const areas = [];
  const plane = f.create({ onViewport: (center) => areas.push(center) });
  const map = f.maps.at(-1);
  map.options.zoom = 14;
  // MapLibre LngLat explicitly permits an unwrapped longitude at world copies.
  map.getCenter = () => ({
    lat: 0,
    lng: 181,
    wrap: () => ({ lat: 0, lng: -179 }),
  });
  map.events.idle();
  assert.equal(
    JSON.stringify(areas),
    JSON.stringify([{ latitude: 0, longitude: -179 }]),
  );
  plane.destroy();
});
