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
  providerId?: string;
  region: string;
  bounds: [number, number, number, number];
  attribution: string;
};
/** A search result or other candidate drawn on the map; tapping reports its id. */
export type MapPin = Readonly<{
  id: string;
  label: string;
  coordinate: Coordinate;
}>;
/** Device position from an explicit location session; heading only while moving. */
export type MapPosition = Readonly<{
  coordinate: Coordinate;
  accuracyMeters: number;
  headingDegrees?: number;
}>;
export type MapOverlay = Readonly<{
  pins?: readonly MapPin[];
  position?: MapPosition | null;
  /** Keep the camera on the position, rotated to its heading (navigation). */
  follow?: boolean;
}>;
export interface MapPlaneOptions {
  /** Called when the user taps a result pin. */
  onPin?(id: string): void;
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
  private requestedOverlay: MapOverlay = {};
  private pins = new Map<string, { key: string; marker: Marker }>();
  private position?: Marker;
  private lastPosition = "";
  private following = false;
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
      this.update(this.requested, this.requestedRoute, this.requestedOverlay);
    });
  }
  private drawPins(pins: readonly MapPin[]) {
    const wanted = new Set(pins.map((pin) => pin.id));
    for (const [id, entry] of this.pins)
      if (!wanted.has(id)) {
        entry.marker.remove();
        this.pins.delete(id);
      }
    for (const pin of pins) {
      const key = `${pin.label}|${pin.coordinate.longitude},${pin.coordinate.latitude}`;
      const existing = this.pins.get(pin.id);
      if (existing?.key === key) continue;
      existing?.marker.remove();
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.mapPin = pin.id;
      element.setAttribute("aria-label", pin.label);
      element.style.cssText = `width:22px;height:22px;border-radius:11px;border:3px solid ${this.options.accent};background:#fff;padding:0;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)`;
      element.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onPin?.(pin.id);
      });
      const marker = new Marker({ element })
        .setLngLat([pin.coordinate.longitude, pin.coordinate.latitude])
        .addTo(this.map);
      this.pins.set(pin.id, { key, marker });
    }
  }
  private drawPosition(
    position: MapPosition | null | undefined,
    follow: boolean,
  ) {
    if (!position) {
      this.position?.remove();
      this.position = undefined;
      this.lastPosition = "";
      return;
    }
    const { coordinate, headingDegrees } = position;
    if (!this.position) {
      const element = document.createElement("div");
      element.dataset.mapPosition = "";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", "Your position");
      element.style.cssText =
        "width:28px;height:28px;position:relative;pointer-events:none";
      const cone = document.createElement("span");
      cone.dataset.mapHeading = "";
      cone.style.cssText = `position:absolute;left:7px;top:-9px;width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:14px solid ${this.options.accent};opacity:.85`;
      const dot = document.createElement("span");
      dot.style.cssText = `position:absolute;left:5px;top:5px;width:18px;height:18px;border-radius:9px;background:${this.options.accent};border:3px solid #fff;box-sizing:border-box;box-shadow:0 1px 6px rgba(0,0,0,.4)`;
      element.append(cone, dot);
      this.position = new Marker({ element, rotationAlignment: "map" })
        .setLngLat([coordinate.longitude, coordinate.latitude])
        .addTo(this.map);
    }
    const element = this.position.getElement();
    const cone = element.querySelector<HTMLElement>("[data-map-heading]");
    if (cone) cone.style.display = headingDegrees === undefined ? "none" : "";
    element.dataset.mapPosition =
      headingDegrees === undefined ? "" : String(Math.round(headingDegrees));
    this.position
      .setLngLat([coordinate.longitude, coordinate.latitude])
      .setRotation(headingDegrees ?? 0);
    const key = `${coordinate.longitude},${coordinate.latitude},${headingDegrees ?? ""},${follow}`;
    if (follow && key !== this.lastPosition)
      this.map.easeTo({
        center: [coordinate.longitude, coordinate.latitude],
        zoom: Math.max(this.map.getZoom(), 16.5),
        bearing: headingDegrees ?? this.map.getBearing(),
        duration: 500,
      });
    this.lastPosition = key;
  }
  update(
    selected?: Coordinate,
    route?: Route | null,
    overlay: MapOverlay = {},
  ) {
    this.requested = selected;
    this.requestedRoute = route;
    this.requestedOverlay = overlay;
    if (!this.map.isStyleLoaded()) return;
    this.drawPins(overlay.pins || []);
    this.drawPosition(overlay.position, !!overlay.follow);
    // Leaving navigation returns the camera to a north-up overview.
    if (this.following && !overlay.follow)
      this.map.easeTo({ bearing: 0, duration: 350 });
    this.following = !!overlay.follow;
    const key = selected ? `${selected.longitude},${selected.latitude}` : "";
    if (key !== this.lastSelection) {
      this.lastSelection = key;
      this.marker?.remove();
      this.marker = undefined;
      if (selected) {
        this.marker = new Marker({ color: this.options.accent })
          .setLngLat([selected.longitude, selected.latitude])
          .addTo(this.map);
        if (!overlay.follow)
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
    if (route && !overlay.follow) {
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
    for (const entry of this.pins.values()) entry.marker.remove();
    this.pins.clear();
    this.position?.remove();
    this.marker?.remove();
    this.map.remove();
  }
}
