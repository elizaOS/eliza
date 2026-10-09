import {
  boundedText,
  type Coordinate,
  configuredProvider,
  coordinate,
  failure,
  MapsFailure,
  type MapsProvider,
  type Place,
  type ProviderConfig,
  place,
  type ResultState,
  type Route,
  type TravelMode,
  unavailableCapabilities,
} from "./contracts.ts";
import type { MapsLocation, Position } from "./location.ts";
import type { SavedPlace, SavedPlaces } from "./saved-places.ts";

const idle = <T>(value: T): ResultState<T> => ({
  phase: "idle",
  value,
  error: null,
});
export type MapsState = Readonly<{
  revision: number;
  provider: ProviderConfig;
  query: string;
  search: ResultState<readonly Place[]>;
  selection: ResultState<Place | null>;
  origin: Coordinate | null;
  position: ResultState<Position | null>;
  mode: TravelMode;
  route: ResultState<Route | null>;
  saved: ResultState<readonly SavedPlace[]>;
}>;
/** State only; no simulated map and no silent provider discovery/fallback. */
export class MapsController {
  private state: MapsState;
  private listeners = new Set<(state: MapsState) => void>();
  private searchRequest?: AbortController;
  private detailRequest?: AbortController;
  private detailPending?: Promise<void>;
  private routeRequest?: AbortController;
  private active = true;
  constructor(
    private config: ProviderConfig,
    private provider: MapsProvider | undefined,
    private savedPlaces: SavedPlaces,
    private nativeLocation: MapsLocation,
  ) {
    this.state = {
      revision: 0,
      provider: config,
      query: "",
      search: idle([]),
      selection: idle(null),
      origin: null,
      position: idle(null),
      mode: "drive",
      route: idle(null),
      saved: idle([]),
    };
    this.reloadSaved();
  }
  snapshot(): MapsState {
    const copy = <T>(result: ResultState<T>): ResultState<T> => ({
      ...result,
      value: structuredClone(result.value),
      error: result.error
        ? new MapsFailure(result.error.code, result.error.message)
        : null,
    });
    return {
      ...structuredClone(this.state),
      search: copy(this.state.search),
      selection: copy(this.state.selection),
      route: copy(this.state.route),
      position: copy(this.state.position),
      saved: copy(this.state.saved),
    };
  }
  awaitingLocationPermission() {
    return this.nativeLocation.awaitingPermission();
  }
  activateProvider(config: ProviderConfig, provider?: MapsProvider) {
    // Initial provider discovery is independent of device location permission.
    // Replacing this controller would silently discard a pending Recenter.
    this.searchRequest?.abort();
    this.detailRequest?.abort();
    this.detailRequest = undefined;
    this.invalidateRoute();
    this.config = config;
    this.provider = provider;
    this.update({ provider: config, search: idle([]), selection: idle(null) });
  }
  capabilities() {
    return this.config.status === "configured"
      ? this.config.capabilities
      : unavailableCapabilities;
  }
  subscribe(listener: (state: MapsState) => void) {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(patch: Partial<MapsState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    const state = this.snapshot();
    this.listeners.forEach((listener) => listener(state));
  }
  private invalidateRoute() {
    this.routeRequest?.abort();
    this.routeRequest = undefined;
    this.update({ route: idle(null) });
  }
  private admitted() {
    return configuredProvider(this.config, this.provider);
  }
  async search(query: string) {
    this.searchRequest?.abort();
    this.detailRequest?.abort();
    this.invalidateRoute();
    const text = query.trim();
    this.update({ query: text, selection: idle(null), search: idle([]) });
    if (!text) return;
    const request = new AbortController();
    this.searchRequest = request;
    this.update({ search: { phase: "loading", value: [], error: null } });
    try {
      if (!boundedText(text, 300))
        throw new MapsFailure(
          "unsupported",
          "Use a search of at most 300 characters.",
        );
      const provider = this.admitted();
      if (!this.capabilities().search)
        throw new MapsFailure(
          "unsupported",
          "This provider does not support place search.",
        );
      const result = await provider.search(text, request.signal);
      if (
        request.signal.aborted ||
        !this.active ||
        this.searchRequest !== request
      )
        return;
      if (!Array.isArray(result) || result.length > 50)
        throw new MapsFailure(
          "invalid-response",
          "The search response is invalid.",
        );
      const items = result.map((item) => place(item, provider.providerId));
      this.update({
        search: {
          phase: items.length ? "ready" : "empty",
          value: items,
          error: null,
        },
      });
    } catch (error) {
      if (!request.signal.aborted && this.active)
        this.update({
          search: { phase: "error", value: [], error: failure(error) },
        });
    }
  }
  select(candidate: Place, resolveDetails = true): Promise<void> {
    this.detailRequest?.abort();
    this.invalidateRoute();
    const request = new AbortController();
    this.detailRequest = request;
    this.update({ selection: { phase: "loading", value: null, error: null } });
    const pending = this.resolveSelection(candidate, resolveDetails, request);
    this.detailPending = pending;
    return pending;
  }
  private async resolveSelection(
    candidate: Place,
    resolveDetails: boolean,
    request: AbortController,
  ) {
    try {
      const provider = this.admitted(),
        original = place(candidate, provider.providerId);
      const result =
        resolveDetails && this.capabilities().placeDetails
          ? await provider.detail(original.id, request.signal)
          : original;
      if (
        request.signal.aborted ||
        !this.active ||
        this.detailRequest !== request
      )
        return;
      const selected = result ? place(result, provider.providerId) : null;
      if (selected && selected.id !== original.id)
        throw new MapsFailure(
          "invalid-response",
          "The selected place identity changed.",
        );
      this.update({
        selection: {
          phase: selected ? "ready" : "empty",
          value: selected,
          error: null,
        },
      });
    } catch (error) {
      if (!request.signal.aborted && this.active)
        this.update({
          selection: { phase: "error", value: null, error: failure(error) },
        });
    }
  }
  clearOrigin() {
    this.invalidateRoute();
    this.update({ origin: null });
  }
  setOrigin(value: Coordinate) {
    const origin = coordinate(value);
    void this.nativeLocation.stop().catch((error) =>
      this.update({
        position: { phase: "error", value: null, error: failure(error) },
      }),
    );
    this.invalidateRoute();
    this.update({ origin, position: idle(null) });
  }
  setMode(mode: TravelMode) {
    if (!["drive", "walk", "bicycle", "transit"].includes(mode))
      throw new MapsFailure("unsupported", "This travel mode is unsupported.");
    this.invalidateRoute();
    this.update({ mode });
  }
  async locate() {
    this.update({ position: { phase: "loading", value: null, error: null } });
    try {
      await this.nativeLocation.start(
        true,
        (position) => {
          if (!this.active) return;
          this.setOrigin(position.coordinate);
          this.update({
            position: { phase: "ready", value: position, error: null },
          });
        },
        (error) =>
          this.update({ position: { phase: "error", value: null, error } }),
      );
    } catch (error) {
      this.update({
        position: { phase: "error", value: null, error: failure(error) },
      });
    }
  }
  async planRoute() {
    this.invalidateRoute();
    const request = new AbortController();
    this.routeRequest = request;
    this.update({ route: { phase: "loading", value: null, error: null } });
    try {
      // Directions can be submitted while the native detail request is still
      // resolving. Keep that user's request, but never route a stale selection.
      const detail = this.detailRequest;
      if (this.state.selection.phase === "loading") await this.detailPending;
      if (
        request.signal.aborted ||
        !this.active ||
        this.routeRequest !== request ||
        this.detailRequest !== detail
      )
        return;
      const provider = this.admitted(),
        { origin, selection, mode } = this.state;
      if (selection.error) throw selection.error;
      if (!origin || !selection.value)
        throw new MapsFailure(
          "unsupported",
          "Choose an actual origin and destination first.",
        );
      if (!this.capabilities().modes.includes(mode))
        throw new MapsFailure(
          "unsupported",
          "This provider does not support that route mode.",
        );
      const result = await provider.route(
        origin,
        selection.value.coordinate,
        mode,
        request.signal,
      );
      if (
        request.signal.aborted ||
        !this.active ||
        this.routeRequest !== request
      )
        return;
      const from = coordinate(result.from),
        to = coordinate(result.to);
      if (
        result.providerId !== provider.providerId ||
        result.mode !== mode ||
        !boundedText(result.id, 512) ||
        !boundedText(result.attribution, 2000) ||
        from.latitude !== origin.latitude ||
        from.longitude !== origin.longitude ||
        to.latitude !== selection.value.coordinate.latitude ||
        to.longitude !== selection.value.coordinate.longitude ||
        !Array.isArray(result.geometry) ||
        result.geometry.length < 2 ||
        result.geometry.length > 20000 ||
        !Array.isArray(result.steps) ||
        result.steps.length > 2000 ||
        !Number.isFinite(result.distanceMeters) ||
        result.distanceMeters < 0 ||
        !Number.isFinite(result.durationSeconds) ||
        result.durationSeconds < 0 ||
        !Number.isFinite(result.fetchedAt) ||
        result.fetchedAt <= 0 ||
        result.fetchedAt > Date.now() + 60000 ||
        result.traffic !== this.capabilities().traffic
      )
        throw new MapsFailure(
          "invalid-response",
          "The provider route is invalid.",
        );
      const steps = result.steps.map((step) => {
        if (
          !boundedText(step.instruction, 2000) ||
          !Number.isFinite(step.distanceMeters) ||
          step.distanceMeters < 0
        )
          throw new MapsFailure(
            "invalid-response",
            "A route instruction is invalid.",
          );
        return { ...step, coordinate: coordinate(step.coordinate) };
      });
      this.update({
        route: {
          phase: "ready",
          value: {
            ...result,
            from,
            to,
            steps,
            geometry: result.geometry.map(coordinate),
          },
          error: null,
        },
      });
    } catch (error) {
      if (!request.signal.aborted && this.active)
        this.update({
          route: { phase: "error", value: null, error: failure(error) },
        });
    }
  }
  reloadSaved() {
    try {
      const items = this.savedPlaces.read();
      this.update({
        saved: {
          phase: items.length ? "ready" : "empty",
          value: items,
          error: null,
        },
      });
    } catch (error) {
      this.update({
        saved: { phase: "error", value: [], error: failure(error) },
      });
    }
  }
  save(input: Parameters<SavedPlaces["save"]>[0]) {
    const item = this.savedPlaces.save(input);
    this.reloadSaved();
    return item;
  }
  renameSaved(id: string, name: string) {
    this.savedPlaces.rename(id, name);
    this.reloadSaved();
  }
  removeSaved(id: string) {
    this.savedPlaces.remove(id);
    this.reloadSaved();
  }
  async leave() {
    this.active = false;
    this.searchRequest?.abort();
    this.detailRequest?.abort();
    this.routeRequest?.abort();
    try {
      await this.nativeLocation.stop();
    } finally {
      this.listeners.clear();
    }
  }
}
