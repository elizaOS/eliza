/**
 * Pure public GeoNames place/zone lookup shared by weather and publication-day policy.
 * GeoNames: https://www.geonames.org/ — CC BY 4.0.
 * Exact source inputs, hashes and reduced-column projection notice are retained in
 * assets/world-weather-places.provenance.json. No coordinates or zones inferred.
 */
import places from "./assets/world-weather-places.json";

export interface WorldWeatherPlace {
  id: number;
  name: string;
  country: string;
  countryCode: string;
  region: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}
const fold = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[.'’]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
const catalog = places as {
  format: string;
  countries: Array<[string, string, string]>;
  regions: Array<[string, string, string]>;
  zones: string[];
  places: Array<[number, string, string | null, number, number, number, number, number]>;
};
const rows = catalog.places;
const placeOf = (row: (typeof rows)[number]): WorldWeatherPlace => ({
  id: row[0],
  name: row[1],
  country: catalog.countries[row[3]][1],
  countryCode: catalog.countries[row[3]][0],
  region: catalog.regions[row[4]][1],
  latitude: row[5],
  longitude: row[6],
  timeZone: catalog.zones[row[7]],
});

// Immutable public data permits bounded memoization; return copies so callers cannot alter shared authority.
const placeCache = new Map<string, WorldWeatherPlace | undefined>();
/** Exact gazetteer names and qualifiers disambiguate; population is never a selection authority. */
export function resolveWorldWeatherPlace(location: string): WorldWeatherPlace | undefined {
  const [city, ...qualifiers] = location.split(",").map(fold);
  if (!city || qualifiers.length > 2 || qualifiers.some((value) => !value)) return undefined;
  const cacheKey = [city, ...qualifiers].join(",");
  if (placeCache.has(cacheKey)) {
    const cached = placeCache.get(cacheKey);
    return cached ? { ...cached } : undefined;
  }
  const candidates = rows.filter(
    (row) =>
      (fold(row[1]) === city || fold(row[2] ?? row[1]) === city) &&
      qualifiers.every((qualifier) =>
        [...catalog.countries[row[3]], ...catalog.regions[row[4]]].some(
          (label) => fold(label) === qualifier,
        ),
      ),
  );
  const selected = candidates.length === 1 ? placeOf(candidates[0]) : undefined;
  if (placeCache.size >= 128) placeCache.delete(placeCache.keys().next().value as string);
  placeCache.set(cacheKey, selected);
  return selected ? { ...selected } : undefined;
}
const dateFormats = new Map<string, Intl.DateTimeFormat>();
export function worldWeatherLocalDay(time: number, zone: string): string {
  let format = dateFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    if (dateFormats.size >= 128) dateFormats.delete(dateFormats.keys().next().value as string);
    dateFormats.set(zone, format);
  }
  const parts = format.formatToParts(time);
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}
