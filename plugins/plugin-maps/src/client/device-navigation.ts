import {
  boundedText,
  type Coordinate,
  coordinate,
  MapsFailure,
  type Place,
  type TravelMode,
  place as validPlace,
} from "./contracts.ts";
import type { Position } from "./location.ts";
import {
  NAVIGATION_FIX_LIMITS,
  usableNavigationFix,
} from "./navigation-fix.ts";
import type { MapsState } from "./state.ts";

/*
 * The phone side of the plugin-maps `MapsDeviceNavigation` contract (../navigation.ts).
 * The agent asks; the phone decides. GPS, the active route, guidance and local speech stay
 * on the device, and no device position is returned to the agent. The contract types are
 * repeated here because hosts consume this client directory on its own.
 */
export type MapsDeviceNavigationState =
  | "selected"
  | "navigating"
  | "stopped"
  | "awaiting-location"
  | "awaiting-confirmation";
export interface MapsDeviceNavigationStatus {
  state: MapsDeviceNavigationState;
  placeName?: string;
  travelMode?: TravelMode;
}
/** The agent's provider-neutral place (plugin-maps `PlaceRef`). */
export type AgentPlaceRef = Readonly<{
  provider: string;
  providerPlaceId: string;
  name: string;
  coordinates: Coordinate;
  formattedAddress?: string;
  categories?: readonly string[];
  coordinateBinding?: Readonly<{
    provider: "coordinates";
    providerPlaceId: string;
    coordinates: Coordinate;
  }>;
}>;
export interface MapsDeviceNavigation {
  select(
    place: AgentPlaceRef,
    signal?: AbortSignal,
  ): Promise<MapsDeviceNavigationStatus>;
  start(
    request: { destination: AgentPlaceRef; travelMode: TravelMode },
    signal?: AbortSignal,
  ): Promise<MapsDeviceNavigationStatus>;
  reroute(signal?: AbortSignal): Promise<MapsDeviceNavigationStatus>;
  stop(signal?: AbortSignal): Promise<MapsDeviceNavigationStatus>;
}

/** plugin-maps `MapsErrorCode` values a relay reports for a refusal from this phone. */
export type DeviceNavigationMapsCode =
  | "MAPS_DEVICE_UNAVAILABLE"
  | "MAPS_INVALID_INPUT"
  | "MAPS_NOT_FOUND"
  | "MAPS_UNSUPPORTED_REGION"
  | "MAPS_AUTH_EXPIRED"
  | "MAPS_NOT_ENTITLED"
  | "MAPS_PROVIDER_CHANGED"
  | "MAPS_RATE_LIMITED"
  | "MAPS_PROVIDER_UNAVAILABLE"
  | "MAPS_PROVIDER_NETWORK"
  | "MAPS_PROVIDER_TIMEOUT"
  | "MAPS_MALFORMED_RESPONSE";
/**
 * A typed refusal. The phone never reports a state it is not in. Upstream actions convert
 * only `MapsError`, so a relay must rebuild one from `code` and `message`.
 */
export class DeviceNavigationFailure extends Error {
  override readonly name = "DeviceNavigationFailure";
  constructor(
    readonly code: DeviceNavigationMapsCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The navigation session as the Maps screen holds it; only the user's Start creates one.
 * It lasts from Start to End, including while a new route is planned and after arrival.
 */
export type ActiveGuidance = Readonly<{
  routeId: string;
  placeName: string;
  travelMode: TravelMode;
  fix?: Position;
  rerouting: boolean;
  arrived: boolean;
}>;
/** The Maps screen operations the binding uses (implemented by the host's Maps screen). */
export interface MapsNavigationSurface {
  /** Brings Maps to the foreground. False when the phone cannot show it now (screen hidden, locked, or Maps unavailable). */
  present(): Promise<boolean>;
  snapshot(): MapsState | undefined;
  /** Shows the place sheet for this destination and resolves when the selection settles. */
  showPlace(place: Place, resolveDetails: boolean): Promise<void>;
  /** Shows the route sheet for this destination and mode. Guidance still needs the user's Start. */
  showDirections(
    place: Place,
    travelMode: TravelMode,
    resolveDetails: boolean,
  ): Promise<void>;
  /** Whether location is already granted. Never shows a permission prompt. */
  locationGranted(): Promise<boolean>;
  /** One location fix from the device; rejects when none arrives. */
  locate(signal: AbortSignal): Promise<Position>;
  /** Plans the shown route from this device coordinate; resolves when planning settles. */
  planFrom(origin: Coordinate): Promise<void>;
  guidance(): ActiveGuidance | null;
  /** The screen's own "Reroute from here"; resolves when the replacement route settles. */
  reroute(from: Coordinate): Promise<void>;
  /** Ends guidance and its location watch (the screen's End). */
  stop(): Promise<void>;
  /** Called when Maps is left or released; in-flight agent work is cancelled. */
  onRelease(listener: () => void): () => void;
}
/** The Cloud Maps installation (signed-in account) this binding belongs to. */
export type NavigationOwner = Readonly<{
  providerId: string;
  attribution: string;
  current(): boolean;
}>;
export type NavigationLimits = Readonly<{
  fixTimeoutMs: number;
  maxFixAgeMs: number;
  maxAccuracyMeters: number;
  now: () => number;
}>;
const LIMITS: NavigationLimits = {
  fixTimeoutMs: 15_000,
  ...NAVIGATION_FIX_LIMITS,
  now: () => Date.now(),
};
const MODES: readonly TravelMode[] = ["drive", "walk", "bicycle", "transit"];
/** The agent's Cloud adapter id; Cloud place ids are shared with the phone's Cloud provider. */
const AGENT_CLOUD_PROVIDER = "eliza-cloud";
const unavailable = (message: string) =>
  new DeviceNavigationFailure("MAPS_DEVICE_UNAVAILABLE", message);

/** Translates a phone Maps failure into the agent's typed code without inventing a state. */
export function deviceNavigationFailure(
  error: unknown,
): DeviceNavigationFailure {
  if (error instanceof DeviceNavigationFailure) return error;
  if (!(error instanceof MapsFailure))
    return unavailable("The phone could not complete this Maps request.");
  switch (error.code) {
    case "cancelled":
      return unavailable("The Maps request was cancelled on the phone.");
    case "unauthorized":
      return new DeviceNavigationFailure(
        /subscription/i.test(error.message)
          ? "MAPS_NOT_ENTITLED"
          : /account changed/i.test(error.message)
            ? "MAPS_PROVIDER_CHANGED"
            : "MAPS_AUTH_EXPIRED",
        error.message,
      );
    case "rate-limited":
      return new DeviceNavigationFailure("MAPS_RATE_LIMITED", error.message);
    case "unsupported":
      return new DeviceNavigationFailure(
        /no route/i.test(error.message)
          ? "MAPS_NOT_FOUND"
          : /choose an actual origin/i.test(error.message)
            ? "MAPS_INVALID_INPUT"
            : "MAPS_UNSUPPORTED_REGION",
        error.message,
      );
    case "offline":
      return new DeviceNavigationFailure(
        "MAPS_PROVIDER_NETWORK",
        error.message,
      );
    case "timeout":
      return new DeviceNavigationFailure(
        "MAPS_PROVIDER_TIMEOUT",
        error.message,
      );
    case "invalid-response":
      return new DeviceNavigationFailure(
        "MAPS_MALFORMED_RESPONSE",
        error.message,
      );
    case "unconfigured":
    case "unavailable":
      return new DeviceNavigationFailure(
        "MAPS_PROVIDER_UNAVAILABLE",
        error.message,
      );
    default:
      return unavailable(error.message);
  }
}

/** Implements the agent contract over the existing reviewed Maps screen state. */
export class DeviceMapsNavigation implements MapsDeviceNavigation {
  private request?: AbortController;
  private retired = false;
  private readonly released: () => void;
  private readonly limits: NavigationLimits;
  constructor(
    private readonly surface: MapsNavigationSurface,
    private readonly owner: NavigationOwner,
    limits: Partial<NavigationLimits> = {},
  ) {
    this.limits = { ...LIMITS, ...limits };
    this.released = surface.onRelease(() => this.request?.abort());
  }
  /** Account change or Maps provider change: cancels in-flight work and refuses later calls. */
  retire() {
    this.retired = true;
    this.request?.abort();
    this.request = undefined;
    this.released();
  }

  /** One agent request at a time; a newer request (or Stop) cancels the older one. */
  private begin(signal?: AbortSignal) {
    if (signal?.aborted)
      throw unavailable("The Maps request was cancelled on the phone.");
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const cancel = () => request.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const check = () => {
      if (this.retired || !this.owner.current())
        throw new DeviceNavigationFailure(
          "MAPS_PROVIDER_CHANGED",
          "The Maps account on the phone changed. Nothing was changed on the map.",
        );
      if (request.signal.aborted)
        throw unavailable("The Maps request was cancelled on the phone.");
    };
    const done = () => {
      signal?.removeEventListener("abort", cancel);
      if (this.request === request) this.request = undefined;
    };
    try {
      check();
    } catch (error) {
      done();
      throw error;
    }
    return { signal: request.signal, check, done };
  }

  /** Converts an agent place into a phone place under this installation's provider. */
  private destination(value: AgentPlaceRef): {
    place: Place;
    resolveDetails: boolean;
  } {
    const ref = value && typeof value === "object" ? value : null;
    if (
      !ref ||
      !boundedText(ref.name, 300) ||
      !boundedText(ref.providerPlaceId, 512) ||
      (ref.formattedAddress !== undefined &&
        !boundedText(ref.formattedAddress, 1000))
    )
      throw new DeviceNavigationFailure(
        "MAPS_INVALID_INPUT",
        "The place is invalid.",
      );
    let point: Coordinate;
    try {
      point = coordinate(ref.coordinates);
    } catch {
      throw new DeviceNavigationFailure(
        "MAPS_INVALID_INPUT",
        "The place coordinates are invalid.",
      );
    }
    // A Cloud place is re-read from the phone's own Cloud provider; a coordinate place is a dropped pin.
    const cloud =
      ref.provider === AGENT_CLOUD_PROVIDER ||
      ref.provider === this.owner.providerId;
    if (!cloud && ref.provider !== "coordinates")
      throw new DeviceNavigationFailure(
        "MAPS_INVALID_INPUT",
        "The phone can show only Cloud Maps places or coordinates.",
      );
    try {
      return {
        place: validPlace(
          {
            providerId: this.owner.providerId,
            id: cloud ? ref.providerPlaceId : "coordinates",
            name: ref.name.trim(),
            coordinate: point,
            ...(ref.formattedAddress ? { address: ref.formattedAddress } : {}),
            attribution: this.owner.attribution,
            fetchedAt: this.limits.now(),
          },
          this.owner.providerId,
        ),
        resolveDetails: cloud,
      };
    } catch {
      throw new DeviceNavigationFailure(
        "MAPS_INVALID_INPUT",
        "The place is invalid.",
      );
    }
  }

  private async present(check: () => void) {
    const shown = await this.surface.present();
    check();
    if (!shown)
      throw unavailable(
        "Open Maps on the phone to continue. Nothing was changed on the map.",
      );
    const provider = this.surface.snapshot()?.provider;
    if (
      provider?.status !== "configured" ||
      provider.providerId !== this.owner.providerId
    )
      throw unavailable("Cloud Maps is not connected on the phone.");
    return provider;
  }

  /** The settled selection for exactly this destination, or a typed failure. */
  private selected(place: Place): Place {
    const selection = this.surface.snapshot()?.selection;
    if (
      selection?.phase === "ready" &&
      selection.value?.id === place.id &&
      selection.value.providerId === place.providerId
    )
      return selection.value;
    if (selection?.phase === "error" && selection.error)
      throw deviceNavigationFailure(selection.error);
    if (selection?.phase === "empty")
      throw new DeviceNavigationFailure(
        "MAPS_NOT_FOUND",
        "Cloud Maps has no such place.",
      );
    throw unavailable("The place could not be shown on the phone.");
  }

  async select(
    value: AgentPlaceRef,
    signal?: AbortSignal,
  ): Promise<MapsDeviceNavigationStatus> {
    const run = this.begin(signal);
    try {
      const { place, resolveDetails } = this.destination(value);
      // Selecting another place would replace the route of active guidance; the user ends it first.
      if (this.surface.guidance())
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "Navigation is active on the phone. End it before selecting another place.",
        );
      await this.present(run.check);
      if (this.surface.guidance())
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "Navigation started on the phone. End it before selecting another place.",
        );
      await this.surface.showPlace(place, resolveDetails);
      run.check();
      return { state: "selected", placeName: this.selected(place).name };
    } catch (error) {
      throw deviceNavigationFailure(error);
    } finally {
      run.done();
    }
  }

  /**
   * Shows the route from a fresh device fix and leaves Start to the user. Guidance never
   * begins from an agent request: the phone reports awaiting-confirmation, or
   * awaiting-location when it has no fresh, precise enough fix.
   */
  async start(
    request: { destination: AgentPlaceRef; travelMode: TravelMode },
    signal?: AbortSignal,
  ): Promise<MapsDeviceNavigationStatus> {
    const run = this.begin(signal);
    try {
      const travelMode = request?.travelMode;
      if (!MODES.includes(travelMode))
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "Travel mode must be drive, walk, bicycle, or transit.",
        );
      const { place, resolveDetails } = this.destination(request.destination);
      if (this.surface.guidance())
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "Navigation is already active on the phone. End it before starting another route.",
        );
      const provider = await this.present(run.check);
      if (this.surface.guidance())
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "Navigation started on the phone. End it before starting another route.",
        );
      if (!provider.capabilities.modes.includes(travelMode))
        throw new DeviceNavigationFailure(
          "MAPS_UNSUPPORTED_REGION",
          `Cloud Maps does not plan ${travelMode} routes.`,
        );
      await this.surface.showDirections(place, travelMode, resolveDetails);
      run.check();
      const destination = this.selected(place),
        status = { placeName: destination.name, travelMode };
      const selectionRevision = this.surface.snapshot()?.revision;
      // No permission prompt from an agent request; the route sheet offers "Use current location".
      if (!(await this.surface.locationGranted())) {
        run.check();
        return { state: "awaiting-location", ...status };
      }
      run.check();
      const fix = await this.freshFix(run.signal);
      run.check();
      if (!fix) return { state: "awaiting-location", ...status };
      // The user may have changed the route sheet or started guidance while GPS was pending.
      const shown = this.surface.snapshot();
      if (
        this.surface.guidance() ||
        shown?.revision !== selectionRevision ||
        shown?.mode !== travelMode
      )
        throw unavailable(
          "Maps changed on the phone while location was pending. The current route was kept.",
        );
      await this.surface.planFrom(fix.coordinate);
      run.check();
      const route = this.surface.snapshot()?.route;
      if (route?.phase === "error" && route.error)
        throw deviceNavigationFailure(route.error);
      const value = route?.phase === "ready" ? route.value : null;
      if (
        !value ||
        value.mode !== travelMode ||
        value.to.latitude !== destination.coordinate.latitude ||
        value.to.longitude !== destination.coordinate.longitude
      )
        throw unavailable("The route could not be planned on the phone.");
      return { state: "awaiting-confirmation", ...status };
    } catch (error) {
      throw deviceNavigationFailure(error);
    } finally {
      run.done();
    }
  }

  /**
   * Replans the active session from the phone's current fix through the screen's own
   * "Reroute from here". Without a fresh, precise fix the current route is kept and the
   * agent is told so; a stale fix is never a route origin.
   */
  async reroute(signal?: AbortSignal): Promise<MapsDeviceNavigationStatus> {
    const run = this.begin(signal);
    try {
      const active = this.surface.guidance();
      if (!active)
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "No navigation is active on the phone.",
        );
      if (active.arrived)
        throw new DeviceNavigationFailure(
          "MAPS_INVALID_INPUT",
          "The phone has already arrived at the destination.",
        );
      if (active.rerouting)
        throw unavailable("The phone is already planning a new route.");
      if (!this.usable(active.fix))
        throw unavailable(
          "The phone has no fresh, precise location fix, so it kept the current route.",
        );
      const status = {
        placeName: active.placeName,
        travelMode: active.travelMode,
      };
      await this.surface.reroute(active.fix.coordinate);
      run.check();
      const next = this.surface.guidance();
      if (!next) {
        const route = this.surface.snapshot()?.route;
        throw route?.phase === "error" && route.error
          ? deviceNavigationFailure(route.error)
          : unavailable(
              "Navigation ended on the phone before the new route was ready.",
            );
      }
      if (next.rerouting || next.routeId === active.routeId)
        throw unavailable("The phone kept the previous route.");
      return { state: "navigating", ...status };
    } catch (error) {
      throw deviceNavigationFailure(error);
    } finally {
      run.done();
    }
  }

  /** Ends guidance and the location watch. Stop is idempotent and cancels a pending request. */
  async stop(signal?: AbortSignal): Promise<MapsDeviceNavigationStatus> {
    const run = this.begin(signal);
    try {
      const active = this.surface.guidance();
      await this.surface.stop();
      return {
        state: "stopped",
        ...(active
          ? { placeName: active.placeName, travelMode: active.travelMode }
          : {}),
      };
    } catch (error) {
      throw deviceNavigationFailure(error);
    } finally {
      run.done();
    }
  }

  private usable(fix: Position | undefined): fix is Position {
    return usableNavigationFix(fix, this.limits.now(), this.limits);
  }

  /** One bounded fix. A late, stale or approximate fix is never used as the route origin. */
  private async freshFix(signal: AbortSignal): Promise<Position | null> {
    const attempt = new AbortController(),
      cancel = () => attempt.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.limits.fixTimeoutMs);
    try {
      const fix = await Promise.race([
        this.surface.locate(attempt.signal),
        new Promise<never>((_, reject) =>
          attempt.signal.addEventListener(
            "abort",
            () =>
              reject(new MapsFailure("timeout", "No location fix arrived.")),
            { once: true },
          ),
        ),
      ]);
      return this.usable(fix) ? fix : null;
    } catch {
      if (signal.aborted)
        throw unavailable("The Maps request was cancelled on the phone.");
      // Denied, unavailable or timed out: the phone has no usable fix, which is awaiting-location.
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      attempt.abort();
    }
  }
}
