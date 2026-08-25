/**
 * Backwards-compatible import for the former cockpit runtime switcher.
 *
 * DevicesRuntimesContainer is the single stateful product implementation. Keep
 * this public export as a thin adapter so older consumers do not silently lose
 * their settings entry while avoiding a second registry/pairing/SSH lifecycle.
 */
import {
  DevicesRuntimesContainer,
  type DevicesRuntimesContainerProps,
} from "../settings/DevicesRuntimesContainer";

export type MyRuntimesContainerProps = DevicesRuntimesContainerProps;

/** @deprecated Use DevicesRuntimesContainer from the settings package. */
export const MyRuntimesContainer = DevicesRuntimesContainer;
