import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

function fixture(basemap, effects = {}) {
  const maps = [],
    protocols = effects.protocols ?? [];
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
    document: { createElement: element },
    MapLibre: ControlledMap,
    Marker,
    URL,
    setWorkerUrl() {},
    setWorkerCount() {},
    addProtocol: (...input) => protocols.push(input),
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
  const container = { dataset: {} },
    plane = new box.MapPlane(
      container,
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
        nativeRegion: () => false,
        nativeRequest: async () => {
          nativeRequests++;
          return { status: 200, bytes: new Uint8Array() };
        },
      },
    );
  return {
    plane,
    map: maps[0],
    container,
    protocols,
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
  await handler(
    { url: "test-region://tiles/1/0/1.pbf" },
    { signal: new AbortController().signal },
  );
  assert.equal(f.nativeRequests, 1);
  await assert.rejects(
    handler(
      { url: "test-region://tiles/1/4/1.pbf" },
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

test("new global pin gets street zoom and live host padding without recentering an unchanged selection or changing route padding", () => {
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
  assert.equal(f.map.easeCalls, 2);
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
  assert.equal(f.map.easeCalls, 2);
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
