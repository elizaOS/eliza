import type { Coordinate, MapsFailure } from "./contracts.ts";
export type Position = Readonly<{
  coordinate: Coordinate;
  accuracyMeters: number;
  timestamp: number;
  precision: "precise" | "approximate" | "unknown";
  /** Direction of travel in degrees clockwise from true north, when the device reports one. */
  headingDegrees?: number;
  speedMetersPerSecond?: number;
}>;
/** Host-owned permission and lifecycle boundary; a controller never discovers a device. */
export interface MapsLocation {
  awaitingPermission(): boolean;
  start(
    oneShot: boolean,
    onFix: (position: Position) => void,
    onError: (error: MapsFailure) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}
