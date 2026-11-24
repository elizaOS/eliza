// spec/cloud/services/maps.md, "Story: Answer a maps request once and pay for it once"; spec/cloud/services/maps.md, "A search ranked by distance needs a point to measure from"; spec/cloud/shared/types.md, "Story: Use one vocabulary across the cloud"
import { Schema } from "effect";

const text = (maximum: number) =>
  Schema.String.check(Schema.isMaxLength(maximum), Schema.isPattern(/^[\t\n\r\x20-\uffff]*\S[\t\n\r\x20-\uffff]*$/));
const between = (minimum: number, maximum: number) => Schema.Finite.check(Schema.isBetween({ minimum, maximum }));
const int = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const meters = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
);

export const strictParse = { onExcessProperty: "error" } as const;

export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)).pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;

export const maxTileZoom = 22;

export const TravelMode = Schema.Literals(["drive", "walk", "bicycle", "transit"]);
export type TravelMode = typeof TravelMode.Type;

export const Maneuver = Schema.Literals(["depart", "continue", "slight-left", "left", "sharp-left", "slight-right", "right", "sharp-right", "keep-left", "keep-right", "u-turn", "roundabout", "arrive"]);
export type Maneuver = typeof Maneuver.Type;

export const Coordinate = Schema.Struct({ latitude: between(-90, 90), longitude: between(-180, 180) });
export type Coordinate = typeof Coordinate.Type;

export const MapsBounds = Schema.Tuple([between(-180, 180), between(-90, 90), between(-180, 180), between(-90, 90)]).check(
  Schema.makeFilter(([west, south, east, north]: readonly [number, number, number, number]) => west < east && south < north),
);
export type MapsBounds = typeof MapsBounds.Type;

const ProviderId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,79}$/));
const Attribution = text(2000);
const FetchedAt = Schema.Int.check(Schema.isGreaterThan(0));

export const TextSearchRequest = Schema.Struct({
  query: text(300),
  near: Schema.optionalKey(Coordinate),
  limit: Schema.optionalKey(int(1, 20)),
});
export type TextSearchRequest = typeof TextSearchRequest.Type;

export const PlacesSearchRequest = Schema.Struct({ ...TextSearchRequest.fields, rank: Schema.optionalKey(Schema.Literal("distance")) });
export type PlacesSearchRequest = typeof PlacesSearchRequest.Type;

export const ReverseRequest = Schema.Struct({
  coordinate: Coordinate,
  preferPlace: Schema.optionalKey(Schema.Boolean),
  radiusMeters: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50_000))),
});
export type ReverseRequest = typeof ReverseRequest.Type;

export const PlaceDetailsRequest = Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/)) });
export type PlaceDetailsRequest = typeof PlaceDetailsRequest.Type;

export const RoutesRequest = Schema.Struct({
  from: Coordinate,
  to: Coordinate,
  mode: TravelMode,
  alternatives: Schema.optionalKey(Schema.Boolean),
  departAt: Schema.optionalKey(instant),
});
export type RoutesRequest = typeof RoutesRequest.Type;

export const ViewportRequest = Schema.Struct({
  zoom: int(0, maxTileZoom),
  north: between(-90, 90),
  south: between(-90, 90),
  east: between(-180, 180),
  west: between(-180, 180),
}).check(Schema.makeFilter((viewport: { readonly north: number; readonly south: number }) => viewport.north > viewport.south));
export type ViewportRequest = typeof ViewportRequest.Type;

export const TileAddress = Schema.Struct({ z: int(0, maxTileZoom), x: nonNegative, y: nonNegative }).check(
  Schema.makeFilter((tile: { readonly z: number; readonly x: number; readonly y: number }) => tile.x < 2 ** tile.z && tile.y < 2 ** tile.z),
);
export type TileAddress = typeof TileAddress.Type;

const decodeTile = Schema.decodeUnknownOption(TileAddress, strictParse);
const pathNumber = (raw: string | undefined): number => (raw !== undefined && /^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN);

export const tileAddressOf = (params: { readonly z?: string; readonly x?: string; readonly y?: string }): TileAddress | undefined => {
  const decoded = decodeTile({ z: pathNumber(params.z), x: pathNumber(params.x), y: pathNumber(params.y) });
  return decoded._tag === "Some" ? decoded.value : undefined;
};

export const mapsRequests = {
  geocode: TextSearchRequest,
  reverse: ReverseRequest,
  "places/search": PlacesSearchRequest,
  "places/details": PlaceDetailsRequest,
  routes: RoutesRequest,
  "tiles/viewport": ViewportRequest,
} as const;
export type MapsBodyRoute = keyof typeof mapsRequests;
export type MapsRequestOf<R extends MapsBodyRoute> = (typeof mapsRequests)[R]["Type"];

export const MapsPlace = Schema.Struct({
  providerId: ProviderId,
  id: text(512),
  name: text(300),
  coordinate: Coordinate,
  address: Schema.optionalKey(text(1000)),
  website: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(2048),
      Schema.makeFilter((value: string) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
      }),
    ),
  ),
  phone: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[+0-9() .-]{3,80}$/))),
  openingHours: Schema.optionalKey(text(255)),
  attribution: Attribution,
  fetchedAt: FetchedAt,
});
export type MapsPlace = typeof MapsPlace.Type;

export const MapsPlacesResponse = Schema.Struct({
  providerId: ProviderId,
  attribution: Attribution,
  places: Schema.Array(MapsPlace).check(Schema.isMaxLength(100)),
});
export type MapsPlacesResponse = typeof MapsPlacesResponse.Type;

export const MapsPlaceResponse = Schema.Struct({ providerId: ProviderId, attribution: Attribution, place: Schema.NullOr(MapsPlace) });
export type MapsPlaceResponse = typeof MapsPlaceResponse.Type;

export const MapsTransitDetails = Schema.Struct({
  line: text(100),
  vehicle: text(50),
  headsign: Schema.optionalKey(text(200)),
  departureStop: text(200),
  arrivalStop: text(200),
  departureTime: Schema.optionalKey(instant),
  arrivalTime: Schema.optionalKey(instant),
  stopCount: Schema.optionalKey(nonNegative),
  color: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/))),
});
export type MapsTransitDetails = typeof MapsTransitDetails.Type;

export const MapsRouteStep = Schema.Struct({
  instruction: text(500),
  coordinate: Coordinate,
  distanceMeters: meters,
  maneuver: Schema.optionalKey(Maneuver),
  transit: Schema.optionalKey(MapsTransitDetails),
});
export type MapsRouteStep = typeof MapsRouteStep.Type;

export const MapsTraffic = Schema.Literals(["none", "live"]);
export type MapsTraffic = typeof MapsTraffic.Type;

export const MapsTransit = Schema.Literals(["none", "scheduled"]);
export type MapsTransit = typeof MapsTransit.Type;

export const MapsRoute = Schema.Struct({
  providerId: ProviderId,
  id: text(512),
  from: Coordinate,
  to: Coordinate,
  mode: TravelMode,
  geometry: Schema.Array(Coordinate).check(Schema.isMinLength(2)),
  distanceMeters: meters,
  durationSeconds: meters,
  steps: Schema.Array(MapsRouteStep),
  attribution: Attribution,
  fetchedAt: FetchedAt,
  traffic: MapsTraffic,
  staticDurationSeconds: Schema.optionalKey(meters),
});
export type MapsRoute = typeof MapsRoute.Type;

export const MapsRoutesResponse = Schema.Struct({
  providerId: ProviderId,
  attribution: Attribution,
  routes: Schema.NonEmptyArray(MapsRoute).check(Schema.isMaxLength(3)),
});
export type MapsRoutesResponse = typeof MapsRoutesResponse.Type;

export const MapsViewportResponse = Schema.Struct({ providerId: ProviderId, copyright: text(500), maxZoom: Schema.optionalKey(int(0, maxTileZoom)) });
export type MapsViewportResponse = typeof MapsViewportResponse.Type;

export const MapsRegion = Schema.Struct({ id: text(64), name: text(100), bounds: MapsBounds });
export type MapsRegion = typeof MapsRegion.Type;

export const MapsSources = Schema.Struct({ data: text(100), search: text(100), routing: text(100) });
export type MapsSources = typeof MapsSources.Type;

export const MapsDisclosure = Schema.Struct({
  recipients: Schema.NonEmptyArray(Schema.Struct({ role: Schema.Literals(["gateway", "search", "routing"]), name: text(100), operator: text(100) })).check(Schema.isMaxLength(8)),
  cloudRecords: Schema.Literal("operation-and-result-code"),
});
export type MapsDisclosure = typeof MapsDisclosure.Type;

export const tileUrlTemplate = "/api/v1/maps/tiles/{z}/{x}/{y}";

export const MapsTiles = Schema.Struct({
  urlTemplate: Schema.Literal(tileUrlTemplate),
  mapType: Schema.Literal("roadmap"),
  minZoom: int(0, maxTileZoom),
  maxZoom: int(0, maxTileZoom),
  tileSize: Schema.Literals([256, 512]),
  attribution: text(200),
}).check(Schema.makeFilter((tiles: { readonly minZoom: number; readonly maxZoom: number }) => tiles.minZoom <= tiles.maxZoom));
export type MapsTiles = typeof MapsTiles.Type;

export const MapsServiceCapabilities = Schema.Struct({
  map: Schema.Boolean,
  search: Schema.Literal(true),
  placeDetails: Schema.Literal(true),
  geocode: Schema.Literal(true),
  reverseGeocode: Schema.Literal(true),
  placeLookup: Schema.Boolean,
  distanceRank: Schema.optionalKey(Schema.Boolean),
  modes: Schema.NonEmptyArray(TravelMode).check(Schema.isUnique()),
  alternatives: Schema.Boolean,
  traffic: MapsTraffic,
  transit: MapsTransit,
  offline: Schema.Struct({ map: Schema.Literal(false), search: Schema.Literal(false), routing: Schema.Literal(false) }),
}).check(
  Schema.makeFilter((capabilities: { readonly modes: ReadonlyArray<TravelMode>; readonly transit: MapsTransit }) =>
    !capabilities.modes.includes("transit") || capabilities.transit === "scheduled"),
);
export type MapsServiceCapabilities = typeof MapsServiceCapabilities.Type;

export const MapsCapabilities = Schema.Union([
  Schema.Struct({ available: Schema.Literal(false) }),
  Schema.Struct({
    available: Schema.Literal(true),
    providerId: ProviderId,
    connectionId: Schema.String.check(Schema.isPattern(/^conn_[A-Za-z0-9_-]{16,}$/)),
    revision: text(100),
    attribution: Attribution,
    sources: MapsSources,
    disclosure: MapsDisclosure,
    regions: Schema.NonEmptyArray(MapsRegion).check(Schema.isMaxLength(64)),
    capabilities: MapsServiceCapabilities,
    tiles: Schema.optionalKey(MapsTiles),
  }).check(Schema.makeFilter((offer: { readonly capabilities: { readonly map: boolean }; readonly tiles?: unknown }) => offer.capabilities.map === (offer.tiles !== undefined))),
]);
export type MapsCapabilities = typeof MapsCapabilities.Type;
