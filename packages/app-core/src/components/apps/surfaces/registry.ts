import { BabylonOperatorSurface } from "./BabylonOperatorSurface";
import { DefenseAgentsOperatorSurface } from "./DefenseAgentsOperatorSurface";
import { HyperscapeOperatorSurface } from "./HyperscapeOperatorSurface";
import { ScapeOperatorSurface } from "./ScapeOperatorSurface";
import { TwoThousandFourScapeOperatorSurface } from "./TwoThousandFourScapeOperatorSurface";
import type { AppOperatorSurfaceComponent } from "./types";

const OPERATOR_SURFACE_COMPONENTS: Record<string, AppOperatorSurfaceComponent> =
  {
    "@hyperscape/plugin-hyperscape": HyperscapeOperatorSurface,
    "@elizaos/app-hyperscape": HyperscapeOperatorSurface,
    "@elizaos/app-babylon": BabylonOperatorSurface,
    "@elizaos/app-2004scape": TwoThousandFourScapeOperatorSurface,
    "@elizaos/app-defense-of-the-agents": DefenseAgentsOperatorSurface,
    "@elizaos/app-scape": ScapeOperatorSurface,
  };

export function getAppOperatorSurface(
  appName: string | null | undefined,
): AppOperatorSurfaceComponent | null {
  if (!appName) return null;
  return OPERATOR_SURFACE_COMPONENTS[appName] ?? null;
}
