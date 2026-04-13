/**
 * Maps {@link ConnectionUiSpec.screen} to a screen component. **Why not a `Record` registry:** explicit `switch` gives
 * exhaustiveness checking when `ConnectionScreen` grows; equivalent to a component map.
 *
 * Provider detail is passed as `providerDetail` so `ConnectionStep` can pass a stable element with the same `dispatch`
 * without this file importing the large detail component tree (optional tree-shaking / clearer dependency direction).
 */
import type { ReactNode } from "react";
import type { ProviderOption } from "../../../api";
import type {
  ConnectionEffect,
  ConnectionEvent,
  ConnectionUiSpec,
} from "../../../onboarding/connection-flow";
import { ConnectionElizaCloudPreProviderScreen } from "./ConnectionElizaCloudPreProviderScreen";
import { ConnectionHostingScreen } from "./ConnectionHostingScreen";
import { ConnectionProviderGridScreen } from "./ConnectionProviderGridScreen";
import { ConnectionRemoteBackendScreen } from "./ConnectionRemoteBackendScreen";

export type ConnectionUiSharedProps = {
  dispatch: (event: ConnectionEvent) => void;
  onTransitionEffect: (effect: ConnectionEffect) => void;
  sortedProviders: ProviderOption[];
  getProviderDisplay: (provider: ProviderOption) => {
    name: string;
    description?: string;
  };
  getCustomLogo: (id: string) =>
    | {
        logoDark?: string;
        logoLight?: string;
      }
    | undefined;
  getDetectedLabel: (providerId: string) => string | null;
};

export function ConnectionUiRoot({
  spec,
  shared,
  providerDetail,
}: {
  spec: ConnectionUiSpec;
  shared: ConnectionUiSharedProps;
  providerDetail: ReactNode;
}) {
  switch (spec.screen) {
    case "hosting":
      return (
        <ConnectionHostingScreen
          showHostingLocalCard={spec.showHostingLocalCard}
          dispatch={shared.dispatch}
        />
      );
    case "remoteBackend":
      return (
        <ConnectionRemoteBackendScreen
          dispatch={shared.dispatch}
          onTransitionEffect={shared.onTransitionEffect}
        />
      );
    case "elizaCloud_preProvider":
      return (
        <ConnectionElizaCloudPreProviderScreen dispatch={shared.dispatch} />
      );
    case "providerGrid":
      return (
        <ConnectionProviderGridScreen
          dispatch={shared.dispatch}
          onTransitionEffect={shared.onTransitionEffect}
          sortedProviders={shared.sortedProviders}
          getProviderDisplay={shared.getProviderDisplay}
          getCustomLogo={shared.getCustomLogo}
          getDetectedLabel={shared.getDetectedLabel}
        />
      );
    case "providerDetail":
      return <>{providerDetail}</>;
  }
}
