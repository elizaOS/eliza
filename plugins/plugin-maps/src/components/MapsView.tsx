/**
 * Renders the provider-neutral Maps workspace and keeps every domain read on
 * the authenticated view broker while persistent actions hand off to Eliza.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { dispatchChatPrefill } from "@elizaos/ui/events";
import { useAppSelector } from "@elizaos/ui/state";
import {
  Bike,
  Bus,
  Car,
  ChevronRight,
  Clock3,
  Footprints,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Navigation,
  RotateCcw,
  Route as RouteIcon,
  Search,
  Share2,
  Star,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PlaceRef, RoutePlan, TravelMode } from "../types.js";
import {
  type MapsProviderDescription,
  type MapsViewTransport,
  mapsViewTransport,
} from "./maps-view-data.js";

const TRAVEL_MODES: readonly TravelMode[] = [
  "drive",
  "walk",
  "bicycle",
  "transit",
];
const MAP_GRID_LINES = ["a", "b", "c", "d", "e", "f", "g"] as const;
const LOADING_ROWS = ["a", "b", "c", "d", "e"] as const;

const controlClass =
  "min-h-11 rounded-lg border border-border bg-bg px-3 text-sm text-text outline-none transition-colors hover:border-[#ff5800] focus-visible:border-[#ff5800] focus-visible:ring-2 focus-visible:ring-[#ff5800]/35";
const primaryClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#ff5800] px-4 text-sm font-semibold text-white outline-none transition-colors hover:bg-[#d94b00] focus-visible:ring-2 focus-visible:ring-[#ff5800]/45 disabled:cursor-not-allowed disabled:opacity-50";
const subtleButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-bg px-3 text-sm font-medium text-text outline-none transition-colors hover:border-[#ff5800] hover:bg-[#ff5800]/10 focus-visible:ring-2 focus-visible:ring-[#ff5800]/35";

/** Encode provider-owned strings without collapsing punctuation variants. */
function agentIdPart(value: string): string {
  return encodeURIComponent(value);
}

type Phase = "idle" | "searching" | "ready" | "error";

function readChatSheetOpen(): boolean {
  return (
    document
      .querySelector('[data-testid="chat-overlay"]')
      ?.getAttribute("data-open") === "true"
  );
}

function useChatSheetOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const publish = () => setOpen(readChatSheetOpen());
    publish();
    const observer = new MutationObserver(publish);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-open"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return open;
}

export interface MapsViewProps {
  /** Test and host seam; production defaults to the authenticated broker. */
  transport?: MapsViewTransport;
  /** Deterministic network seam for state coverage. */
  online?: boolean;
}

interface SearchControlProps {
  value: string;
  invalid: string | null;
  busy: boolean;
  onValue: (value: string) => void;
}

function SearchControl({ value, invalid, busy, onValue }: SearchControlProps) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "maps-search-query",
    role: "text-input",
    label: "Search places",
    description: "Place, landmark, category, or address to find",
    onFill: onValue,
  });
  return (
    <label className="relative min-w-0 sm:col-span-5">
      <span className="sr-only">Search places or addresses</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={ref}
        {...agentProps}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? "maps-search-error" : undefined}
        autoComplete="off"
        maxLength={500}
        placeholder="Search a place, category, or address"
        className={`${controlClass} w-full pr-4 pl-10`}
        aria-busy={busy}
      />
    </label>
  );
}

function SearchSubmitControl({
  busy,
  disabled,
  onActivate,
}: {
  busy: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "maps-search-submit",
    role: "button",
    label: busy ? "Searching" : "Search",
    description: "Submit the current place search",
    status: busy ? "busy" : "ready",
    onActivate,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="submit"
      className={`${primaryClass} sm:min-w-28`}
      disabled={disabled}
    >
      {busy ? (
        <RotateCcw aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <Search aria-hidden="true" className="size-4" />
      )}
      {busy ? "Searching" : "Search"}
    </button>
  );
}

interface AgentButtonProps {
  id: string;
  label: string;
  description: string;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function AgentButton({
  id,
  label,
  description,
  className = subtleButtonClass,
  disabled,
  pressed,
  onClick,
  children,
}: AgentButtonProps) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id,
    role: "button",
    label,
    description,
    status: pressed ? "active" : "inactive",
    onActivate: onClick,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      className={className}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface PlaceRowProps {
  place: PlaceRef;
  active: boolean;
  origin: boolean;
  onSelect: () => void;
}

function PlaceRow({ place, active, origin, onSelect }: PlaceRowProps) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `maps-place-${agentIdPart(place.provider)}:${agentIdPart(place.providerPlaceId)}`,
    role: "list-item",
    label: place.name,
    description: place.formattedAddress ?? "Select place details",
    status: active ? "selected" : "available",
    onActivate: onSelect,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`group flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#ff5800]/40 ${
        active ? "bg-[#ff5800]/12" : "hover:bg-[#ff5800]/8"
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid size-10 shrink-0 place-items-center rounded-lg ${
          active ? "bg-[#ff5800] text-white" : "bg-muted text-[#d94b00]"
        }`}
      >
        <MapPin className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text">
            {place.name}
          </span>
          {origin ? (
            <span className="rounded-md bg-[#ff5800]/12 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-[#c54500] uppercase">
              Start
            </span>
          ) : null}
        </span>
        <span className="line-clamp-1 text-xs text-muted-foreground">
          {place.formattedAddress ?? "Address unavailable"}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}

function MapMarker({
  place,
  index,
  active,
  x,
  y,
  onSelect,
}: {
  place: PlaceRef;
  index: number;
  active: boolean;
  x: number;
  y: number;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `maps-marker-${agentIdPart(place.provider)}:${agentIdPart(place.providerPlaceId)}`,
    role: "button",
    label: `Select ${place.name} on map`,
    description: place.formattedAddress ?? "Select map marker details",
    status: active ? "selected" : "available",
    onActivate: onSelect,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`absolute grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white font-bold shadow-md outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-[#ff5800] ${
        active ? "bg-[#d94b00] text-white" : "bg-[#ff5800] text-white"
      }`}
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      <span aria-hidden="true">{index + 1}</span>
    </button>
  );
}

function modeIcon(mode: TravelMode) {
  switch (mode) {
    case "drive":
      return Car;
    case "walk":
      return Footprints;
    case "bicycle":
      return Bike;
    case "transit":
      return Bus;
  }
}

function formatDistance(meters: number): string {
  return meters < 1_000
    ? `${meters} m`
    : `${(meters / 1_000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

interface RouteChoiceProps {
  route: RoutePlan;
  active: boolean;
  onSelect: () => void;
}

function RouteChoice({ route, active, onSelect }: RouteChoiceProps) {
  const Icon = modeIcon(route.travelMode);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `maps-route-${route.travelMode}`,
    role: "card",
    label: `${route.travelMode} route`,
    description: `${formatDuration(route.durationSeconds)}, ${formatDistance(route.distanceMeters)}`,
    status: active ? "selected" : "available",
    onActivate: onSelect,
  });
  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`min-h-20 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#ff5800]/40 ${
        active
          ? "border-[#ff5800] bg-[#ff5800]/10"
          : "border-border bg-bg hover:border-[#ff5800]"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-semibold capitalize">
        <Icon aria-hidden="true" className="size-4 text-[#d94b00]" />
        {route.travelMode}
      </span>
      <span className="mt-2 block text-sm font-bold text-text">
        {formatDuration(route.durationSeconds)}
      </span>
      <span className="text-xs text-muted-foreground">
        {formatDistance(route.distanceMeters)}
      </span>
    </button>
  );
}

function projectPlaces(places: readonly PlaceRef[]) {
  if (!places.length) return [];
  const latitudes = places.map((place) => place.coordinates.latitude);
  const longitudes = places.map((place) => place.coordinates.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const latRange = Math.max(0.005, maxLat - minLat);
  const lonRange = Math.max(0.005, maxLon - minLon);
  return places.map((place, index) => ({
    place,
    index,
    x: 10 + ((place.coordinates.longitude - minLon) / lonRange) * 80,
    y: 90 - ((place.coordinates.latitude - minLat) / latRange) * 80,
  }));
}

interface MapPanelProps {
  places: readonly PlaceRef[];
  attributionProviderIds: readonly string[];
  providers: readonly MapsProviderDescription[];
  selected: PlaceRef | null;
  activeRoute: RoutePlan | null;
  onSelect: (place: PlaceRef) => void;
}

function MapPanel({
  places,
  attributionProviderIds,
  providers,
  selected,
  activeRoute,
  onSelect,
}: MapPanelProps) {
  const points = useMemo(() => projectPlaces(places), [places]);
  const providerAttribution = useMemo(() => {
    const descriptions = new Map(
      providers.map((provider) => [provider.id, provider]),
    );
    return attributionProviderIds
      .map((providerId) => {
        const attribution = descriptions.get(providerId)?.attribution;
        return attribution ?? `Legal attribution unavailable for ${providerId}`;
      })
      .join(" · ");
  }, [attributionProviderIds, providers]);
  return (
    <figure
      aria-labelledby="maps-canvas-title"
      className="relative min-h-[280px] overflow-hidden rounded-xl bg-[#f5ede6] dark:bg-[#2a1c16] lg:min-h-0 lg:border lg:border-border"
    >
      <figcaption id="maps-canvas-title" className="sr-only">
        Map plot. Every marker is also represented in the places list.
      </figcaption>
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
      >
        <path
          d="M-5 24 C20 14 28 35 53 26 S87 12 108 25"
          fill="none"
          stroke="#d8c8bb"
          strokeWidth="2.2"
        />
        <path
          d="M8 -5 C18 24 9 48 30 65 S55 82 61 105"
          fill="none"
          stroke="#cfbdae"
          strokeWidth="1.5"
        />
        <path
          d="M-4 76 C25 63 47 77 69 61 S91 47 106 54"
          fill="none"
          stroke="#dfd1c6"
          strokeWidth="3"
        />
        {MAP_GRID_LINES.map((key, index) => (
          <line
            key={key}
            x1={index * 18}
            x2={index * 18 - 24}
            y1="0"
            y2="100"
            stroke="#eadfd7"
            strokeWidth="0.6"
          />
        ))}
      </svg>
      <div className="absolute inset-0">
        {points.map(({ place, index, x, y }) => {
          const active =
            selected?.provider === place.provider &&
            selected.providerPlaceId === place.providerPlaceId;
          return (
            <MapMarker
              key={`${place.provider}:${place.providerPlaceId}`}
              place={place}
              index={index}
              active={active}
              x={x}
              y={y}
              onSelect={() => onSelect(place)}
            />
          );
        })}
      </div>
      <div
        data-testid="maps-schematic-label"
        className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-lg bg-bg/90 px-3 py-2 text-xs font-medium text-text shadow-sm backdrop-blur"
      >
        <MapIcon aria-hidden="true" className="size-4 text-[#d94b00]" />
        Provider-neutral map
      </div>
      <div
        data-testid="maps-bottom-overlays"
        className="pointer-events-none absolute right-3 bottom-3 left-3 flex flex-col items-end gap-2"
      >
        {activeRoute ? (
          <div
            data-testid="maps-route-disclaimer"
            className="w-full rounded-lg bg-bg/90 px-3 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur"
          >
            Route geometry is not drawn in this provider-neutral schematic. Time
            and distance remain provider-backed.
          </div>
        ) : null}
        <div
          data-testid="maps-provider-attribution"
          className="max-w-full break-words rounded-md bg-bg/90 px-2 py-1 text-right text-[11px] text-muted-foreground shadow-sm"
        >
          {attributionProviderIds.length
            ? providerAttribution
            : "No provider data loaded"}
        </div>
      </div>
    </figure>
  );
}

function EmptyState({
  filtered,
  onReset,
}: {
  filtered: boolean;
  onReset: () => void;
}) {
  return (
    <div className="grid min-h-56 place-items-center px-6 py-10 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-xl bg-[#ff5800]/12 text-[#d94b00]">
          <MapPin aria-hidden="true" className="size-6" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-text">
          {filtered
            ? "No places match these filters"
            : "Find somewhere worth going"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {filtered
            ? "Clear the active filter or try a broader search."
            : "Search a place, landmark, category, or address. Results stay provider-neutral until a maps connector answers."}
        </p>
        {filtered ? (
          <AgentButton
            id="maps-clear-filter"
            label="Clear place filters"
            description="Show every loaded place result"
            className={`${subtleButtonClass} mt-4`}
            onClick={onReset}
          >
            Clear filters
          </AgentButton>
        ) : null}
      </div>
    </div>
  );
}

export function MapsView({
  transport = mapsViewTransport,
  online,
}: MapsViewProps = {}) {
  const setActionNotice = useAppSelector((state) => state.setActionNotice);
  const chatSheetOpen = useChatSheetOpen();
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<PlaceRef[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [selected, setSelected] = useState<PlaceRef | null>(null);
  const [origin, setOrigin] = useState<PlaceRef | null>(null);
  const [category, setCategory] = useState("all");
  const [routes, setRoutes] = useState<RoutePlan[]>([]);
  const [activeRouteId, setActiveRouteId] = useState<string | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [providers, setProviders] = useState<MapsProviderDescription[]>([]);
  const [providerMetadataRevision, setProviderMetadataRevision] = useState(0);
  const [isOnline, setIsOnline] = useState(
    online ?? (typeof navigator === "undefined" ? true : navigator.onLine),
  );
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const routeRequest = useRef<AbortController | null>(null);
  const providerMetadataRequest = useRef<AbortController | null>(null);
  const detailRequestGeneration = useRef(0);
  const routeRequestGeneration = useRef(0);
  const attributionProviderIds = useMemo(
    () => [
      ...new Set([
        ...places.map((place) => place.provider),
        ...routes.map((route) => route.provider),
      ]),
    ],
    [places, routes],
  );
  const attributionProviderKey = attributionProviderIds.join("\0");
  const providerMetadataRequestKey = attributionProviderKey
    ? `${attributionProviderKey}\0${providerMetadataRevision}`
    : "";

  const invalidateRouteOperation = useCallback(() => {
    routeRequestGeneration.current += 1;
    routeRequest.current?.abort();
    routeRequest.current = null;
    setRouteBusy(false);
    setRouteError(null);
    setRoutes([]);
    setActiveRouteId(null);
  }, []);

  useEffect(() => {
    if (online !== undefined) {
      setIsOnline(online);
      return;
    }
    if (typeof window === "undefined") return;
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [online]);

  useEffect(() => {
    providerMetadataRequest.current?.abort();
    providerMetadataRequest.current = null;
    if (!providerMetadataRequestKey || !transport.describeProviders) {
      setProviders([]);
      return;
    }
    const controller = new AbortController();
    providerMetadataRequest.current = controller;
    void transport
      .describeProviders(controller.signal)
      .then((descriptions) => {
        if (!controller.signal.aborted) setProviders(descriptions);
      })
      // error-policy:J4 Missing provider metadata is rendered as an explicit
      // attribution-unavailable state for each provider returned by a search.
      .catch((_cause: unknown) => {
        if (!controller.signal.aborted) setProviders([]);
      });
    return () => {
      controller.abort();
      if (providerMetadataRequest.current === controller) {
        providerMetadataRequest.current = null;
      }
    };
  }, [providerMetadataRequestKey, transport]);

  useEffect(
    () => () => {
      searchRequest.current?.abort();
      detailRequest.current?.abort();
      routeRequest.current?.abort();
    },
    [],
  );

  const validationError = useMemo(() => {
    const normalized = query.trim();
    if (normalized.length > 500)
      return "Search must be 500 characters or fewer.";
    return null;
  }, [query]);

  const categories = useMemo(() => {
    const normalized = new Set(
      places.flatMap((place) =>
        place.categories.map((value) => value.trim().toLowerCase()),
      ),
    );
    normalized.delete("");
    normalized.delete("all");
    return ["all", ...normalized].slice(0, 8);
  }, [places]);

  const filteredPlaces = useMemo(
    () =>
      category === "all"
        ? places
        : places.filter((place) =>
            place.categories.some(
              (value) => value.trim().toLowerCase() === category,
            ),
          ),
    [category, places],
  );

  const activeRoute =
    routes.find((route) => route.routeId === activeRouteId) ??
    routes[0] ??
    null;
  const runSearch = useCallback(
    async (requested: string) => {
      const normalized = requested.trim();
      if (!normalized) {
        providerMetadataRequest.current?.abort();
        providerMetadataRequest.current = null;
        searchRequest.current?.abort();
        detailRequestGeneration.current += 1;
        detailRequest.current?.abort();
        detailRequest.current = null;
        invalidateRouteOperation();
        setPhase("idle");
        setError(null);
        setPlaces([]);
        setNextCursor(null);
        setSelected(null);
        setCategory("all");
        setProviders([]);
        return;
      }
      if (normalized.length > 500) return;
      if (!isOnline) {
        setError("You are offline. Reconnect to search for new places.");
        setPhase(places.length ? "ready" : "error");
        return;
      }
      detailRequestGeneration.current += 1;
      detailRequest.current?.abort();
      detailRequest.current = null;
      invalidateRouteOperation();
      providerMetadataRequest.current?.abort();
      providerMetadataRequest.current = null;
      setSelected(null);
      searchRequest.current?.abort();
      setPageBusy(false);
      const controller = new AbortController();
      searchRequest.current = controller;
      setPhase("searching");
      setError(null);
      setProviders([]);
      setLastQuery(normalized);
      try {
        const page = await transport.search(normalized, controller.signal);
        if (controller.signal.aborted || searchRequest.current !== controller)
          return;
        setPlaces(page.places);
        setNextCursor(page.nextCursor);
        setSelected(page.places[0] ?? null);
        setCategory("all");
        setRoutes([]);
        setActiveRouteId(null);
        setProviderMetadataRevision((revision) => revision + 1);
        setPhase("ready");
      } catch (cause) {
        if (controller.signal.aborted) return;
        // error-policy:J4 an authenticated read failure becomes a visible error state.
        setError(
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Could not search places.",
        );
        setPhase("error");
      } finally {
        if (searchRequest.current === controller) searchRequest.current = null;
      }
    },
    [invalidateRouteOperation, isOnline, places.length, transport],
  );

  const loadNextPage = useCallback(async () => {
    if (!nextCursor || pageBusy || !isOnline || !lastQuery) return;
    const controller = new AbortController();
    searchRequest.current?.abort();
    searchRequest.current = controller;
    setPageBusy(true);
    setError(null);
    try {
      const page = await transport.search(
        lastQuery,
        controller.signal,
        nextCursor,
      );
      if (controller.signal.aborted) return;
      setPlaces((current) => {
        const seen = new Set(
          current.map((place) => `${place.provider}:${place.providerPlaceId}`),
        );
        const added: PlaceRef[] = [];
        for (const place of page.places) {
          const key = `${place.provider}:${place.providerPlaceId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          added.push(place);
        }
        return [...current, ...added];
      });
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      // error-policy:J4 pagination failures preserve prior visible places.
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Could not load more places.",
      );
    } finally {
      if (searchRequest.current === controller) searchRequest.current = null;
      if (!controller.signal.aborted) setPageBusy(false);
    }
  }, [isOnline, lastQuery, nextCursor, pageBusy, transport]);

  const submitSearch = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void runSearch(query);
    },
    [query, runSearch],
  );

  const selectPlace = useCallback(
    (place: PlaceRef) => {
      detailRequestGeneration.current += 1;
      const detailGeneration = detailRequestGeneration.current;
      detailRequest.current?.abort();
      detailRequest.current = null;
      invalidateRouteOperation();
      setSelected(place);
      if (!isOnline) return;
      const controller = new AbortController();
      detailRequest.current = controller;
      void transport
        .getPlace(place, controller.signal)
        .then((detail) => {
          if (
            controller.signal.aborted ||
            detailRequest.current !== controller ||
            detailRequestGeneration.current !== detailGeneration
          )
            return;
          if (detail) setSelected(detail);
        })
        // error-policy:J4 the normalized search result remains visible while
        // a failed optional detail enrichment is announced.
        .catch((cause: unknown) => {
          if (
            controller.signal.aborted ||
            detailRequest.current !== controller ||
            detailRequestGeneration.current !== detailGeneration
          )
            return;
          setRouteError(
            cause instanceof Error
              ? cause.message
              : "Place details unavailable.",
          );
        })
        .finally(() => {
          if (
            detailRequest.current === controller &&
            detailRequestGeneration.current === detailGeneration
          )
            detailRequest.current = null;
        });
    },
    [invalidateRouteOperation, isOnline, transport],
  );

  const planRoutes = useCallback(async () => {
    if (!origin || !selected || routeBusy) return;
    if (
      origin.provider === selected.provider &&
      origin.providerPlaceId === selected.providerPlaceId
    ) {
      setRouteError("Choose a different destination before comparing routes.");
      return;
    }
    if (!isOnline) {
      setRouteError("Route planning is unavailable while offline.");
      return;
    }
    routeRequest.current?.abort();
    routeRequestGeneration.current += 1;
    const routeGeneration = routeRequestGeneration.current;
    const controller = new AbortController();
    routeRequest.current = controller;
    setRouteBusy(true);
    setRouteError(null);
    setRoutes([]);
    try {
      const outcomes = await Promise.allSettled(
        TRAVEL_MODES.map((mode) =>
          transport.planRoute(origin, selected, mode, controller.signal),
        ),
      );
      if (
        controller.signal.aborted ||
        routeRequest.current !== controller ||
        routeRequestGeneration.current !== routeGeneration
      )
        return;
      const available = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      if (!available.length) {
        const firstFailure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        );
        throw (
          firstFailure?.reason ??
          new Error("No route alternatives are available.")
        );
      }
      setRoutes(available);
      setActiveRouteId(available[0]?.routeId ?? null);
    } catch (cause) {
      if (
        controller.signal.aborted ||
        routeRequest.current !== controller ||
        routeRequestGeneration.current !== routeGeneration
      )
        return;
      // error-policy:J4 route failures remain distinct from place results.
      setRouteError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Could not plan a route.",
      );
    } finally {
      if (
        routeRequest.current === controller &&
        routeRequestGeneration.current === routeGeneration
      ) {
        routeRequest.current = null;
        setRouteBusy(false);
      }
    }
  }, [isOnline, origin, routeBusy, selected, transport]);

  const handoff = useCallback(
    (action: "MAPS_SAVE" | "MAPS_SHARE" | "MAPS_NAVIGATE") => {
      if (!selected) return;
      const verb =
        action === "MAPS_SAVE"
          ? "save"
          : action === "MAPS_SHARE"
            ? "prepare a share link for"
            : "prepare navigation to";
      dispatchChatPrefill({
        text: `Use ${action} for provider place ${selected.providerPlaceId} from ${selected.provider} (${selected.name}, ${selected.coordinates.latitude}, ${selected.coordinates.longitude}).`,
        select: false,
      });
      setActionNotice(
        `Review and send the Eliza request to ${verb} ${selected.name}. ${action} will run through the agent action boundary.`,
        "info",
        5000,
      );
    },
    [selected, setActionNotice],
  );

  const handleShellKey = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        detailRequestGeneration.current += 1;
        detailRequest.current?.abort();
        detailRequest.current = null;
        invalidateRouteOperation();
        setSelected(null);
      }
    },
    [invalidateRouteOperation],
  );

  return (
    <main
      data-testid="maps-view"
      data-scroll-cert-scroller
      aria-busy={phase === "searching" || pageBusy || routeBusy}
      onKeyDown={handleShellKey}
      className="h-full min-h-0 w-full overflow-x-hidden overflow-y-auto bg-bg text-text"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col gap-4 px-4 pt-4 pb-28 sm:px-6 lg:px-8 lg:pt-6">
        <header className="grid gap-4 lg:grid-cols-2 lg:items-end">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-[#c54500] uppercase">
              Explore · Provider-neutral map
            </p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Maps
              </h1>
              <p className="text-base font-semibold text-text">
                Find somewhere worth going
              </p>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Search normalized places, compare provider-backed routes, and hand
              off persistent actions to Eliza.
            </p>
          </div>
          {origin ? (
            <div className="flex min-h-11 items-center gap-2 rounded-lg bg-[#ff5800]/10 px-3 text-sm lg:justify-self-end">
              <LocateFixed
                aria-hidden="true"
                className="size-4 text-[#d94b00]"
              />
              <span className="text-muted-foreground">Starting at</span>
              <strong className="max-w-44 truncate">{origin.name}</strong>
              <AgentButton
                id="maps-clear-origin"
                label={`Clear route origin ${origin.name}`}
                description="Remove the current route starting place"
                className="ml-1 min-h-11 rounded-md px-2 text-[#c54500] outline-none hover:bg-[#ff5800]/10 focus-visible:ring-2 focus-visible:ring-[#ff5800]/35"
                onClick={() => {
                  setOrigin(null);
                  invalidateRouteOperation();
                }}
              >
                Clear
              </AgentButton>
            </div>
          ) : null}
        </header>

        {!isOnline ? (
          <div
            role="status"
            className="flex items-start gap-3 rounded-xl border border-[#ff5800]/30 bg-[#ff5800]/10 p-3 text-sm"
          >
            <WifiOff
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[#c54500]"
            />
            <div>
              <strong>Offline</strong>
              <p className="text-muted-foreground">
                {places.length
                  ? "Showing the last loaded places. New searches and routes are paused."
                  : "Reconnect to search places and plan routes."}
              </p>
            </div>
          </div>
        ) : null}

        <form
          aria-label="Search places"
          aria-hidden={chatSheetOpen ? true : undefined}
          onSubmit={submitSearch}
          className="grid gap-2 sm:grid-cols-6"
          style={{ visibility: chatSheetOpen ? "hidden" : undefined }}
        >
          <SearchControl
            value={query}
            invalid={validationError}
            busy={phase === "searching"}
            onValue={setQuery}
          />
          <SearchSubmitControl
            busy={phase === "searching"}
            disabled={Boolean(validationError)}
            onActivate={() => void runSearch(query)}
          />
        </form>
        {validationError ? (
          <p
            id="maps-search-error"
            role="alert"
            className="text-sm text-danger"
          >
            {validationError}
          </p>
        ) : null}

        {places.length ? (
          <fieldset className="flex gap-2 overflow-x-auto border-0 pb-1">
            <legend className="sr-only">Place filters</legend>
            {categories.map((value) => (
              <AgentButton
                key={value}
                id={`maps-filter-${agentIdPart(value)}`}
                label={`${value === "all" ? "All" : value} places`}
                description="Filter loaded place results"
                pressed={category === value}
                onClick={() => setCategory(value)}
                className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#ff5800]/35 ${
                  category === value
                    ? "border-[#ff5800] bg-[#ff5800] text-white hover:bg-[#d94b00]"
                    : "border-border bg-bg text-text hover:border-[#ff5800] hover:bg-[#ff5800]/8"
                }`}
              >
                {value}
              </AgentButton>
            ))}
          </fieldset>
        ) : null}

        <section className="grid min-h-[540px] flex-1 gap-4 lg:grid-cols-[minmax(320px,0.82fr)_minmax(480px,1.45fr)_minmax(300px,0.9fr)]">
          <div className="min-h-0 overflow-hidden rounded-xl bg-card lg:border lg:border-border">
            <div className="flex min-h-12 items-center justify-between border-b border-border px-4">
              <h2 className="text-sm font-semibold">Places</h2>
              <span
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                {phase === "searching"
                  ? "Searching…"
                  : `${filteredPlaces.length} result${filteredPlaces.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {phase === "searching" ? (
              <div role="status" className="space-y-3 p-4">
                <span className="sr-only">Loading place results</span>
                {LOADING_ROWS.map((key) => (
                  <div key={key} className="flex animate-pulse gap-3 py-2">
                    <div className="size-10 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2 pt-1">
                      <div className="h-3 w-2/3 rounded-md bg-muted" />
                      <div className="h-2.5 w-5/6 rounded-md bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : phase === "error" && !places.length ? (
              <div
                role="alert"
                className="grid min-h-56 place-items-center p-6 text-center"
              >
                <div className="max-w-sm">
                  <TriangleAlert
                    aria-hidden="true"
                    className="mx-auto size-7 text-[#c54500]"
                  />
                  <h2 className="mt-3 font-semibold">Places unavailable</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{error}</p>
                  <AgentButton
                    id="maps-retry-search"
                    label="Retry place search"
                    description="Retry the last submitted place search"
                    className={`${subtleButtonClass} mt-4`}
                    onClick={() => void runSearch(lastQuery || query)}
                  >
                    <RotateCcw aria-hidden="true" className="size-4" /> Retry
                  </AgentButton>
                </div>
              </div>
            ) : filteredPlaces.length ? (
              <div className="max-h-[460px] overflow-y-auto p-2 lg:h-[calc(100%-3rem)] lg:max-h-none">
                <ul className="space-y-1">
                  {filteredPlaces.map((place) => (
                    <li key={`${place.provider}:${place.providerPlaceId}`}>
                      <PlaceRow
                        place={place}
                        active={
                          selected?.providerPlaceId === place.providerPlaceId &&
                          selected.provider === place.provider
                        }
                        origin={
                          origin?.providerPlaceId === place.providerPlaceId &&
                          origin.provider === place.provider
                        }
                        onSelect={() => selectPlace(place)}
                      />
                    </li>
                  ))}
                </ul>
                {nextCursor && category === "all" ? (
                  <AgentButton
                    id="maps-load-more"
                    label="Load more places"
                    description="Load the next provider result page"
                    disabled={pageBusy || !isOnline}
                    onClick={() => void loadNextPage()}
                    className={`${subtleButtonClass} mt-2 w-full`}
                  >
                    {pageBusy ? "Loading more…" : "Load more"}
                  </AgentButton>
                ) : null}
                {error && places.length ? (
                  <p role="alert" className="mt-2 px-2 text-sm text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            ) : (
              <EmptyState
                filtered={Boolean(places.length)}
                onReset={() => setCategory("all")}
              />
            )}
          </div>

          <MapPanel
            places={filteredPlaces}
            attributionProviderIds={attributionProviderIds}
            providers={providers}
            selected={selected}
            activeRoute={activeRoute}
            onSelect={selectPlace}
          />

          <aside className="min-h-0 overflow-hidden rounded-xl bg-card lg:border lg:border-border">
            {selected ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-border p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#ff5800] text-white">
                      <MapPin aria-hidden="true" className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-bold tracking-wide text-[#c54500] uppercase">
                        Place details
                      </p>
                      <h2 className="mt-1 text-lg font-semibold leading-tight">
                        {selected.name}
                      </h2>
                      <p className="mt-1 text-sm leading-5 text-muted-foreground">
                        {selected.formattedAddress ?? "Address unavailable"}
                      </p>
                    </div>
                  </div>
                  {selected.categories.length ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {selected.categories.map((value) => (
                        <span
                          key={value}
                          className="rounded-full bg-muted px-2.5 py-1 text-xs capitalize text-muted-foreground"
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                  {routeError ? (
                    <div
                      role="alert"
                      className="rounded-lg bg-[#ff5800]/10 p-3 text-sm text-[#a93d00] dark:text-[#ff9b66]"
                    >
                      {routeError}
                    </div>
                  ) : null}

                  <div className="grid grid-cols-2 gap-2">
                    <AgentButton
                      id="maps-set-origin"
                      label={`Start at ${selected.name}`}
                      description="Use this place as the route origin"
                      onClick={() => {
                        setOrigin(selected);
                        invalidateRouteOperation();
                      }}
                    >
                      <LocateFixed aria-hidden="true" className="size-4" />{" "}
                      Start here
                    </AgentButton>
                    <AgentButton
                      id="maps-compare-routes"
                      label={`Compare routes to ${selected.name}`}
                      description="Request available provider-backed travel modes"
                      disabled={!origin || routeBusy}
                      onClick={() => void planRoutes()}
                      className={primaryClass}
                    >
                      <RouteIcon aria-hidden="true" className="size-4" />
                      {routeBusy ? "Planning" : "Routes"}
                    </AgentButton>
                  </div>

                  {routes.length ? (
                    <section aria-labelledby="maps-routes-title">
                      <div className="mb-2 flex items-center justify-between">
                        <h3
                          id="maps-routes-title"
                          className="text-sm font-semibold"
                        >
                          Route alternatives
                        </h3>
                        <span className="text-xs text-muted-foreground">
                          Provider: {routes[0]?.provider}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {routes.map((route) => (
                          <RouteChoice
                            key={route.routeId}
                            route={route}
                            active={activeRoute?.routeId === route.routeId}
                            onSelect={() => setActiveRouteId(route.routeId)}
                          />
                        ))}
                      </div>
                      {activeRoute?.warnings.length ? (
                        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                          {activeRoute.warnings.map((warning) => (
                            <li key={warning} className="flex gap-2">
                              <TriangleAlert
                                aria-hidden="true"
                                className="mt-0.5 size-3.5 shrink-0 text-[#c54500]"
                              />
                              {warning}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  ) : (
                    <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                      <Clock3
                        aria-hidden="true"
                        className="mr-2 inline size-4 text-[#c54500]"
                      />
                      Set a starting place, select a destination, then compare
                      available routes.
                    </div>
                  )}

                  <section aria-labelledby="maps-actions-title">
                    <h3
                      id="maps-actions-title"
                      className="mb-2 text-sm font-semibold"
                    >
                      Continue with Eliza
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      <AgentButton
                        id="maps-save-place"
                        label={`Save ${selected.name}`}
                        description="Hand off to receipt-enforced MAPS_SAVE"
                        onClick={() => handoff("MAPS_SAVE")}
                        className="inline-flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-bg px-2 text-xs font-medium outline-none hover:border-[#ff5800] hover:bg-[#ff5800]/8 focus-visible:ring-2 focus-visible:ring-[#ff5800]/35"
                      >
                        <Star
                          aria-hidden="true"
                          className="size-4 text-[#d94b00]"
                        />{" "}
                        Save
                      </AgentButton>
                      <AgentButton
                        id="maps-share-place"
                        label={`Share ${selected.name}`}
                        description="Hand off to MAPS_SHARE without opening an external app"
                        onClick={() => handoff("MAPS_SHARE")}
                        className="inline-flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-bg px-2 text-xs font-medium outline-none hover:border-[#ff5800] hover:bg-[#ff5800]/8 focus-visible:ring-2 focus-visible:ring-[#ff5800]/35"
                      >
                        <Share2
                          aria-hidden="true"
                          className="size-4 text-[#d94b00]"
                        />{" "}
                        Share
                      </AgentButton>
                      <AgentButton
                        id="maps-navigate-place"
                        label={`Navigate to ${selected.name}`}
                        description="Hand off to MAPS_NAVIGATE without claiming device launch"
                        onClick={() => handoff("MAPS_NAVIGATE")}
                        className="inline-flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg border border-border bg-bg px-2 text-xs font-medium outline-none hover:border-[#ff5800] hover:bg-[#ff5800]/8 focus-visible:ring-2 focus-visible:ring-[#ff5800]/35"
                      >
                        <Navigation
                          aria-hidden="true"
                          className="size-4 text-[#d94b00]"
                        />{" "}
                        Navigate
                      </AgentButton>
                    </div>
                  </section>
                </div>
              </div>
            ) : (
              <div className="grid min-h-64 place-items-center p-6 text-center">
                <div>
                  <MapIcon
                    aria-hidden="true"
                    className="mx-auto size-7 text-[#d94b00]"
                  />
                  <h2 className="mt-3 font-semibold">Choose a place</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Select a result or map marker to inspect details and
                    actions.
                  </p>
                </div>
              </div>
            )}
          </aside>
        </section>
      </div>
    </main>
  );
}

export default MapsView;
