import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { type MapsProvider as ProviderKind, type TravelMode as SpecMode } from "../../gen/cloud__services__maps.effect.vibe";
import type { Micros } from "../../gen/cloud__shared__types.ts";
import type { MapsSettings as MapsSettingsSchema } from "../profile/profile.schema.ts";
import { Deployment } from "../profile/profile.vibe";
import { type MapsCapabilities, type MapsPlaceResponse, type MapsPlacesResponse, type MapsRoutesResponse, type MapsViewportResponse, type PlaceDetailsRequest, type ReverseRequest, type RoutesRequest, type TextSearchRequest, type TileAddress, type TravelMode, type ViewportRequest } from "../services/maps.schema.ts";
export type MapsSettings = typeof MapsSettingsSchema.Type;
export type GoogleSettings = Extract<MapsSettings, {
    readonly provider: "google";
}>;
export type ProviderRefusal = "NoRoute" | "UnsupportedMode" | "UnsupportedRegion" | "ProviderInvalidResponse" | "ProviderUnavailable";
export type MapsReply<A> = {
    readonly kind: "answered";
    readonly value: A;
    readonly observedMicros: Micros;
} | {
    readonly kind: "refused";
    readonly code: ProviderRefusal;
    readonly observedMicros: Micros;
} | {
    readonly kind: "unknown";
    readonly cause: string;
};
export interface MapsTile {
    readonly bytes: Uint8Array;
    readonly contentType: "image/png" | "image/jpeg" | "image/webp";
    readonly attribution: string;
}
export type MapsContext = HttpClient.HttpClient | Deployment;
export interface MapsProvider {
    geocode(request: TextSearchRequest): Effect.Effect<MapsReply<MapsPlacesResponse>, never, MapsContext>;
    search(request: TextSearchRequest): Effect.Effect<MapsReply<MapsPlacesResponse>, never, MapsContext>;
    reverse(request: ReverseRequest): Effect.Effect<MapsReply<MapsPlaceResponse>, never, MapsContext>;
    details(request: PlaceDetailsRequest): Effect.Effect<MapsReply<MapsPlaceResponse>, never, MapsContext>;
    routes(request: RoutesRequest): Effect.Effect<MapsReply<MapsRoutesResponse>, never, MapsContext>;
    tile?(address: TileAddress): Effect.Effect<MapsReply<MapsTile>, never, MapsContext>;
    viewport?(request: ViewportRequest): Effect.Effect<MapsReply<MapsViewportResponse>, never, MapsContext>;
}
export declare const providerKindOf: Readonly<Record<MapsSettings["provider"], ProviderKind>>;
export declare const specModeOf: Readonly<Record<TravelMode, SpecMode>>;
/** @throws {never} */
export declare function mapsProvider(settings: MapsSettings | undefined): MapsProvider | undefined;
/** @throws {never} */
export declare function describeMaps(settings: MapsSettings | undefined, operator: string): MapsCapabilities;
/** @throws {never} */
export declare function googleMapsProvider(settings: GoogleSettings): MapsProvider;
