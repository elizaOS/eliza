import type { MapsSettings } from "../profile/profile.schema.ts";
import type { MapsProvider } from "./maps.vibe";
export type OsmSettings = Extract<typeof MapsSettings.Type, {
    readonly provider: "osm";
}>;
export declare const osmAttribution = "\u00A9 OpenStreetMap contributors (ODbL). Search: Nominatim. Routing: GraphHopper.";
/** @throws {never} */
export declare function osmMapsProvider(settings: OsmSettings): MapsProvider;
