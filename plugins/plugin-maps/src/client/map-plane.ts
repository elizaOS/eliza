import {
  addProtocol,
  type GeoJSONSource,
  Map as MapLibre,
  Marker,
  setWorkerCount,
  setWorkerUrl,
} from "maplibre-gl";
import type { Coordinate, Route } from "./contracts.ts";
export type RegionalMap = {
  base: string;
  region: string;
  bounds: [number, number, number, number];
  attribution: string;
};
export interface MapPlaneOptions {
  fontUrl: string;
  workerUrl: string;
  accent: string;
  protocol: string;
  routePadding: { top: number; bottom: number; left: number; right: number };
  nativeRegion(base: string): boolean;
  nativeRequest(
    path: string,
    signal: AbortSignal,
  ): Promise<{ status: number; bytes: Uint8Array<ArrayBuffer> }>;
}
/** Renderer only: no geolocation, third-party style, glyph, sprite or search calls. */
export class MapPlane {
  private map: MapLibre;
  private marker?: Marker;
  private lastSelection = "";
  private lastRoute = "";
  private requested?: Coordinate;
  private requestedRoute?: Route | null;
  constructor(
    container: HTMLElement,
    region: RegionalMap,
    onError: () => void,
    colors: Record<string, string>,
    private options: MapPlaneOptions,
  ) {
    setWorkerUrl(options.workerUrl);
    setWorkerCount(1);
    addProtocol(options.protocol, async (request, abort) => {
      // WebView's custom-scheme URL parser can put the authority in pathname.
      // Match the complete wire format instead; never accept another target or query.
      const tile =
        /^[a-z][a-z0-9+.-]*:\/\/tiles\/([0-9]{1,2})\/([0-9]{1,6})\/([0-9]{1,6})\.pbf$/.exec(
          request.url,
        );
      if (!tile) throw new Error("Invalid regional tile");
      const [, z, x, y] = tile;
      const zoom = Number(z),
        column = Number(x),
        row = Number(y);
      if (zoom > 14 || column >= 2 ** zoom || row >= 2 ** zoom)
        throw new Error("Invalid regional tile");
      const result = await options.nativeRequest(
        `/tiles/${zoom}/${column}/${row}.pbf`,
        abort.signal,
      );
      if (result.status !== 200 && result.status !== 204)
        throw new Error("Regional tile unavailable");
      return { data: result.bytes.buffer };
    });

    const [w, s, e, n] = region.bounds;
    this.map = new MapLibre({
      container,
      center: [(w + e) / 2, (s + n) / 2],
      zoom: 14,
      minZoom: 11,
      maxZoom: 18,
      maxBounds: [
        [w - 0.01, s - 0.01],
        [e + 0.01, n + 0.01],
      ],
      attributionControl: false,
      style: {
        version: 8,
        "font-faces": { "Map Labels": options.fontUrl },
        sources: {
          regional: {
            type: "vector",
            tiles: [
              options.nativeRegion(region.base)
                ? options.protocol + "://tiles/{z}/{x}/{y}.pbf"
                : region.base + "/tiles/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 14,
            bounds: region.bounds,
          },
        },
        layers: [
          {
            id: "land",
            type: "background",
            paint: { "background-color": colors.land },
          },
          {
            id: "water",
            type: "fill",
            source: "regional",
            "source-layer": "water",
            paint: { "fill-color": colors.water },
          },
          {
            id: "park",
            type: "fill",
            source: "regional",
            "source-layer": "landcover",
            paint: { "fill-color": colors.park, "fill-opacity": 0.6 },
          },
          {
            id: "buildings",
            type: "fill",
            source: "regional",
            "source-layer": "building",
            paint: { "fill-color": colors.rwy, "fill-opacity": 0.55 },
          },
          {
            id: "road-outline",
            type: "line",
            source: "regional",
            "source-layer": "transportation",
            paint: { "line-color": colors.fwyE, "line-width": 6 },
          },
          {
            id: "roads",
            type: "line",
            source: "regional",
            "source-layer": "transportation",
            paint: { "line-color": colors.major, "line-width": 3 },
          },
          {
            id: "street-names",
            type: "symbol",
            source: "regional",
            "source-layer": "transportation_name",
            layout: {
              "symbol-placement": "line",
              "text-field": ["get", "name"],
              "text-font": ["Map Labels"],
              "text-size": 11,
            },
            paint: {
              "text-color": colors.label,
              "text-halo-color": colors.land,
              "text-halo-width": 1,
            },
          },
          {
            id: "place-names",
            type: "symbol",
            source: "regional",
            "source-layer": "place",
            layout: {
              "text-field": ["get", "name"],
              "text-font": ["Map Labels"],
              "text-size": 13,
            },
            paint: {
              "text-color": colors.label,
              "text-halo-color": colors.land,
              "text-halo-width": 1,
            },
          },
        ],
      },
    });
    this.map.on("idle", () => {
      container.dataset.mapFeatureCount = String(
        this.map.queryRenderedFeatures({ layers: ["roads"] }).length,
      );
    });
    this.map.on("error", (event) => {
      const message = String(event.error?.message || "");
      container.dataset.mapError = /worker/i.test(message)
        ? "worker-load"
        : /webgl|context/i.test(message)
          ? "webgl"
          : /fetch|request|tile|load/i.test(message)
            ? "resource-load"
            : "render-error";
      onError();
    });
    this.map.on("load", () => {
      container.dataset.mapReady = "true";
      this.update(this.requested, this.requestedRoute);
    });
  }
  update(selected?: Coordinate, route?: Route | null) {
    this.requested = selected;
    this.requestedRoute = route;
    if (!this.map.isStyleLoaded()) return;
    const key = selected ? `${selected.longitude},${selected.latitude}` : "";
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.marker?.remove();
      this.marker = undefined;
      if (selected) {
        this.marker = new Marker({ color: this.options.accent })
          .setLngLat([selected.longitude, selected.latitude])
          .addTo(this.map);
        this.map.easeTo({
          center: [selected.longitude, selected.latitude],
          duration: 350,
        });
      }
    }
    const routeKey = route?.id || "";
    if (routeKey === this.lastRoute) return;
    this.lastRoute = routeKey;
    const data = {
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates:
          route?.geometry.map((p) => [p.longitude, p.latitude]) || [],
      },
    };
    if (this.map.getSource("route"))
      (this.map.getSource("route") as GeoJSONSource).setData(data);
    else {
      this.map.addSource("route", { type: "geojson", data });
      this.map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: { "line-color": this.options.accent, "line-width": 6 },
      });
    }
    if (route) {
      const p = route.geometry;
      this.map.fitBounds(
        [
          [
            Math.min(...p.map((v) => v.longitude)),
            Math.min(...p.map((v) => v.latitude)),
          ],
          [
            Math.max(...p.map((v) => v.longitude)),
            Math.max(...p.map((v) => v.latitude)),
          ],
        ],
        { padding: this.options.routePadding, duration: 350, maxZoom: 17 },
      );
    }
  }
  destroy() {
    this.marker?.remove();
    this.map.remove();
  }
}
