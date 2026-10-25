type Permission = {
  location: "granted" | "denied" | "prompt";
  accuracy?: "precise" | "approximate" | "none";
};
type Fix = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    timestamp: number;
    heading?: number | null;
    speed?: number | null;
  };
  cached: boolean;
};

import type { PluginListenerHandle } from "@capacitor/core";
import { coordinate, MapsFailure } from "./contracts.ts";
import type { Position } from "./location.ts";

export type { Position } from "./location.ts";
export type LocationBridge = {
  checkPermissions(): Promise<Permission>;
  requestPermissions(input?: { requestId: string }): Promise<Permission>;
  cancelPermissionRequest(input: { requestId: string }): Promise<void>;
  watchPosition(options: {
    accuracy: "high";
    minInterval: number;
    minDistance: number;
  }): Promise<{ watchId: string }>;
  clearWatch(options: { watchId: string }): Promise<void>;
  addListener(
    name: "locationChange",
    callback: (fix: Fix) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    name: "error",
    callback: (error: { code: string }) => void,
  ): Promise<PluginListenerHandle>;
};
type Session = {
  aborted: boolean;
  handles: PluginListenerHandle[];
  watchId?: string;
  permissionRequestId?: string;
  cancelForegroundWait?: () => void;
};
/** One owner per Maps controller. The upstream event contract has no watchId. */
export class NativeMapsLocation {
  constructor(
    private readonly location: LocationBridge,
    private readonly platform: { isNative(): boolean; available(): boolean },
  ) {}
  private session?: Session;
  private admitting = false;
  private generation = 0;
  private requestingPermission = false;
  awaitingPermission() {
    return this.requestingPermission && !!this.session && !this.session.aborted;
  }
  available() {
    return this.platform.available();
  }
  async stop(): Promise<void> {
    ++this.generation;
    const current = this.session;
    this.session = undefined;
    if (!current) return;
    current.aborted = true;
    current.cancelForegroundWait?.();
    const results = await Promise.allSettled([
      ...current.handles.map((handle) => handle.remove()),
      ...(current.permissionRequestId && !this.platform.isNative()
        ? [
            this.location.cancelPermissionRequest({
              requestId: current.permissionRequestId,
            }),
          ]
        : []),
      ...(current.watchId
        ? [this.location.clearWatch({ watchId: current.watchId })]
        : []),
    ]);
    // Report a native cleanup failure rather than claiming the watch stopped.
    if (results.some((result) => result.status === "rejected"))
      throw new MapsFailure(
        "unavailable",
        "Location cleanup could not be confirmed.",
      );
  }
  async start(
    oneShot: boolean,
    onFix: (position: Position) => void,
    onError: (error: MapsFailure) => void,
  ): Promise<void> {
    if (this.admitting)
      throw new MapsFailure(
        "unavailable",
        "A location permission or start request is still settling.",
      );
    if (!this.available())
      throw new MapsFailure(
        "unavailable",
        "Native location is unavailable in this build.",
      );
    this.admitting = true;
    let session: Session | undefined;
    try {
      const ticket = this.generation + 1;
      await this.stop();
      if (this.generation !== ticket) return;
      session = { aborted: false, handles: [] };
      this.session = session;
      const current = session;
      const active = () => this.session === current && !current.aborted;
      const report = (error: MapsFailure) => {
        if (active()) {
          onError(error);
          void this.stop().catch(onError);
        }
      };
      let permission = await this.location.checkPermissions();
      if (!active()) return;
      if (permission.location !== "granted") {
        this.requestingPermission = true;
        if (!this.platform.isNative())
          current.permissionRequestId = crypto.randomUUID();
        permission = await this.location.requestPermissions(
          current.permissionRequestId
            ? { requestId: current.permissionRequestId }
            : undefined,
        );
        current.permissionRequestId = undefined;
        // Android's permission surface may temporarily hide a launcher WebView.
        // Preserve the explicit request, but never start GPS while hidden.
        if (active() && permission.location === "granted" && document.hidden) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              document.removeEventListener("visibilitychange", visible);
              current.cancelForegroundWait = undefined;
              resolve();
            };
            const visible = () => {
              if (!document.hidden) finish();
            };
            current.cancelForegroundWait = () => finish();
            document.addEventListener("visibilitychange", visible);
          });
        }
        this.requestingPermission = false;
      }
      if (!active()) return;
      if (permission.location !== "granted")
        throw new MapsFailure(
          "permission-denied",
          "Location permission was not granted. You can choose an origin manually.",
        );
      // Listeners precede watch creation so the first fix cannot be lost.
      const fixes = await this.location.addListener("locationChange", (fix) => {
        if (!active()) return;
        try {
          const coords = fix.coords,
            position = coordinate(coords);
          if (
            !Number.isFinite(coords.accuracy) ||
            coords.accuracy < 0 ||
            !Number.isFinite(coords.timestamp) ||
            Date.now() - coords.timestamp > 30000 ||
            coords.timestamp > Date.now() + 5000
          )
            throw new MapsFailure(
              "invalid-response",
              "A fresh location fix is not available.",
            );
          const heading = coords.heading,
            speed = coords.speed;
          onFix({
            coordinate: position,
            accuracyMeters: coords.accuracy,
            timestamp: coords.timestamp,
            precision:
              permission.accuracy === "precise" ||
              permission.accuracy === "approximate"
                ? permission.accuracy
                : "unknown",
            // A reported bearing is only meaningful while the device is moving.
            ...(typeof heading === "number" &&
            Number.isFinite(heading) &&
            heading >= 0 &&
            heading <= 360 &&
            typeof speed === "number" &&
            Number.isFinite(speed) &&
            speed > 0.5
              ? { headingDegrees: heading % 360 }
              : {}),
            ...(typeof speed === "number" &&
            Number.isFinite(speed) &&
            speed >= 0
              ? { speedMetersPerSecond: speed }
              : {}),
          });
          if (oneShot) void this.stop().catch(onError);
        } catch (error) {
          report(
            error instanceof MapsFailure
              ? error
              : new MapsFailure(
                  "invalid-response",
                  "The location fix is invalid.",
                ),
          );
        }
      });
      if (!active()) {
        await fixes.remove();
        return;
      }
      current.handles.push(fixes);
      const errors = await this.location.addListener("error", (error) =>
        report(
          new MapsFailure(
            error.code === "PERMISSION_DENIED"
              ? "permission-denied"
              : "unavailable",
            "Location is unavailable. Check device location settings or choose an origin manually.",
          ),
        ),
      );
      if (!active()) {
        await errors.remove();
        return;
      }
      current.handles.push(errors);
      const watch = await this.location.watchPosition({
        accuracy: "high",
        minInterval: 1000,
        minDistance: 0,
      });
      // Leaving during native watch setup must clear the eventual native ID.
      if (!active()) await this.location.clearWatch({ watchId: watch.watchId });
      else current.watchId = watch.watchId;
    } catch (error) {
      if (session && this.session === session && !session.aborted) {
        onError(
          error instanceof MapsFailure
            ? error
            : new MapsFailure("unavailable", "Location could not start."),
        );
        await this.stop();
      } else if (!session) throw error;
    } finally {
      this.requestingPermission = false;
      this.admitting = false;
    }
  }
}
