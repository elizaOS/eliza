/**
 * Routed /maps surface: responsive map and list panes over the authoritative
 * server snapshot, with place search, category filters, place details, route
 * alternatives across every travel mode, saved places, and provider
 * attribution. All reads dispatch through the shared view-capability broker;
 * saved-place writes stay on the promoted MAPS_SAVE chat action.
 *
 * Loading, designed-empty, transport-error, offline, and provider-unavailable
 * are distinct renders — nothing degrades into a healthy-looking blank map.
 */

import { type FormEvent, Fragment, useMemo, useState } from "react";
import type { PlacePage, PlaceRef, RoutePlan } from "../types.js";
import type { RouteAlternative } from "../view-contract.js";
import { decodePolyline, projectToViewBox } from "./geometry.js";
import {
  planRouteAlternatives,
  type RouteAlternativesData,
  searchPlaces,
} from "./mapsData.js";
import { useMapsViewState } from "./useMapsViewState.js";
import {
  ACCENT,
  BUTTON_STYLE,
  ERROR_PANEL_STYLE,
  FIELD_STYLE,
  GLASS_PANEL_STYLE,
  PRIMARY_BUTTON_STYLE,
  SECONDARY_TEXT_STYLE,
  VIEW_ROOT_STYLE,
  VIEW_SCROLL_STYLE,
  ViewState,
} from "./viewPrimitives.js";

type SearchPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; page: PlacePage; appended: PlaceRef[] };

type RoutePhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; result: RouteAlternativesData };

const MAP_WIDTH = 100;
const MAP_HEIGHT = 62;
const MAP_PADDING = 8;

function placeKey(place: PlaceRef): string {
  return `${place.provider}:${place.providerPlaceId}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Maps could not reach the local agent.";
}

function formatDistance(distanceMeters: number): string {
  return distanceMeters >= 1_000
    ? `${(distanceMeters / 1_000).toFixed(1)} km`
    : `${distanceMeters} m`;
}

function formatDuration(durationSeconds: number): string {
  const minutes = Math.round(durationSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function _routePath(route: RoutePlan): ReturnType<typeof projectToViewBox> {
  const points = route.encodedPolyline
    ? decodePolyline(route.encodedPolyline)
    : [route.origin.coordinates, route.destination.coordinates];
  return projectToViewBox(points, MAP_WIDTH, MAP_HEIGHT, MAP_PADDING);
}

function MapPane({
  places,
  selected,
  route,
  onSelect,
}: {
  places: readonly PlaceRef[];
  selected: PlaceRef | null;
  route: RoutePlan | null;
  onSelect: (place: PlaceRef) => void;
}) {
  const coordinates = useMemo(() => {
    const all = places.map((place) => place.coordinates);
    if (route) {
      all.push(
        ...(route.encodedPolyline
          ? decodePolyline(route.encodedPolyline)
          : [route.origin.coordinates, route.destination.coordinates]),
      );
    }
    return all;
  }, [places, route]);
  const projected = useMemo(
    () => projectToViewBox(coordinates, MAP_WIDTH, MAP_HEIGHT, MAP_PADDING),
    [coordinates],
  );
  const markerPoints = projected.slice(0, places.length);
  const routePoints = route ? projected.slice(places.length) : [];
  return (
    <figure
      aria-label={
        places.length === 0
          ? "Map with no plotted places"
          : `Map plotting ${places.length} ${places.length === 1 ? "place" : "places"}`
      }
      data-testid="maps-map-pane"
      style={{ ...GLASS_PANEL_STYLE, margin: 0, padding: 10, minWidth: 0 }}
    >
      <svg
        role="img"
        aria-label={
          places.length === 0
            ? "Empty map canvas"
            : `Map markers for ${places.map((place) => place.name).join(", ")}`
        }
        viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        <rect
          x={0}
          y={0}
          width={MAP_WIDTH}
          height={MAP_HEIGHT}
          rx={4}
          fill="color-mix(in srgb, var(--bg, #080808) 82%, transparent)"
        />
        {[1, 2, 3].map((line) => (
          <Fragment key={line}>
            <line
              x1={0}
              x2={MAP_WIDTH}
              y1={(MAP_HEIGHT / 4) * line}
              y2={(MAP_HEIGHT / 4) * line}
              stroke="rgba(255,255,255,.06)"
              strokeWidth={0.3}
            />
            <line
              y1={0}
              y2={MAP_HEIGHT}
              x1={(MAP_WIDTH / 4) * line}
              x2={(MAP_WIDTH / 4) * line}
              stroke="rgba(255,255,255,.06)"
              strokeWidth={0.3}
            />
          </Fragment>
        ))}
        {routePoints.length >= 2 ? (
          <polyline
            data-testid="maps-route-polyline"
            points={routePoints
              .map((point) => `${point.x},${point.y}`)
              .join(" ")}
            fill="none"
            stroke={ACCENT}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {places.map((place, index) => {
          const point = markerPoints[index];
          if (!point) return null;
          const isSelected = selected
            ? placeKey(selected) === placeKey(place)
            : false;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG markers cannot be <button>; role+tabIndex+key handler provide the control semantics.
            <circle
              key={placeKey(place)}
              data-testid="maps-marker"
              role="button"
              aria-label={`Select ${place.name} on the map`}
              tabIndex={0}
              cx={point.x}
              cy={point.y}
              r={isSelected ? 2.6 : 1.8}
              fill={isSelected ? ACCENT : "rgba(255,255,255,.72)"}
              stroke={isSelected ? "rgba(255,255,255,.85)" : "transparent"}
              strokeWidth={0.4}
              style={{ cursor: "pointer" }}
              onClick={() => onSelect(place)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(place);
                }
              }}
            >
              <title>{place.name}</title>
            </circle>
          );
        })}
      </svg>
      {places.length === 0 ? (
        <figcaption style={{ ...SECONDARY_TEXT_STYLE, padding: "8px 4px 2px" }}>
          Search for places to plot them here.
        </figcaption>
      ) : null}
    </figure>
  );
}

function RouteAlternativeRow({
  alternative,
  active,
  onSelect,
}: {
  alternative: RouteAlternative;
  active: boolean;
  onSelect: (route: RoutePlan) => void;
}) {
  if (alternative.status === "error") {
    return (
      <li
        data-testid={`maps-route-${alternative.travelMode}`}
        style={{ ...SECONDARY_TEXT_STYLE, listStyle: "none" }}
      >
        <span style={{ fontWeight: 650, textTransform: "capitalize" }}>
          {alternative.travelMode}
        </span>
        {" — unavailable: "}
        {alternative.message}
      </li>
    );
  }
  const { route } = alternative;
  return (
    <li style={{ listStyle: "none" }}>
      <button
        type="button"
        data-testid={`maps-route-${alternative.travelMode}`}
        aria-pressed={active}
        onClick={() => onSelect(route)}
        style={{
          ...BUTTON_STYLE,
          width: "100%",
          justifyContent: "space-between",
          ...(active
            ? { background: ACCENT, color: "var(--accent-foreground, #fff)" }
            : {}),
        }}
      >
        <span style={{ textTransform: "capitalize" }}>
          {alternative.travelMode}
        </span>
        <span>
          {formatDistance(route.distanceMeters)} ·{" "}
          {formatDuration(route.durationSeconds)}
        </span>
      </button>
      {route.warnings.length > 0 ? (
        <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 4 }}>
          {route.warnings.join(" ")}
        </p>
      ) : null}
    </li>
  );
}

export function MapsView() {
  const { snapshot, loading, error, offline, refresh } = useMapsViewState();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchPhase>({ phase: "idle" });
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<PlaceRef | null>(null);
  const [routeOrigin, setRouteOrigin] = useState<PlaceRef | null>(null);
  const [routes, setRoutes] = useState<RoutePhase>({ phase: "idle" });
  const [activeRoute, setActiveRoute] = useState<RoutePlan | null>(null);

  const providerAvailable = snapshot?.providerAvailable === true;
  const searchDisabled = offline || !providerAvailable;

  const results = useMemo<PlaceRef[]>(() => {
    if (search.phase !== "ready") return [];
    return [...search.page.places, ...search.appended];
  }, [search]);

  const categories = useMemo(() => {
    const unique = new Set<string>();
    for (const place of results) {
      for (const category of place.categories) unique.add(category);
    }
    return [...unique].sort();
  }, [results]);

  const visiblePlaces = useMemo(
    () =>
      categoryFilter
        ? results.filter((place) => place.categories.includes(categoryFilter))
        : results,
    [results, categoryFilter],
  );

  const runSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || searchDisabled) return;
    setSearch({ phase: "loading" });
    setCategoryFilter(null);
    try {
      const page = await searchPlaces({ query: trimmed });
      setSearch({ phase: "ready", page, appended: [] });
    } catch (cause) {
      // error-policy:J4 a failed search renders as a distinct error state.
      setSearch({ phase: "error", message: errorMessage(cause) });
    }
  };

  const loadMore = async () => {
    if (search.phase !== "ready" || !search.page.nextCursor) return;
    const current = search;
    try {
      const nextPage = await searchPlaces({
        query: query.trim(),
        cursor: current.page.nextCursor ?? undefined,
      });
      setSearch({
        phase: "ready",
        page: { ...nextPage, places: current.page.places },
        appended: [...current.appended, ...nextPage.places],
      });
    } catch (cause) {
      // error-policy:J4 pagination failure keeps loaded results and reports.
      setSearch({ phase: "error", message: errorMessage(cause) });
    }
  };

  const planRoutes = async (destination: PlaceRef) => {
    if (!routeOrigin) return;
    setRoutes({ phase: "loading" });
    setActiveRoute(null);
    try {
      const result = await planRouteAlternatives({
        originPlaceId: routeOrigin.providerPlaceId,
        destinationPlaceId: destination.providerPlaceId,
      });
      setRoutes({ phase: "ready", result });
      const firstResolved = result.alternatives.find(
        (alternative) => alternative.status === "ok",
      );
      setActiveRoute(
        firstResolved && firstResolved.status === "ok"
          ? firstResolved.route
          : null,
      );
    } catch (cause) {
      // error-policy:J4 route failure renders as a distinct error state.
      setRoutes({ phase: "error", message: errorMessage(cause) });
    }
  };

  const selectPlace = (place: PlaceRef) => {
    setSelected(place);
    setRoutes({ phase: "idle" });
    setActiveRoute(null);
  };

  const savedPlaces = snapshot?.savedPlaces ?? null;
  const attribution = snapshot?.providers ?? [];

  return (
    <main
      aria-busy={loading}
      aria-label="Maps"
      data-testid="maps-view"
      style={VIEW_ROOT_STYLE}
    >
      <div data-testid="maps-scroll-region" style={VIEW_SCROLL_STYLE}>
        {offline ? (
          <div
            role="status"
            data-testid="maps-offline"
            style={{
              ...GLASS_PANEL_STYLE,
              marginBottom: 12,
              padding: 12,
              boxShadow: `inset 0 0 0 1px ${ACCENT}, 0 18px 48px rgba(0,0,0,.20)`,
            }}
          >
            You're offline. Showing the last loaded maps data; search and
            routing are paused until the connection returns.
          </div>
        ) : null}
        {snapshot === null ? (
          <ViewState
            loading={loading}
            error={error}
            empty={false}
            emptyTitle=""
            emptyBody=""
          />
        ) : (
          <Fragment>
            {error ? (
              <div
                role="alert"
                style={{ ...ERROR_PANEL_STYLE, marginBottom: 12 }}
              >
                {error}
                <button
                  type="button"
                  onClick={() => void refresh()}
                  style={{ ...BUTTON_STYLE, marginInlineStart: 10 }}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {!providerAvailable ? (
              <div
                data-testid="maps-provider-unavailable"
                style={{ ...GLASS_PANEL_STYLE, marginBottom: 12, padding: 16 }}
              >
                <p style={{ margin: 0, fontWeight: 650 }}>
                  No maps provider is connected
                </p>
                <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 6 }}>
                  Connect a maps provider to search places and plan routes.
                  Saved places remain available below.
                </p>
              </div>
            ) : null}
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
                gap: 12,
                minWidth: 0,
              }}
            >
              <section aria-label="Map and search" style={{ minWidth: 0 }}>
                <form
                  onSubmit={runSearch}
                  aria-label="Place search"
                  data-testid="maps-search-form"
                  style={{ display: "flex", gap: 8, marginBottom: 12 }}
                >
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search places…"
                    aria-label="Search places"
                    disabled={searchDisabled}
                    style={FIELD_STYLE}
                  />
                  <button
                    type="submit"
                    disabled={searchDisabled || !query.trim()}
                    style={PRIMARY_BUTTON_STYLE}
                  >
                    Search
                  </button>
                </form>
                <MapPane
                  places={visiblePlaces}
                  selected={selected}
                  route={activeRoute}
                  onSelect={selectPlace}
                />
                {attribution.length > 0 ? (
                  <p
                    data-testid="maps-attribution"
                    style={{
                      ...SECONDARY_TEXT_STYLE,
                      marginTop: 8,
                      fontSize: 11,
                    }}
                  >
                    {attribution
                      .map(
                        (provider) =>
                          provider.attribution ?? `Data: ${provider.id}`,
                      )
                      .join(" · ")}
                  </p>
                ) : null}
              </section>
              <section aria-label="Results and details" style={{ minWidth: 0 }}>
                {search.phase === "loading" ? (
                  <div
                    aria-live="polite"
                    data-testid="maps-search-loading"
                    style={{ ...GLASS_PANEL_STYLE, padding: 14 }}
                  >
                    <p style={SECONDARY_TEXT_STYLE}>Searching…</p>
                  </div>
                ) : null}
                {search.phase === "error" ? (
                  <div
                    role="alert"
                    data-testid="maps-search-error"
                    style={ERROR_PANEL_STYLE}
                  >
                    {search.message}
                  </div>
                ) : null}
                {search.phase === "ready" && results.length === 0 ? (
                  <ViewState
                    loading={false}
                    error={null}
                    empty
                    emptyTitle="No places matched"
                    emptyBody="Try a broader search term."
                  />
                ) : null}
                {results.length > 0 ? (
                  <Fragment>
                    {categories.length > 0 ? (
                      <fieldset
                        aria-label="Filter by category"
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 6,
                          margin: "0 0 10px",
                          padding: 0,
                          border: "none",
                        }}
                      >
                        <button
                          type="button"
                          aria-pressed={categoryFilter === null}
                          onClick={() => setCategoryFilter(null)}
                          style={{
                            ...BUTTON_STYLE,
                            minHeight: 32,
                            ...(categoryFilter === null
                              ? {
                                  background: ACCENT,
                                  color: "var(--accent-foreground, #fff)",
                                }
                              : {}),
                          }}
                        >
                          All
                        </button>
                        {categories.map((category) => (
                          <button
                            key={category}
                            type="button"
                            aria-pressed={categoryFilter === category}
                            onClick={() =>
                              setCategoryFilter(
                                categoryFilter === category ? null : category,
                              )
                            }
                            style={{
                              ...BUTTON_STYLE,
                              minHeight: 32,
                              ...(categoryFilter === category
                                ? {
                                    background: ACCENT,
                                    color: "var(--accent-foreground, #fff)",
                                  }
                                : {}),
                            }}
                          >
                            {category}
                          </button>
                        ))}
                      </fieldset>
                    ) : null}
                    <ul
                      aria-label="Search results"
                      data-testid="maps-results"
                      style={{
                        margin: 0,
                        padding: 0,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      {visiblePlaces.map((place) => (
                        <li key={placeKey(place)} style={{ listStyle: "none" }}>
                          <button
                            type="button"
                            aria-pressed={
                              selected
                                ? placeKey(selected) === placeKey(place)
                                : false
                            }
                            onClick={() => selectPlace(place)}
                            style={{
                              ...BUTTON_STYLE,
                              width: "100%",
                              justifyContent: "flex-start",
                              textAlign: "start",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              gap: 2,
                              ...(selected &&
                              placeKey(selected) === placeKey(place)
                                ? {
                                    boxShadow: `inset 0 0 0 1.5px ${ACCENT}`,
                                  }
                                : {}),
                            }}
                          >
                            <span style={{ fontWeight: 650 }}>
                              {place.name}
                            </span>
                            {place.formattedAddress ? (
                              <span style={{ ...SECONDARY_TEXT_STYLE }}>
                                {place.formattedAddress}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {search.phase === "ready" && search.page.nextCursor ? (
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        style={{ ...BUTTON_STYLE, marginTop: 10 }}
                      >
                        More results
                      </button>
                    ) : null}
                  </Fragment>
                ) : null}
                {selected ? (
                  <article
                    aria-label={`Details for ${selected.name}`}
                    data-testid="maps-place-details"
                    style={{ ...GLASS_PANEL_STYLE, marginTop: 12, padding: 16 }}
                  >
                    <h2 style={{ margin: 0, fontSize: 16 }}>{selected.name}</h2>
                    {selected.formattedAddress ? (
                      <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 4 }}>
                        {selected.formattedAddress}
                      </p>
                    ) : null}
                    <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 4 }}>
                      {selected.coordinates.latitude.toFixed(5)},{" "}
                      {selected.coordinates.longitude.toFixed(5)} ·{" "}
                      {selected.provider}
                    </p>
                    {selected.categories.length > 0 ? (
                      <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 4 }}>
                        {selected.categories.join(" · ")}
                      </p>
                    ) : null}
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        marginTop: 12,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setRouteOrigin(selected)}
                        style={BUTTON_STYLE}
                      >
                        Set as origin
                      </button>
                      <button
                        type="button"
                        disabled={
                          !routeOrigin ||
                          placeKey(routeOrigin) === placeKey(selected) ||
                          offline
                        }
                        onClick={() => void planRoutes(selected)}
                        style={PRIMARY_BUTTON_STYLE}
                      >
                        {routeOrigin
                          ? `Routes from ${routeOrigin.name}`
                          : "Pick an origin first"}
                      </button>
                    </div>
                    {routes.phase === "loading" ? (
                      <p
                        aria-live="polite"
                        data-testid="maps-routes-loading"
                        style={{ ...SECONDARY_TEXT_STYLE, marginTop: 10 }}
                      >
                        Planning routes…
                      </p>
                    ) : null}
                    {routes.phase === "error" ? (
                      <div
                        role="alert"
                        data-testid="maps-routes-error"
                        style={{ ...ERROR_PANEL_STYLE, marginTop: 10 }}
                      >
                        {routes.message}
                      </div>
                    ) : null}
                    {routes.phase === "ready" ? (
                      <ul
                        aria-label="Route alternatives"
                        data-testid="maps-route-alternatives"
                        style={{
                          margin: "10px 0 0",
                          padding: 0,
                          display: "grid",
                          gap: 6,
                        }}
                      >
                        {routes.result.alternatives.map((alternative) => (
                          <RouteAlternativeRow
                            key={alternative.travelMode}
                            alternative={alternative}
                            active={
                              alternative.status === "ok" &&
                              activeRoute?.routeId === alternative.route.routeId
                            }
                            onSelect={setActiveRoute}
                          />
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ) : null}
                <section
                  aria-label="Saved places"
                  data-testid="maps-saved-places"
                  style={{ ...GLASS_PANEL_STYLE, marginTop: 12, padding: 16 }}
                >
                  <h2 style={{ margin: 0, fontSize: 15 }}>Saved places</h2>
                  {savedPlaces === null ? null : savedPlaces.status ===
                    "unavailable" ? (
                    <p
                      data-testid="maps-saved-unavailable"
                      style={{ ...SECONDARY_TEXT_STYLE, marginTop: 8 }}
                    >
                      {savedPlaces.reason}
                    </p>
                  ) : savedPlaces.places.length === 0 ? (
                    <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 8 }}>
                      Nothing saved yet. Ask your agent in chat to save a place.
                    </p>
                  ) : (
                    <ul
                      style={{
                        margin: "8px 0 0",
                        padding: 0,
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      {savedPlaces.places.map((saved) => (
                        <li key={saved.id} style={{ listStyle: "none" }}>
                          <button
                            type="button"
                            onClick={() => selectPlace(saved.place)}
                            style={{
                              ...BUTTON_STYLE,
                              width: "100%",
                              justifyContent: "space-between",
                            }}
                          >
                            <span style={{ fontWeight: 650 }}>
                              {saved.label}
                            </span>
                            <span style={SECONDARY_TEXT_STYLE}>
                              {saved.place.name}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </section>
            </div>
          </Fragment>
        )}
      </div>
    </main>
  );
}

export default MapsView;
