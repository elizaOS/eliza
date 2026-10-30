import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

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
      maps.push(this);
    }
    on(name, callback) {
      this.events[name] = callback;
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
  const container = { dataset: {} };
  const create = (overrides = {}, target = { dataset: {} }) =>
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
