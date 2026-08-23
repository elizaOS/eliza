/**
 * Backwards-compatible import for the former cockpit runtime switcher.
 *
 * DevicesRuntimesContainer is the single stateful product implementation. Keep
 * this public export as a thin adapter so older consumers do not silently lose
 * their settings entry while avoiding a second registry/pairing/SSH lifecycle.
 */
import { DevicesRuntimesContainer } from "../settings/DevicesRuntimesContainer";

export interface MyRuntimesContainerProps {
  className?: string;
}

/** @deprecated Use DevicesRuntimesContainer from the settings package. */
export function MyRuntimesContainer({ className }: MyRuntimesContainerProps) {
  return <DevicesRuntimesContainer className={className} />;
}
