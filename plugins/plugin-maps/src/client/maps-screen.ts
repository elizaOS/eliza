/**
 * The phone Maps screen as a framework-free controller: search, place detail,
 * saved places, directions with an explicit origin, foreground turn-by-turn
 * guidance, screen-off sessions, voice, sharing, cross-app hand-offs and the
 * agent's navigation surface. Hosts render `view()` in their own markup (or
 * the shared React view) and supply platform ports. Nothing here invents a
 * place, route, ETA or location: every value comes from the configured
 * provider, the user's explicit input or a fresh device fix.
 */
import {
  type Coordinate,
  coordinate,
  failure,
  MapsFailure,
  type MapsProvider,
  type Place,
  type ProviderConfig,
  type Route,
  type TravelMode,
} from "./contracts.ts";
import type {
  ActiveGuidance,
  MapsNavigationSurface,
} from "./device-navigation.ts";
import { atStep, guidanceView, maneuverIcon } from "./guidance.ts";
import type { MapsLocation, Position } from "./location.ts";
import type { MapOverlay } from "./map-plane.ts";
import { usableNavigationFix } from "./navigation-fix.ts";
import { distanceToRoute, routeProgress } from "./route-distance.ts";
import type { SavedPlace } from "./saved-places.ts";
import { type MapShare, placeShare, routeShare } from "./share.ts";
import type { MapsController, MapsState } from "./state.ts";

export type MapsScreenSelection = {
  label: string;
  coordinate: Coordinate;
  savedId?: string;
  providerId?: string;
  providerPlaceId?: string;
  origin: "manual" | "location" | "saved" | "provider";
  editingName?: boolean;
};

/** Region coverage of the connected provider. */
export type MapsScreenCoverage = Readonly<{
  /** Region names for notices, e.g. "Monaco". */
  name: string;
  contains(point: Coordinate): boolean;
  /** True when the map plane itself only covers these regions. */
  mapRestricted: boolean;
}>;

export interface MapsScreenVoice {
  readonly enabled: boolean;
  update(key: string, text: string): void;
  pause(): void;
  toggle(): void;
}

export interface MapsScreenBackground {
  active(): boolean;
  start(
    title: string,
    text: string,
    onStopped: (reason: string) => void,
  ): Promise<boolean>;
  update(title: string, text: string): void;
  stop(): Promise<void>;
}

export interface MapsScreenHost {
  /** The provider connection (plugin-maps runtime) and its changes. */
  connection(): { config: ProviderConfig; provider?: MapsProvider };
  onConnectionChange(listener: () => void): () => void;
  /** Starts the provider connection; an explicit search retries a failed one. */
  initialize(): Promise<void>;
  diagnostics(): { configured: boolean; error: string };
  coverage(): MapsScreenCoverage | undefined;
  /** Attribution of the connected provider, for the agent's selected-object read. */
  attribution(): string;
  /** The domain controller with the host's storage namespace and location bridge. */
  createController(
    config: ProviderConfig,
    provider?: MapsProvider,
  ): MapsController;
  /** Watch used by foreground guidance. */
  navigationLocation: MapsLocation;
  /** One-shot fixes for agent requests. */
  agentLocation: MapsLocation;
  /** Whether location is granted, without showing a permission prompt. */
  locationGranted(): Promise<boolean>;
  voice: MapsScreenVoice;
  background: MapsScreenBackground;
  share(
    data: MapShare,
    signal: AbortSignal,
  ): Promise<"shared" | "copied" | "closed">;
  /** Opens a validated provider website in the system browser surface. */
  openWebsite(url: URL): void;
  /** Whether the Maps screen is the visible, active view. */
  active(): boolean;
  /** Asks the host to render `view()` again. */
  invalidate(): void;
  toast(text: string): void;
  /** Withdraws a cross-app query that has not been consumed yet. */
  discardHandoff?(): void;
  /** Whether the shell can return to the app whose hand-off opened this search. */
  handoffReturn?(): boolean;
  /** Maps released its state; the host drops its map plane and other view resources. */
  released?(): void;
  /** Hands an event's location text to an installed maps app (no in-app provider). */
  mapsApp?: {
    available(): Promise<boolean>;
    open(text: string): Promise<{ opened: boolean; message?: string }>;
  };
  /** Clock for fix freshness; defaults to Date.now. */
  now?(): number;
  /** Copy for the location panel when access is denied. */
  deniedLocationHelp?: string;
  /** Publishes the selected place, route or search as the agent's context. */
  publishContext?(
    kind: "map-place" | "map-route" | "map-search",
    identity: object,
    revision: number,
    read?: () => Record<string, unknown>,
  ): void;
  clearContext?(): void;
}

export type MapsScreenMode =
  | "base"
  | "results"
  | "place"
  | "origin"
  | "directions"
  | "navigation";

export type MapsScreenResult = Readonly<{
  key: string;
  name: string;
  detail: string;
  saved: boolean;
}>;

export type MapsScreenModeChoice = Readonly<{
  mode: TravelMode;
  selected: boolean;
  available: boolean;
}>;

export interface MapsScreenView {
  mode: MapsScreenMode;
  revision: number;
  query: string;
  /** The search field's leading control: Back while a layer is open. */
  searchLead: "back" | "search";
  showSearch: boolean;
  status: {
    visible: boolean;
    text: string;
    /** Map state line shown under the status, when it differs. */
    mapText: string;
    controls: boolean;
    location: "loading" | "ready" | "denied" | "unavailable" | "not-set";
    map: "loading" | "ready" | "error" | "outside-coverage";
    locationLabel: string;
    locationBusy: boolean;
    locationDenied: boolean;
    locationHelp: string;
    mapRetry: boolean;
    mapsAppHandoff: boolean;
  };
  saved: readonly SavedPlace[];
  results: readonly MapsScreenResult[];
  hasResults: boolean;
  noResults: boolean;
  emptyQuery: boolean;
  place?: {
    name: string;
    meta: string;
    address: string;
    hours?: string;
    website?: string;
    canDirections: boolean;
    saved: boolean;
    editingName: boolean;
  };
  directions?: {
    name: string;
    originText: string;
    duration: string;
    meta: string;
    via: string;
    modes: readonly MapsScreenModeChoice[];
    routeReady: boolean;
  };
  navigation?: {
    arrived: boolean;
    distance: string;
    instruction: string;
    /** SVG path of the upcoming maneuver (24px stroke icon). */
    maneuverIcon: string;
    /** The maneuver after the upcoming one ("Then"). */
    following?: { icon: string; text: string };
    remainingTime: string;
    meta: string;
    remaining: string;
    offRoute: boolean;
    canReroute: boolean;
    background: boolean;
    voiceEnabled: boolean;
  };
  map: {
    /** Selected coordinate the plane centres on; absent outside a restricted map. */
    selected?: Coordinate;
    route: Route | null;
    overlay: MapOverlay;
  };
  diagnostics: Record<string, unknown>;
}

const MODES: readonly TravelMode[] = ["drive", "transit", "walk", "bicycle"];
const MODE_LABEL: Record<TravelMode, string> = {
  drive: "Drive",
  transit: "Transit",
  walk: "Walk",
  bicycle: "Bike",
};
const COORDINATES = /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/;
const coordLabel = (point: Coordinate) =>
  `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
const greatCircle = (a: Coordinate, b: Coordinate) => {
  const r = Math.PI / 180;
  const dlat = (a.latitude - b.latitude) * r;
  const dlon = (a.longitude - b.longitude) * r;
  return (
    6371000 *
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dlat / 2) ** 2 +
            Math.cos(a.latitude * r) *
              Math.cos(b.latitude * r) *
              Math.sin(dlon / 2) ** 2,
        ),
      ),
    )
  );
};

/** Owns one Maps screen; `dispose` releases every listener, watch and request. */
export class MapsScreenController {
  private controller?: MapsController;
  private state?: MapsState;
  private unsubscribe?: () => void;
  private selected?: MapsScreenSelection;
  private initialized = false;
  private initialization?: Promise<void>;
  private directions = false;
  private originText = "";
  private originMode = false;
  private navigating = false;
  private arrived = false;
  private navStep = 0;
  private navFix?: Position;
  private navRouteId = "";
  private follow = true;
  private offRoute = false;
  private rerouting = false;
  private rerouteCleared = false;
  private navSession = 0;
  private backgroundRunning = false;
  private query = "";
  private searching = false;
  private message = "";
  private disposed = false;
  private revision = 0;
  private locating = false;
  private searchIntent = 0;
  private eventQuery = "";
  private mapsAppAvailable?: boolean;
  private mapsAppReading = false;
  private mapsAppOpening = false;
  private mapState: "loading" | "ready" | "error" = "loading";
  private sharing?: { abort: AbortController; current: () => boolean };
  private readonly identities = new WeakMap<MapsScreenSelection, object>();
  private readonly searchIdentity = {};
  private readonly releaseListeners = new Set<() => void>();
  private readonly lifecycle = {
    releases: 0,
    hidden: 0,
    permissionHeld: 0,
    providerActivations: 0,
    lastRelease: "",
    backgroundNavigation: 0,
    backgroundStops: 0,
  };
  private readonly connectionChanged: () => void;

  constructor(private readonly host: MapsScreenHost) {
    this.connectionChanged = host.onConnectionChange(() => {
      const connection = host.connection();
      if (
        this.controller &&
        this.state?.provider.status === "unconfigured" &&
        connection.config.status === "configured"
      ) {
        this.lifecycle.providerActivations++;
        this.controller.activateProvider(
          connection.config,
          connection.provider,
        );
      } else this.release(false);
      this.invalidate();
    });
  }

  /** Releases everything this screen owns. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connectionChanged();
    this.release();
  }

  // ---- lifecycle ----------------------------------------------------------

  /** The host showed Maps; starts the provider connection once. */
  ensure(): MapsController {
    if (!this.initialized) {
      this.initialized = true;
      this.initialization = this.host.initialize().finally(() => {
        this.initialization = undefined;
        this.invalidate();
      });
    }
    if (this.controller) return this.controller;
    const connection = this.host.connection();
    const controller = this.host.createController(
      connection.config,
      connection.provider,
    );
    this.controller = controller;
    this.unsubscribe = controller.subscribe((next) => this.observe(next));
    return controller;
  }

  /** Leaving Maps, a hidden page or a provider switch: nothing keeps running. */
  release(cancelIntent = true): void {
    this.sharing?.abort.abort();
    this.sharing = undefined;
    this.host.voice.pause();
    for (const listener of [...this.releaseListeners]) listener();
    void this.host.agentLocation.stop().catch(() => {});
    this.lifecycle.releases++;
    this.lifecycle.lastRelease = cancelIntent
      ? "leave-or-background"
      : "provider-switch";
    this.message = "";
    if (cancelIntent) {
      ++this.searchIntent;
      this.host.discardHandoff?.();
      this.eventQuery = "";
      this.mapsAppAvailable = undefined;
    }
    this.mapState = "loading";
    this.host.released?.();
    this.directions = false;
    this.originMode = false;
    void this.stopGuidance().catch(() => {});
    this.host.clearContext?.();
    ++this.revision;
    this.locating = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const old = this.controller;
    this.controller = undefined;
    this.state = undefined;
    void old?.leave().catch((error) => {
      this.message = failure(error).message;
    });
    this.selected = undefined;
  }

  /** The page was hidden. Screen-off navigation and a pending permission prompt keep Maps. */
  hidden(): void {
    this.retireShare();
    this.lifecycle.hidden++;
    if (this.continuing()) {
      this.lifecycle.backgroundNavigation++;
      this.invalidate();
      return;
    }
    if (
      this.controller?.awaitingLocationPermission() ||
      this.host.navigationLocation.awaitingPermission()
    ) {
      this.lifecycle.permissionHeld++;
      this.invalidate();
      return;
    }
    this.release();
  }

  /** Another surface took over (Home, an incoming call); shared and spoken output stop. */
  retireShare(): void {
    this.sharing?.abort.abort();
    this.sharing = undefined;
    if (!this.continuing()) this.host.voice.pause();
  }

  /** A host notice for the status line (e.g. voice or settings failures). */
  notify(text: string): void {
    this.message = text;
    this.invalidate();
  }

  /** Re-publishes the selection context and asks the host to render. */
  refresh(): void {
    this.invalidate();
  }

  /** Whether a navigation session is active (Start to End). */
  isNavigating(): boolean {
    return this.navigating;
  }

  /** The map plane reported its state; presentation only. */
  setMapState(state: "loading" | "ready" | "error"): void {
    if (this.mapState === state) return;
    this.mapState = state;
    this.invalidate(false);
  }

  /** The user asked to retry a failed map; a failed connection is retried too. */
  retryMap(): void {
    if (!this.usable()) return;
    this.mapState = "loading";
    this.message = "";
    if (this.host.diagnostics().error && !this.initialization)
      this.initialization = this.host.initialize().finally(() => {
        this.initialization = undefined;
        this.invalidate();
      });
    this.invalidate();
  }

  // ---- search ---------------------------------------------------------------

  /** Another app opened Maps with a one-use search (e.g. an event's location). */
  handoff(text: string, fromEvent: boolean): void {
    if (!text.trim()) return;
    this.release();
    this.query = text.trim();
    this.eventQuery = fromEvent ? this.query : "";
    this.submit();
    this.invalidate();
  }

  setQuery(text: string): void {
    if (this.choosingOrigin()) {
      this.editOrigin(text);
      return;
    }
    this.host.discardHandoff?.();
    ++this.searchIntent;
    this.query = text;
    this.selected = undefined;
    this.searching = true;
    this.message = "";
    void this.ensure().search("");
    this.invalidate();
  }

  focusQuery(): void {
    if (this.choosingOrigin() || this.searching) return;
    this.selected = undefined;
    this.searching = true;
    this.invalidate();
  }

  clearQuery(): void {
    if (this.choosingOrigin()) {
      this.editOrigin("");
      return;
    }
    ++this.searchIntent;
    this.query = "";
    this.selected = undefined;
    this.searching = true;
    this.message = "";
    void this.ensure().search("");
    this.invalidate();
  }

  /** The search field's leading control. */
  searchLead(): void {
    if (this.choosingOrigin()) {
      this.back();
      return;
    }
    if (!this.back()) {
      this.searching = true;
      this.invalidate();
    }
  }

  /** Enter in the search field: coordinates drop a pin; other text searches the provider. */
  submit(): void {
    if (this.choosingOrigin()) {
      this.planOrigin();
      return;
    }
    this.host.discardHandoff?.();
    const intent = ++this.searchIntent;
    this.selected = undefined;
    this.searching = true;
    this.message = "";
    const match = this.query.trim().match(COORDINATES);
    if (match) {
      try {
        const point = coordinate({
          latitude: Number(match[1]),
          longitude: Number(match[2]),
        });
        this.selected = {
          label: "Dropped pin",
          coordinate: point,
          origin: "manual",
        };
        this.searching = false;
      } catch (error) {
        this.message = failure(error).message;
      }
      this.invalidate();
      return;
    }
    // A new explicit search also retries a failed configured connection. Never
    // poll in the background or replay the search after the user leaves or edits.
    const requested = this.query;
    void (async () => {
      this.ensure();
      const diagnostics = this.host.diagnostics();
      if (!this.initialization && diagnostics.configured && diagnostics.error) {
        this.message = "Connecting Maps…";
        this.invalidate();
        this.initialization = this.host.initialize().finally(() => {
          this.initialization = undefined;
          this.invalidate();
        });
      }
      await this.initialization;
      if (
        this.disposed ||
        intent !== this.searchIntent ||
        !this.host.active() ||
        this.query !== requested
      )
        return;
      this.message = "";
      void this.ensure().search(requested);
    })();
  }

  /** A quick category search (e.g. a chip). */
  searchFor(text: string): void {
    this.query = text;
    this.submit();
  }

  /** Back through Maps layers; false when Maps has nothing open (the shell decides). */
  back(): boolean {
    this.host.discardHandoff?.();
    ++this.searchIntent;
    if (this.originMode) {
      this.originMode = false;
      this.ensure().cancelOriginSearch();
      this.message = "";
      this.invalidate();
      return true;
    }
    if (this.directions || this.navigating) {
      this.directions = false;
      void this.stopGuidance().catch(() => {});
      this.message = "";
      this.invalidate();
      return true;
    }
    if (this.selected) {
      this.selected = undefined;
      this.message = "";
      this.invalidate();
      return true;
    }
    if (this.searching || this.query) {
      // The search an event's location opened is the cross-app hand-off, not a Maps
      // layer the user made: Back clears it and lets the shell return to that event.
      const handoff =
        !!this.eventQuery &&
        this.query === this.eventQuery &&
        !!this.host.handoffReturn?.();
      this.searching = false;
      this.query = "";
      this.message = "";
      if (handoff) this.eventQuery = "";
      void this.ensure().search("");
      this.invalidate();
      return !handoff;
    }
    return false;
  }

  /** Unwinds every Maps layer, as system Back would, before leaving for another app. */
  unwind(): void {
    for (let layer = 0; layer < 8 && this.back(); layer++);
  }

  /** Whether the open search is the event hand-off (the host may offer a way back). */
  showingEventHandoff(): boolean {
    return !!this.eventQuery && this.query === this.eventQuery;
  }

  // ---- places ---------------------------------------------------------------

  /** A result row or map pin; while choosing an origin it becomes the origin. */
  choose(key: string): void {
    const snapshot = this.state;
    if (!snapshot) return;
    if (this.choosingOrigin()) {
      const saved = this.ensure()
        .savedMatches(this.originText)
        .find((item) => `saved:${item.id}` === key);
      const found =
        saved ??
        snapshot.originSearch.value.find(
          (item) => `place:${item.providerId}:${item.id}` === key,
        );
      if (found) this.chooseOrigin(found);
      return;
    }
    const place = snapshot.search.value.find(
      (item) => `place:${item.providerId}:${item.id}` === key,
    );
    if (place) this.showPlace(place);
  }

  /** A saved place from a chip or the saved list. */
  chooseSaved(id: string): void {
    const saved = this.state?.saved.value.find((item) => item.id === id);
    if (!saved) return;
    this.host.discardHandoff?.();
    this.selected = {
      label: saved.label,
      coordinate: saved.coordinate,
      savedId: saved.id,
      providerId: saved.providerId,
      providerPlaceId: saved.providerPlaceId,
      origin: "saved",
    };
    this.searching = false;
    this.message = "";
    this.invalidate();
  }

  /** A map pin tap. */
  pin(id: string): void {
    const pinned = this.choosingOrigin()
      ? this.state?.originSearch.value
      : this.state?.search.value;
    const item = pinned?.find((value) => value.id === id);
    if (item) this.choose(`place:${item.providerId}:${item.id}`);
  }

  closePlace(): void {
    this.selected = undefined;
    this.message = "";
    this.invalidate();
  }

  /** Save or remove the selected place on this device. */
  toggleSaved(): void {
    const selected = this.selected;
    if (!selected) return;
    try {
      const existing = this.savedFor(selected);
      if (existing) {
        this.ensure().removeSaved(existing.id);
        selected.savedId = undefined;
        this.message = "Place removed from saved.";
      } else {
        const saved = this.ensure().save({
          label: selected.label,
          coordinate: selected.coordinate,
          providerId: selected.providerId,
          providerPlaceId: selected.providerPlaceId,
        });
        selected.savedId = saved.id;
        this.message = "Place saved on this device.";
      }
    } catch (error) {
      this.message = failure(error).message;
    }
    this.invalidate();
  }

  startRename(): void {
    if (!this.selected) return;
    this.selected.editingName = true;
    this.invalidate();
  }

  rename(text: string): void {
    if (!this.selected) return;
    this.selected.label = text.slice(0, 300);
    this.invalidate();
  }

  applyName(): void {
    const selected = this.selected;
    if (!selected) return;
    const existing = this.savedFor(selected);
    try {
      if (existing) this.ensure().renameSaved(existing.id, selected.label);
      else if (!selected.label.trim()) throw new Error("empty");
      selected.editingName = false;
      this.message = existing
        ? "Saved place renamed."
        : "Name updated. Tap Save to keep this place.";
    } catch {
      this.message = "The place name could not be saved.";
    }
    this.invalidate();
  }

  /** Opens the provider website only on an explicit tap. */
  openWebsite(): void {
    const raw = this.detail()?.website;
    if (!raw) return;
    let url: URL;
    try {
      url = new URL(raw);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("invalid");
    } catch {
      this.host.toast("This website address is not valid.");
      return;
    }
    this.host.openWebsite(url);
  }

  sharePlace(): void {
    const item = this.selected;
    if (!item) return;
    this.share(
      placeShare(item.label, item.coordinate),
      () => !this.disposed && this.host.active() && this.selected === item,
    );
  }

  // ---- location -------------------------------------------------------------

  /** An explicit location request; the platform may show its permission prompt. */
  locate(): void {
    if (this.disposed || this.locating || !this.host.active()) return;
    this.host.discardHandoff?.();
    this.message = "";
    this.locating = true;
    if (!this.directions) this.selected = undefined;
    this.searching = false;
    void this.ensure().locate();
    this.invalidate();
  }

  /** Recenter: follow the device during navigation, otherwise a new location request. */
  recenter(): void {
    if (this.navigating) {
      this.follow = true;
      this.invalidate();
    } else this.locate();
  }

  /** Manual location: Maps clears and asks for coordinates in the search field. */
  manualLocation(): void {
    if (this.disposed || !this.host.active()) return;
    this.release();
    this.query = "";
    this.searching = false;
    this.message = "Enter latitude, longitude in Search, then press Enter.";
    this.invalidate();
  }

  /** The user moved the map during navigation; the camera stops following. */
  stopFollowing(): void {
    if (!this.navigating || !this.follow) return;
    this.follow = false;
    this.invalidate(false);
  }

  // ---- directions -----------------------------------------------------------

  /** Directions for the selected place; the origin stays explicit. */
  openDirections(): void {
    const item = this.selected;
    const snapshot = this.state;
    if (!item || !snapshot) return;
    if (snapshot.provider.status === "unconfigured") {
      this.message =
        "Connect a Maps provider to plan a route. No route has been calculated.";
    } else {
      this.directions = true;
      this.message =
        "Enter an origin latitude, longitude and press Enter, or explicitly use current location.";
      if (
        item.origin !== "provider" &&
        snapshot.provider.status === "configured"
      )
        void this.ensure().select(
          {
            providerId: snapshot.provider.providerId,
            id: item.providerPlaceId || "manual",
            name: item.label,
            coordinate: item.coordinate,
            attribution: "User-selected coordinates",
            fetchedAt: Date.now(),
          },
          false,
        );
    }
    this.invalidate();
  }

  /** Typing in the origin field clears the previous route. */
  setOriginText(text: string): void {
    this.originMode = false;
    this.editOrigin(text);
  }

  /** Enter in the origin field: coordinates plan directly; other text searches places. */
  planOrigin(): void {
    const selected = this.selected;
    if (!selected) return;
    const text = this.originText.trim();
    const match = text.match(COORDINATES);
    if (match) {
      try {
        this.ensure().setOrigin(
          coordinate({
            latitude: Number(match[1]),
            longitude: Number(match[2]),
          }),
        );
        this.message = "";
        this.originMode = false;
        void this.ensure().planRoute();
      } catch {
        this.message = "Enter origin latitude, longitude.";
      }
      this.invalidate();
      return;
    }
    if (!text) {
      this.message =
        "Enter a starting place, a saved place or latitude, longitude.";
      this.invalidate();
      return;
    }
    const configured = this.state?.provider.status === "configured";
    if (!configured && !this.ensure().savedMatches(text).length) {
      this.message = "Enter origin latitude, longitude.";
      this.invalidate();
      return;
    }
    this.originMode = true;
    this.message = `Choose a starting point for the route to ${selected.label}.`;
    if (configured) void this.ensure().searchOrigin(text);
    this.invalidate();
  }

  setMode(mode: TravelMode): void {
    const controller = this.ensure();
    if (!controller.capabilities().modes.includes(mode)) {
      this.message =
        mode === "transit"
          ? "Transit schedules are not available for this region."
          : `${MODE_LABEL[mode]} directions are not available from this Maps provider.`;
      this.invalidate();
      return;
    }
    controller.setMode(mode);
    this.message = "";
    if (this.state?.origin) void controller.planRoute();
  }

  shareRoute(): void {
    const target = this.selected;
    const route = this.readyRoute();
    if (!target || !route) return;
    this.share(
      routeShare(target.label, route),
      () =>
        !this.disposed &&
        this.host.active() &&
        this.selected === target &&
        this.directions &&
        this.state?.route.phase === "ready" &&
        this.state.route.value === route,
    );
  }

  // ---- navigation -----------------------------------------------------------

  /** The user's Start: foreground guidance from fresh fixes, screen-off where supported. */
  start(): void {
    const route = this.readyRoute();
    const selected = this.selected;
    if (!route || !selected) {
      this.message = "Calculate a route before starting navigation.";
      this.invalidate();
      return;
    }
    this.host.voice.pause();
    this.arrived = false;
    this.navigating = true;
    this.follow = true;
    this.navStep = 0;
    this.offRoute = false;
    this.rerouting = false;
    this.navFix = undefined;
    this.navRouteId = route.id;
    this.backgroundRunning = false;
    const session = ++this.navSession;
    this.message =
      "Waiting for a fresh location fix. Foreground guidance only.";
    void this.host.background
      .start(`Route to ${selected.label}`, "Waiting for location", (reason) => {
        if (session !== this.navSession || !this.navigating) return;
        this.lifecycle.backgroundStops++;
        // Only the notification's Stop is the user ending navigation. A refused or
        // system-ended service drops back to foreground-only guidance.
        if (reason === "notification") {
          this.message = "Navigation stopped from the notification.";
          this.end();
          return;
        }
        this.backgroundRunning = false;
        this.message =
          "Screen-off guidance is unavailable. Foreground guidance only.";
        if (!this.host.active()) this.release();
        else this.invalidate();
      })
      .then((running) => {
        if (session !== this.navSession || !this.navigating) {
          if (running) void this.host.background.stop();
          return;
        }
        this.backgroundRunning = running;
        if (running && !this.navFix)
          this.message =
            "Waiting for a fresh location fix. Guidance continues with the screen off.";
        this.invalidate();
      });
    void this.host.navigationLocation.start(
      false,
      (fix) => this.onFix(fix),
      (error) => {
        if (session !== this.navSession) return;
        this.message = failure(error).message;
        void this.stopGuidance().catch(() => {});
        this.invalidate();
      },
    );
    this.invalidate();
  }

  /** End navigation (the user's End, or the notification's Stop). */
  end(): void {
    void this.stopGuidance().catch((error) => {
      this.message = failure(error).message;
      this.invalidate();
    });
    this.invalidate();
  }

  /** "Reroute from here" from the current fresh, precise fix. */
  reroute(): void {
    const from = this.navFix?.coordinate;
    if (from) void this.rerouteFrom(from);
  }

  toggleVoice(): void {
    this.host.voice.toggle();
    this.invalidate();
  }

  // ---- maps app hand-off ----------------------------------------------------

  openInMapsApp(): void {
    const text = this.mapsAppText();
    const port = this.host.mapsApp;
    if (!text || !port || this.mapsAppOpening || !this.usable()) return;
    this.mapsAppOpening = true;
    void port
      .open(text)
      .then(
        (result) => {
          this.message = result.opened
            ? "Opened in your maps app. Review the place there."
            : result.message || "No installed app can complete this action.";
        },
        () => {
          this.message = "No installed app can complete this action.";
        },
      )
      .finally(() => {
        this.mapsAppOpening = false;
        this.invalidate();
      });
  }

  // ---- agent ----------------------------------------------------------------

  /** The agent's navigation surface over this screen; `present` is the host's own check. */
  surface(present: () => Promise<boolean>): MapsNavigationSurface {
    return {
      present,
      snapshot: () => this.state,
      showPlace: (place, resolveDetails) => {
        this.host.discardHandoff?.();
        ++this.searchIntent;
        this.directions = false;
        this.originMode = false;
        this.searching = false;
        this.locating = false;
        this.message = "";
        return this.showAgentPlace(place, resolveDetails);
      },
      showDirections: (place, travelMode, resolveDetails) => {
        this.host.discardHandoff?.();
        ++this.searchIntent;
        this.originMode = false;
        this.searching = false;
        this.locating = false;
        this.originText = "";
        const controller = this.ensure();
        controller.clearOrigin();
        controller.setMode(travelMode);
        this.directions = true;
        this.message =
          "Your agent asked for directions. Use current location or enter an origin to plan the route, then tap Start.";
        return this.showAgentPlace(place, resolveDetails);
      },
      locationGranted: () => this.host.locationGranted(),
      locate: async (signal) => {
        // Checked again right before the watch starts: an agent request never prompts.
        if (!(await this.host.locationGranted()))
          throw new MapsFailure(
            "permission-denied",
            "Location is not granted.",
          );
        return new Promise<Position>((resolve, reject) => {
          const finish = () => {
            signal.removeEventListener("abort", abort);
            void this.host.agentLocation.stop().catch(() => {});
          };
          const abort = () => {
            finish();
            reject(new MapsFailure("cancelled", "Location request cancelled."));
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          this.host.agentLocation
            .start(
              true,
              (fix) => {
                finish();
                resolve(fix);
              },
              (error) => {
                finish();
                reject(error);
              },
            )
            .catch((error) => {
              finish();
              reject(error);
            });
        });
      },
      planFrom: (origin) => {
        const controller = this.ensure();
        this.originMode = false;
        this.originText = coordLabel(origin);
        controller.setOrigin(origin);
        this.message = "";
        const pending = controller.planRoute();
        this.invalidate();
        return pending;
      },
      // The session lasts from Start to End, including while rerouting and after arrival.
      guidance: (): ActiveGuidance | null =>
        this.navigating && this.selected && this.state
          ? {
              routeId: this.navRouteId,
              placeName: this.selected.label,
              travelMode: this.state.mode,
              rerouting: this.rerouting,
              arrived: this.arrived,
              ...(this.navFix ? { fix: this.navFix } : {}),
            }
          : null,
      reroute: (from) =>
        this.rerouteFrom(from) ??
        Promise.reject(
          new MapsFailure(
            "unavailable",
            "The phone is already planning a new route.",
          ),
        ),
      stop: () => {
        const active = this.navigating;
        const pending = this.stopGuidance();
        if (active && this.host.active()) this.message = "Navigation stopped.";
        this.invalidate();
        return pending;
      },
      onRelease: (listener) => {
        this.releaseListeners.add(listener);
        return () => {
          this.releaseListeners.delete(listener);
        };
      },
    };
  }

  // ---- presentation ---------------------------------------------------------

  /** Everything a host renders, recomputed from current state. */
  view(): MapsScreenView {
    const controller = this.ensure();
    const snapshot = this.state ?? controller.snapshot();
    const saved = snapshot.saved.value;
    const selected = this.selected;
    const choosingOrigin = this.choosingOrigin();
    const error =
      snapshot.saved.error ||
      snapshot.position.error ||
      (choosingOrigin ? snapshot.originSearch.error : snapshot.search.error) ||
      snapshot.route.error;
    const pending =
      this.locating ||
      (choosingOrigin
        ? snapshot.originSearch.phase === "loading"
        : snapshot.search.phase === "loading");
    const coverage = this.host.coverage();
    const point = selected?.coordinate;
    const outsideCoverage = !!point && !!coverage && !coverage.contains(point);
    const locationState: MapsScreenView["status"]["location"] = this.locating
      ? "loading"
      : snapshot.position.phase === "ready" || selected
        ? "ready"
        : snapshot.position.error?.code === "permission-denied"
          ? "denied"
          : snapshot.position.phase === "error"
            ? "unavailable"
            : "not-set";
    const mapState: MapsScreenView["status"]["map"] =
      this.mapState === "error"
        ? "error"
        : coverage?.mapRestricted && outsideCoverage
          ? "outside-coverage"
          : this.mapState;
    const mapText =
      this.mapState === "error"
        ? "Map rendering is unavailable. Retry the map, or use coordinates and saved places."
        : outsideCoverage
          ? `This location is outside ${coverage?.name ?? ""} ${coverage?.mapRestricted ? "map" : "search and route"} coverage. Its coordinates are retained.`
          : mapState === "loading"
            ? "Loading map…"
            : !coverage?.mapRestricted
              ? locationState === "ready"
                ? "Location added"
                : "Add a location"
              : coverage?.name || "Connected Maps";
    const status =
      (choosingOrigin &&
      !snapshot.originSearch.error &&
      snapshot.originSearch.phase !== "loading"
        ? this.message
        : "") ||
      snapshot.route.error?.message ||
      this.message ||
      error?.message ||
      (pending ? "Finding location…" : mapText);
    const isPlace = !!selected && !this.directions && !this.navigating;
    const isResults =
      (this.searching && !isPlace && !this.directions && !this.navigating) ||
      choosingOrigin;
    const isDirections = this.directions && !this.navigating && !choosingOrigin;
    const mode: MapsScreenMode = this.navigating
      ? "navigation"
      : choosingOrigin
        ? "origin"
        : isDirections
          ? "directions"
          : isPlace
            ? "place"
            : isResults
              ? "results"
              : "base";
    const pinned: readonly Place[] = choosingOrigin
      ? snapshot.originSearch.value
      : isResults
        ? snapshot.search.value
        : [];
    const fix = this.navigating
      ? this.navFix
      : snapshot.position.phase === "ready"
        ? snapshot.position.value || undefined
        : undefined;
    const savedOrigins = choosingOrigin
      ? controller.savedMatches(this.originText)
      : [];
    const results: MapsScreenResult[] = choosingOrigin
      ? [
          ...savedOrigins.map((item) => ({
            key: `saved:${item.id}`,
            name: item.label,
            detail: `Saved place · ${coordLabel(item.coordinate)}`,
            saved: true,
          })),
          ...snapshot.originSearch.value.map((item) => ({
            key: `place:${item.providerId}:${item.id}`,
            name: item.name,
            detail: item.address || coordLabel(item.coordinate),
            saved: false,
          })),
        ]
      : snapshot.search.value.map((item) => ({
          key: `place:${item.providerId}:${item.id}`,
          name: item.name,
          detail: item.address || coordLabel(item.coordinate),
          saved: false,
        }));
    const mapsAppText = this.mapsAppText();
    if (mapsAppText) this.readMapsApp();
    const view: MapsScreenView = {
      mode,
      revision: this.revision,
      query: choosingOrigin ? this.originText : this.query,
      searchLead:
        isPlace || this.searching || choosingOrigin ? "back" : "search",
      showSearch: (!this.directions && !this.navigating) || choosingOrigin,
      status: {
        visible:
          !isPlace ||
          !!(
            this.mapState === "error" ||
            outsideCoverage ||
            snapshot.route.error ||
            error ||
            this.message
          ),
        text: status,
        mapText: status === mapText ? "" : mapText,
        controls: !this.searching && !this.directions && !this.navigating,
        location: locationState,
        map: mapState,
        locationLabel: this.locating
          ? "Finding location…"
          : locationState === "ready"
            ? "Use current location"
            : "Add location",
        locationBusy: this.locating,
        locationDenied: locationState === "denied",
        locationHelp:
          locationState === "denied"
            ? this.host.deniedLocationHelp ||
              "Allow location in settings, or enter coordinates."
            : "Location access does not share it with your agent.",
        mapRetry: this.mapState === "error",
        mapsAppHandoff: !!mapsAppText && this.mapsAppAvailable === true,
      },
      saved,
      results,
      hasResults: results.length > 0,
      noResults: choosingOrigin
        ? snapshot.originSearch.phase === "empty" && !savedOrigins.length
        : snapshot.search.phase === "empty",
      emptyQuery: !choosingOrigin && !this.query.trim(),
      map: {
        ...(coverage?.mapRestricted && outsideCoverage
          ? {}
          : selected
            ? { selected: selected.coordinate }
            : {}),
        route: snapshot.route.value,
        overlay: {
          pins: pinned.map((item) => ({
            id: item.id,
            label: item.name,
            coordinate: item.coordinate,
          })),
          position: fix
            ? {
                coordinate: fix.coordinate,
                accuracyMeters: fix.accuracyMeters,
                headingDegrees: fix.headingDegrees,
              }
            : null,
          follow: this.navigating && this.follow && !!this.navFix,
        },
      },
      diagnostics: {
        ...this.host.diagnostics(),
        lifecycle: {
          ...this.lifecycle,
          locating: this.locating,
          permissionPending:
            controller.awaitingLocationPermission() ||
            this.host.navigationLocation.awaitingPermission(),
          position: snapshot.position.phase,
        },
      },
    };
    if (selected) {
      const existing = this.savedFor(selected);
      const detail = this.detail();
      view.place = {
        name: selected.label,
        meta:
          (selected.origin === "saved"
            ? "Saved on this device"
            : selected.origin === "location"
              ? "Device location"
              : "Coordinates") +
          (detail?.phone ? ` · Phone ${detail.phone}` : ""),
        address: detail?.address || coordLabel(selected.coordinate),
        ...(detail?.openingHours ? { hours: detail.openingHours } : {}),
        ...(detail?.website ? { website: detail.website } : {}),
        canDirections: controller.capabilities().modes.length > 0,
        saved: !!existing,
        editingName: !!selected.editingName,
      };
    }
    if (this.directions && selected) {
      const route = snapshot.route.value;
      const modes = controller.capabilities().modes;
      view.directions = {
        name: selected.label,
        originText: this.originText,
        duration: route
          ? `${Math.max(1, Math.round(route.durationSeconds / 60))} min`
          : snapshot.route.phase === "loading"
            ? "Planning…"
            : "No route",
        meta: route
          ? `${(route.distanceMeters / 1000).toFixed(1)} km · no live traffic`
          : "Regional route",
        via: route
          ? (snapshot.originLabel ? `From ${snapshot.originLabel} · ` : "") +
            (route.steps[0]?.instruction || "")
          : "Choose a real origin to calculate a route.",
        modes: MODES.map((choice) => ({
          mode: choice,
          selected: snapshot.mode === choice,
          available: modes.includes(choice),
        })),
        routeReady: snapshot.route.phase === "ready" && !!route,
      };
    }
    if (this.navigating && selected) {
      const route = this.readyRoute();
      const progress =
        this.navFix && route && !this.arrived && !this.rerouting
          ? atStep(
              routeProgress(this.navFix.coordinate, route),
              route.steps,
              this.navStep,
            )
          : undefined;
      const guidance = progress ? guidanceView(progress) : undefined;
      view.navigation = {
        arrived: this.arrived,
        distance: this.arrived
          ? "Arrived"
          : guidance
            ? guidance.distance
            : this.rerouting
              ? "Rerouting…"
              : "Locating…",
        instruction: this.arrived
          ? selected.label
          : guidance
            ? guidance.instruction
            : this.rerouting
              ? "Planning a new route from here"
              : "Waiting for location",
        maneuverIcon: guidance?.icon || maneuverIcon("arrive"),
        ...(guidance?.hasThen
          ? { following: { icon: guidance.thenIcon, text: guidance.thenText } }
          : {}),
        remainingTime: this.arrived
          ? "Arrived"
          : guidance
            ? guidance.remainingTime
            : "Guidance",
        meta: this.arrived
          ? "Destination reached"
          : guidance
            ? guidance.remaining
            : this.backgroundRunning
              ? "Continues with the screen off"
              : "Foreground guidance",
        remaining: guidance?.remaining || "",
        offRoute: this.offRoute,
        canReroute:
          this.offRoute &&
          usableNavigationFix(this.navFix, this.now()) &&
          !this.rerouting,
        background: this.backgroundRunning,
        voiceEnabled: this.host.voice.enabled,
      };
    }
    return view;
  }

  // ---- internals ------------------------------------------------------------

  private observe(next: MapsState): void {
    if (this.navigating && this.rerouting) {
      // An explicit reroute keeps the session; only a route planned after the
      // reroute request cleared the old one replaces it.
      if (next.route.phase !== "ready" && next.route.phase !== "error")
        this.rerouteCleared = true;
      else if (
        next.route.phase === "ready" &&
        next.route.value &&
        this.rerouteCleared
      ) {
        this.rerouting = false;
        this.navStep = 0;
        this.navRouteId = next.route.value.id;
        this.host.voice.pause();
        this.message = "New route ready.";
      } else if (next.route.phase === "error")
        void this.stopGuidance().catch(() => {});
    } else if (
      this.navigating &&
      (next.route.phase !== "ready" || next.route.value?.id !== this.navRouteId)
    )
      void this.stopGuidance().catch(() => {});
    this.state = next;
    if (
      this.locating &&
      next.position.phase === "ready" &&
      next.position.value
    ) {
      const position = next.position.value;
      this.locating = false;
      if (!this.directions)
        this.selected = {
          label: "Current location",
          coordinate: position.coordinate,
          origin: "location",
        };
      else {
        this.originText = coordLabel(position.coordinate);
        void this.controller?.planRoute();
      }
      this.searching = false;
      this.message = `${position.precision === "approximate" ? "Approximate location" : "Location fix"} · accuracy ±${Math.ceil(position.accuracyMeters)} m`;
    } else if (this.locating && next.position.phase === "error") {
      this.locating = false;
      this.message = next.position.error?.message || "Location unavailable.";
    }
    this.invalidate();
  }

  private onFix(fix: Position): void {
    if (!this.navigating) return;
    const current =
      this.state?.route.phase === "ready" ? this.state.route.value : null;
    if (!usableNavigationFix(fix, this.now())) {
      this.navFix = undefined;
      this.host.voice.pause();
      this.message =
        "A fresh, precise location fix is needed for turn guidance.";
      this.invalidate();
      return;
    }
    if (this.rerouting || !current) {
      this.navFix = fix;
      this.invalidate();
      return;
    }
    if (current.id !== this.navRouteId) {
      void this.stopGuidance().catch(() => {});
      this.invalidate();
      return;
    }
    this.navFix = fix;
    this.arrived =
      greatCircle(fix.coordinate, current.to) < 25 && fix.accuracyMeters <= 30;
    if (this.arrived) {
      this.host.voice.pause();
      this.message = "Destination reached.";
      this.offRoute = false;
      void this.host.navigationLocation.stop();
      void this.host.background.stop();
      this.backgroundRunning = false;
    } else {
      const nearest = distanceToRoute(fix.coordinate, current.geometry);
      this.offRoute = nearest > Math.max(75, fix.accuracyMeters * 2);
      // A maneuver is passed once a fix comes within 40 m of it.
      while (
        this.navStep < current.steps.length - 1 &&
        greatCircle(fix.coordinate, current.steps[this.navStep].coordinate) < 40
      )
        this.navStep++;
      const reading = atStep(
        routeProgress(fix.coordinate, current),
        current.steps,
        this.navStep,
      );
      const guidance = guidanceView(reading);
      this.message = this.offRoute
        ? "Off route. Stop and calculate a new route."
        : `Foreground guidance · location accuracy ±${Math.ceil(fix.accuracyMeters)} m${this.backgroundRunning ? " · continues with the screen off" : ""}`;
      if (this.offRoute) {
        this.host.voice.pause();
        this.host.background.update(
          "Off route",
          "Open Maps to reroute from here or stop.",
        );
      } else {
        if (reading.next)
          this.host.voice.update(
            `${current.id}:${reading.next.index}`,
            guidance.spoken,
          );
        this.host.background.update(
          guidance.notificationTitle,
          guidance.notificationText,
        );
      }
    }
    this.invalidate();
  }

  private rerouteFrom(from: Coordinate): Promise<void> | undefined {
    if (!this.navigating || this.rerouting) return undefined;
    if (!usableNavigationFix(this.navFix, this.now())) {
      this.message =
        "A fresh, precise location fix is needed to reroute. The current route was kept.";
      this.host.voice.pause();
      this.invalidate();
      return undefined;
    }
    this.rerouting = true;
    this.rerouteCleared = false;
    this.offRoute = false;
    this.host.voice.pause();
    this.originText = coordLabel(from);
    this.message = "Planning a new route from here…";
    const pending = this.ensure().reroute(from);
    this.invalidate();
    return pending;
  }

  private stopGuidance(): Promise<void> {
    this.host.voice.pause();
    this.navigating = false;
    this.rerouting = false;
    this.offRoute = false;
    this.navFix = undefined;
    this.navRouteId = "";
    this.backgroundRunning = false;
    ++this.navSession;
    void this.host.background.stop();
    return this.host.navigationLocation.stop();
  }

  private async showAgentPlace(
    place: Place,
    resolveDetails: boolean,
  ): Promise<void> {
    const item: MapsScreenSelection = {
      label: place.name,
      coordinate: place.coordinate,
      providerId: place.providerId,
      ...(resolveDetails ? { providerPlaceId: place.id } : {}),
      origin: resolveDetails ? "provider" : "manual",
    };
    this.selected = item;
    const pending = this.ensure().select(place, resolveDetails);
    this.invalidate();
    await pending;
    const detail =
      this.state?.selection.phase === "ready"
        ? this.state.selection.value
        : null;
    if (
      this.selected === item &&
      detail &&
      detail.id === place.id &&
      detail.providerId === place.providerId
    ) {
      item.label = detail.name;
      item.coordinate = detail.coordinate;
      this.invalidate();
    }
  }

  private showPlace(place: Place): void {
    this.selected = {
      label: place.name,
      coordinate: place.coordinate,
      providerId: place.providerId,
      providerPlaceId: place.id,
      origin: "provider",
    };
    this.searching = false;
    this.message = "";
    void this.ensure().select(place);
    this.invalidate();
  }

  private chooseOrigin(candidate: Place | SavedPlace): void {
    this.originMode = false;
    this.originText = "label" in candidate ? candidate.label : candidate.name;
    this.message = "";
    void this.ensure().chooseOrigin(candidate);
    this.invalidate();
  }

  private editOrigin(text: string): void {
    const choosing = this.choosingOrigin();
    this.originText = text;
    this.ensure().clearOrigin();
    this.message = choosing
      ? `Press Enter to search again for a starting point to ${this.selected?.label ?? ""}.`
      : "Press Enter to search for this origin or calculate a route from coordinates.";
    this.invalidate();
  }

  private choosingOrigin(): boolean {
    return (
      this.originMode && this.directions && !this.navigating && !!this.selected
    );
  }

  private readyRoute(): Route | null {
    return this.state?.route.phase === "ready" ? this.state.route.value : null;
  }

  private savedFor(selected: MapsScreenSelection): SavedPlace | undefined {
    return this.state?.saved.value.find(
      (item) =>
        item.id === selected.savedId ||
        (!!selected.providerId &&
          item.providerId === selected.providerId &&
          item.providerPlaceId === selected.providerPlaceId),
    );
  }

  /** Provider detail for exactly the selected place, when the source has it. */
  private detail(): Place | undefined {
    const item = this.selected;
    const selection = this.state?.selection;
    return selection?.phase === "ready" &&
      item?.providerPlaceId &&
      selection.value?.id === item.providerPlaceId &&
      selection.value.providerId === item.providerId
      ? selection.value
      : undefined;
  }

  private mapsAppText(): string {
    return this.host.mapsApp &&
      this.state?.provider.status === "unconfigured" &&
      this.eventQuery &&
      this.query === this.eventQuery &&
      !this.navigating
      ? this.eventQuery
      : "";
  }

  private readMapsApp(): void {
    const port = this.host.mapsApp;
    if (!port || this.mapsAppAvailable !== undefined || this.mapsAppReading)
      return;
    this.mapsAppReading = true;
    void port
      .available()
      .then(
        (available) => {
          this.mapsAppAvailable = available;
        },
        () => {
          this.mapsAppAvailable = false;
        },
      )
      .finally(() => {
        this.mapsAppReading = false;
        this.invalidate();
      });
  }

  private share(data: MapShare, current: () => boolean): void {
    if (!current() || !this.host.active()) return;
    this.sharing?.abort.abort();
    const owner = { abort: new AbortController(), current };
    this.sharing = owner;
    void this.host
      .share(data, owner.abort.signal)
      .then((result) => {
        if (this.sharing === owner && current() && result === "copied")
          this.host.toast("Copied");
      })
      .catch(() => {})
      .finally(() => {
        if (this.sharing === owner) this.sharing = undefined;
      });
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private continuing(): boolean {
    return this.navigating && this.host.background.active();
  }

  private usable(): boolean {
    return !this.disposed && this.host.active();
  }

  /** Publishes the selection to the agent context and asks the host to render. */
  private invalidate(selectionChanged = true): void {
    if (this.sharing && !this.sharing.current()) {
      this.sharing.abort.abort();
      this.sharing = undefined;
    }
    const token = ++this.revision;
    const selected = this.selected;
    if (selectionChanged && selected) {
      let identity = this.identities.get(selected);
      if (!identity) {
        identity = {};
        this.identities.set(selected, identity);
      }
      const route =
        (this.directions || this.navigating) &&
        this.state?.route.phase === "ready"
          ? this.state.route.value
          : null;
      const provider = this.state?.provider;
      const read =
        provider?.status === "configured"
          ? () => {
              if (route && route.mode !== "transit")
                return {
                  kind: "map-route" as const,
                  providerId: provider.providerId,
                  providerRevision: provider.revision,
                  attribution: route.attribution,
                  from: route.from,
                  to: route.to,
                  mode: route.mode,
                  distanceMeters: route.distanceMeters,
                  durationSeconds: route.durationSeconds,
                  traffic: route.traffic,
                };
              return {
                kind: "map-place" as const,
                providerId: provider.providerId,
                providerRevision: provider.revision,
                attribution:
                  this.host.attribution() ||
                  this.state?.selection.value?.attribution ||
                  "",
                label: selected.label,
                coordinate: selected.coordinate,
              };
            }
          : undefined;
      // Route identity changes with origin, mode and provider updates; a failed or
      // loading route exposes no stale route read.
      this.host.publishContext?.(
        route ? "map-route" : "map-place",
        identity,
        token,
        read,
      );
    } else if (selectionChanged && this.searching && this.query.trim())
      this.host.publishContext?.("map-search", this.searchIdentity, token);
    else if (selectionChanged) this.host.clearContext?.();
    queueMicrotask(() => {
      if (!this.disposed && token === this.revision && this.host.active())
        this.host.invalidate();
    });
  }
}

/** A controller with a change subscription, for views that render on demand. */
export interface MapsScreenHandle {
  controller: MapsScreenController;
  subscribe(listener: () => void): () => void;
  /** Increments on every render request. */
  version(): number;
}

/** Creates a screen whose render requests notify subscribers (e.g. React). */
export function createMapsScreen(
  host: Omit<MapsScreenHost, "invalidate">,
): MapsScreenHandle {
  const listeners = new Set<() => void>();
  let version = 0;
  const controller = new MapsScreenController({
    ...host,
    invalidate: () => {
      version++;
      for (const listener of [...listeners]) listener();
    },
  });
  return {
    controller,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}
