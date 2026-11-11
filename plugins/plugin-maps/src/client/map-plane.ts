import {
  addProtocol,
  type GeoJSONSource,
  Map as MapLibre,
  type MapOptions,
  Marker,
  removeProtocol,
  setWorkerCount,
  setWorkerUrl,
} from "maplibre-gl";
import type { Coordinate, Route } from "./contracts.ts";
export type RegionalMap = {
  kind?: "regional";
  base: string;
  providerId?: string;
  region: string;
  bounds: [number, number, number, number];
  attribution: string;
};
/** Explicit public imagery chosen by the host; no search or location capability. */
export interface GlobalBasemap {
  kind: "global";
  styleUrl: string;
  attribution: string;
}
/**
 * Raster tiles fetched through the host's Cloud credential (Cloud Maps
 * `capabilities.tiles`, for example Google roadmap tiles). The host shows
 * `attribution`, and the plane reports the provider copyright for the visible
 * area through `onCopyright`.
 */
export interface CloudRasterBasemap {
  kind: "cloud-raster";
  attribution: string;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
  tile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal,
  ): Promise<ArrayBuffer>;
  copyright?(
    view: {
      zoom: number;
      north: number;
      south: number;
      east: number;
      west: number;
    },
    signal: AbortSignal,
  ): Promise<string>;
}
export type MapBasemap = RegionalMap | GlobalBasemap | CloudRasterBasemap;
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
  /** Only direct map gestures interrupt camera following. */
  onInteraction?(): void;
  /** The centre and zoom of the visible map, each time the map settles. */
  onViewport?(center: Coordinate, zoom: number): void;
  fontUrl: string;
  workerUrl: string;
  accent: string;
  /** Host prefix; each instance owns a distinct registered protocol beneath it. */
  protocol: string;
  routePadding: { top: number; bottom: number; left: number; right: number };
  /** Selection camera space is independent of route fitting. */
  selectionPadding?: () => {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  nativeRegion(base: string): boolean;
  nativeRequest(
    path: string,
    signal: AbortSignal,
  ): Promise<{ status: number; bytes: Uint8Array<ArrayBuffer> }>;
  /** Provider copyright for the visible area of a Cloud raster basemap. */
  onCopyright?(text: string): void;
  /**
   * Where a worldwide basemap opens. The default is the whole world around the
   * prime meridian. A regional map always opens on its own coverage.
   */
  initialView?: { center: Coordinate; zoom?: number };
}
/** Renderer only: regional transport or explicit public imagery; no search or geolocation. */
export class MapPlane {
  private map: MapLibre;
  private readonly globalBasemap: boolean;
  private marker?: Marker;
  private lastSelection = "";
  private selectionLayout = "";
  private lastRoute = "";
  private requested?: Coordinate;
  private requestedRoute?: Route | null;
  private requestedOverlay: MapOverlay = {};
  private pins = new Map<string, { key: string; marker: Marker }>();
  private lastPins = "";
  private position?: Marker;
  private lastPosition = "";
  private following = false;
  private readonly protocol?: string;
  private disposeCopyright?: () => void;
  private refreshCopyright?: () => void;
  private destroyed = false;
  /** Set by MapLibre's one-shot "load"; from then on the style accepts sources and layers. */
  private styleReady = false;
  constructor(
    container: HTMLElement,
    region: MapBasemap,
    onError: () => void,
    colors: Record<string, string>,
    private options: MapPlaneOptions,
  ) {
    const global = region.kind === "global";
    const raster = region.kind === "cloud-raster" ? region : undefined;
    const styleUrl = global ? new URL(region.styleUrl) : undefined;
    if (
      styleUrl &&
      (styleUrl.protocol !== "https:" || styleUrl.username || styleUrl.password)
    )
      throw new Error(
        "Global basemap requires an HTTPS style without credentials",
      );
    // Cloud raster tiles cover the world, so the camera behaves as for a global basemap.
    this.globalBasemap = global || !!raster;
    if (!global) {
      if (!/^[a-z][a-z0-9+.-]*$/.test(options.protocol))
        throw new Error("Invalid regional map protocol");
      // MapLibre shares its protocol registry between maps in this renderer.
      // Each map owns an entry while another map is mounted or replaced.
      this.protocol = `${options.protocol}-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
    }
    const [w, s, e, n] =
      region.kind === "regional" || region.kind === undefined
        ? region.bounds
        : [-180, -85, 180, 85];
    const worldwide = global || !!raster;
    const regionalBase =
      region.kind === "regional" || region.kind === undefined
        ? region.base
        : "";
    setWorkerUrl(options.workerUrl);
    setWorkerCount(1);
    const protocol = this.protocol;

    const opening = worldwide ? options.initialView : undefined;
    const mapOptions: MapOptions = {
      container,
      center: opening
        ? [opening.center.longitude, opening.center.latitude]
        : worldwide
          ? [0, 20]
          : [(w + e) / 2, (s + n) / 2],
      zoom: worldwide ? Math.max(opening?.zoom ?? 2, raster?.minZoom ?? 0) : 14,
      minZoom: worldwide ? (raster?.minZoom ?? 0) : 11,
      maxZoom: raster ? Math.min(raster.maxZoom, 20) : 18,
      maxBounds: worldwide
        ? undefined
        : [
            [w - 0.01, s - 0.01],
            [e + 0.01, n + 0.01],
          ],
      attributionControl: false,
      transformRequest: styleUrl
        ? (url) => {
            const resource = new URL(url, styleUrl);
            if (
              resource.origin !== styleUrl.origin ||
              resource.username ||
              resource.password
            )
              throw new Error("Global basemap resource origin changed");
            return { url: resource.href };
          }
        : undefined,
      style: global
        ? region.styleUrl
        : raster
          ? {
              version: 8,
              sources: {
                cloud: {
                  type: "raster",
                  tiles: [`${protocol}://tiles/{z}/{x}/{y}.png`],
                  tileSize: raster.tileSize,
                  minzoom: raster.minZoom,
                  maxzoom: raster.maxZoom,
                },
              },
              layers: [
                {
                  id: "land",
                  type: "background",
                  paint: { "background-color": colors.land },
                },
                { id: "cloud-raster", type: "raster", source: "cloud" },
              ],
            }
          : {
              version: 8,
              "font-faces": { "Map Labels": options.fontUrl },
              sources: {
                regional: {
                  type: "vector",
                  tiles: [
                    options.nativeRegion(regionalBase)
                      ? `${protocol}://tiles/{z}/{x}/{y}.pbf`
                      : `${regionalBase}/tiles/{z}/{x}/{y}.pbf`,
                  ],
                  maxzoom: 14,
                  bounds: [w, s, e, n],
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
    };
    if (protocol && raster)
      addProtocol(protocol, async (request, abort) => {
        if (this.destroyed) throw new Error("Cloud map is disposed");
        // Match the complete wire format; never accept another target or query.
        const tile =
          /^[a-z][a-z0-9+.-]*:\/\/tiles\/([0-9]{1,2})\/([0-9]{1,7})\/([0-9]{1,7})\.png$/.exec(
            request.url,
          );
        if (!tile || !request.url.startsWith(`${protocol}://`))
          throw new Error("Invalid Cloud tile");
        const [zoom, column, row] = tile.slice(1).map(Number) as [
          number,
          number,
          number,
        ];
        if (
          zoom < raster.minZoom ||
          zoom > raster.maxZoom ||
          column >= 2 ** zoom ||
          row >= 2 ** zoom
        )
          throw new Error("Invalid Cloud tile");
        const data = await raster.tile(zoom, column, row, abort.signal);
        if (this.destroyed) throw new Error("Cloud map is disposed");
        return { data };
      });
    else if (protocol)
      addProtocol(protocol, async (request, abort) => {
        if (this.destroyed) throw new Error("Regional map is disposed");
        // WebView's custom-scheme URL parser can put the authority in pathname.
        // Match the complete wire format instead; never accept another target or query.
        const tile =
          /^[a-z][a-z0-9+.-]*:\/\/tiles\/([0-9]{1,2})\/([0-9]{1,6})\/([0-9]{1,6})\.pbf$/.exec(
            request.url,
          );
        if (!tile || !request.url.startsWith(`${protocol}://`))
          throw new Error("Invalid regional tile");
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
        if (this.destroyed) throw new Error("Regional map is disposed");
        if (result.status !== 200 && result.status !== 204)
          throw new Error("Regional tile unavailable");
        return { data: result.bytes.buffer };
      });

    try {
      this.map = new MapLibre(mapOptions);
    } catch (error) {
      this.destroyed = true;
      if (protocol) removeProtocol(protocol);
      throw error;
    }
    this.map.on("movestart", (event) => {
      if (event.originalEvent) options.onInteraction?.();
    });
    this.map.on("idle", () => {
      if (this.destroyed) return;
      container.dataset.mapZoom = String(this.map.getZoom());
      if (options.onViewport) {
        // MapLibre keeps unwrapped longitudes while panning world copies.
        const center = this.map.getCenter().wrap();
        options.onViewport(
          { latitude: center.lat, longitude: center.lng },
          this.map.getZoom(),
        );
      }
      container.dataset.mapFeatureCount = String(
        this.map.queryRenderedFeatures(
          worldwide ? undefined : { layers: ["roads"] },
        ).length,
      );
      if (this.options.selectionPadding && this.map.isStyleLoaded())
        this.updateSelectionCamera(false);
    });
    this.map.on("error", (event) => {
      if (this.destroyed) return;
      const message = String(event.error?.message || "");
      container.dataset.mapError = /worker/i.test(message)
        ? "worker-load"
        : /webgl|context/i.test(message)
          ? "webgl"
          : /fetch|request|tile|load/i.test(message)
            ? "resource-load"
            : "render-error";
      delete container.dataset.mapReady;
      onError();
    });
    if (raster?.copyright) {
      const copyright = raster.copyright.bind(raster);
      type Viewport = Parameters<typeof copyright>[0];
      let pending: AbortController | undefined;
      let attributed: { view: Viewport; text: string } | undefined;
      const canvas = this.map.getCanvas();
      const visibility = canvas.style.visibility;
      const viewport = (): Viewport => {
        const bounds = this.map.getBounds();
        const west = bounds.getWest(),
          east = bounds.getEast();
        const wraps = west < -180 || east > 180 || west > east;
        return {
          zoom: Math.round(this.map.getZoom()),
          north: Math.min(90, bounds.getNorth()),
          south: Math.max(-90, bounds.getSouth()),
          east: wraps ? 180 : east,
          west: wraps ? -180 : west,
        };
      };
      const covers = (area: Viewport | undefined, view: Viewport) =>
        !!area &&
        area.zoom === view.zoom &&
        area.north >= view.north &&
        area.south <= view.south &&
        area.east >= view.east &&
        area.west <= view.west;
      const hide = () => {
        canvas.style.visibility = "hidden";
        delete container.dataset.mapCopyright;
        delete container.dataset.mapReady;
        this.options.onCopyright?.("");
      };
      const show = (text: string) => {
        container.dataset.mapCopyright = text;
        canvas.style.visibility = visibility;
        if (container.dataset.mapError === "copyright")
          delete container.dataset.mapError;
        if (this.styleReady && !container.dataset.mapError)
          container.dataset.mapReady = "true";
        this.options.onCopyright?.(text);
      };
      const updateVisibility = () => {
        if (this.destroyed) return;
        if (attributed && covers(attributed.view, viewport()))
          show(attributed.text);
        else hide();
      };
      hide();
      const refresh = () => {
        if (this.destroyed) return;
        const view = viewport();
        if (attributed && covers(attributed.view, view)) {
          show(attributed.text);
          return;
        }
        pending?.abort();
        hide();
        const controller = new AbortController();
        pending = controller;
        // One viewport of margin keeps GPS follow animations inside already attributed imagery.
        const latitudeMargin = view.north - view.south;
        const longitudeMargin = view.east - view.west;
        const requested = {
          ...view,
          north: Math.min(90, view.north + latitudeMargin),
          south: Math.max(-90, view.south - latitudeMargin),
          east: Math.min(180, view.east + longitudeMargin),
          west: Math.max(-180, view.west - longitudeMargin),
        };
        copyright(requested, controller.signal).then(
          (text) => {
            if (this.destroyed || controller.signal.aborted) return;
            if (!covers(requested, viewport())) {
              refresh();
              return;
            }
            attributed = { view: requested, text };
            show(text);
          },
          () => {
            if (this.destroyed || controller.signal.aborted) return;
            if (attributed && covers(attributed.view, viewport())) {
              show(attributed.text);
              return;
            }
            if (!container.dataset.mapError)
              container.dataset.mapError = "copyright";
            onError();
          },
        );
      };
      this.map.on("move", updateVisibility);
      this.map.on("moveend", refresh);
      this.refreshCopyright = refresh;
      this.disposeCopyright = () => pending?.abort();
    }
    this.map.on("load", () => {
      if (this.destroyed) return;
      this.styleReady = true;
      if (!this.refreshCopyright && !container.dataset.mapError)
        container.dataset.mapReady = "true";
      this.refreshCopyright?.();
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
        if (!this.destroyed) this.options.onPin?.(pin.id);
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
  /** Reflow the selected place when host sheets move, without taking a route's camera. */
  private updateSelectionCamera(newSelection: boolean) {
    const selected = this.requested;
    const padding = this.options.selectionPadding?.();
    const layout = padding
      ? [padding.top, padding.bottom, padding.left, padding.right]
          .map(Math.round)
          .join(",")
      : "";
    const layoutChanged = layout !== this.selectionLayout;
    this.selectionLayout = layout;
    if (
      !selected ||
      this.requestedOverlay.follow ||
      (!newSelection && (!layoutChanged || this.requestedRoute))
    )
      return;
    if (this.globalBasemap)
      this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    this.map.easeTo({
      center: [selected.longitude, selected.latitude],
      ...(newSelection && this.globalBasemap ? { zoom: 14 } : {}),
      ...(padding
        ? {
            offset: [
              (padding.left - padding.right) / 2,
              (padding.top - padding.bottom) / 2,
            ] as [number, number],
          }
        : {}),
      // A measured sheet reflow can replace this camera move immediately.
      // Apply the initial global zoom before later moves preserve its zoom.
      duration: newSelection && this.globalBasemap ? 0 : 350,
    });
  }
  /**
   * Bring a new set of result pins into view on a worldwide basemap. A selected
   * place, a route and navigation following each own the camera instead.
   */
  private showPins(pins: readonly MapPin[]) {
    const padding =
      this.options.selectionPadding?.() ?? this.options.routePadding;
    const longitudes = pins.map((pin) => pin.coordinate.longitude),
      latitudes = pins.map((pin) => pin.coordinate.latitude);
    this.map.fitBounds(
      [
        [Math.min(...longitudes), Math.min(...latitudes)],
        [Math.max(...longitudes), Math.max(...latitudes)],
      ],
      { padding, duration: 350, maxZoom: 14 },
    );
  }
  update(
    selected?: Coordinate,
    route?: Route | null,
    overlay: MapOverlay = {},
  ) {
    if (this.destroyed) return;
    this.requested = selected;
    this.requestedRoute = route;
    this.requestedOverlay = overlay;
    // isStyleLoaded() also turns false while in-view tiles load; only wait for the first load.
    if (!this.styleReady && !this.map.isStyleLoaded()) return;
    this.drawPins(overlay.pins || []);
    this.drawPosition(overlay.position, !!overlay.follow);
    // Leaving navigation returns the camera to a north-up overview.
    if (this.following && !overlay.follow)
      this.map.easeTo({ bearing: 0, duration: 350 });
    this.following = !!overlay.follow;
    const key = selected ? `${selected.longitude},${selected.latitude}` : "";
    const selectionChanged = key !== this.lastSelection;
    if (selectionChanged) {
      this.lastSelection = key;
      this.marker?.remove();
      this.marker = undefined;
      if (selected) {
        this.marker = new Marker({ color: this.options.accent })
          .setLngLat([selected.longitude, selected.latitude])
          .addTo(this.map);
      }
    }
    this.updateSelectionCamera(selectionChanged);
    const pins = overlay.pins || [];
    const pinsKey = JSON.stringify(
      pins.map((pin) => [
        pin.id,
        pin.coordinate.longitude,
        pin.coordinate.latitude,
      ]),
    );
    const pinsChanged = pinsKey !== this.lastPins;
    this.lastPins = pinsKey;
    if (
      pinsChanged &&
      pins.length &&
      this.globalBasemap &&
      !selected &&
      !route &&
      !overlay.follow
    )
      this.showPins(pins);
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.disposeCopyright?.();
    try {
      for (const entry of this.pins.values()) entry.marker.remove();
      this.pins.clear();
      this.position?.remove();
      this.marker?.remove();
      this.map.remove();
    } finally {
      if (this.protocol) removeProtocol(this.protocol);
    }
  }
}
