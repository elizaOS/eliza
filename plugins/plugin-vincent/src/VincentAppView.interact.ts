// View-bundle `interact` capability handler, split out of VincentAppView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./vincent-view-bundle.ts.
import { vincentClient } from "./client";
import { loadVincentTuiState } from "./VincentAppView.helpers";
import type { VincentStrategyUpdateRequest } from "./vincent-contracts";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-vincent-state") {
    return { viewType: "tui", ...(await loadVincentTuiState()) };
  }

  if (capability === "terminal-vincent-start-login") {
    return {
      viewType: "tui",
      login: await vincentClient.vincentStartLogin(
        typeof params?.appName === "string" ? params.appName : "Eliza",
      ),
    };
  }

  if (capability === "terminal-vincent-disconnect") {
    return {
      viewType: "tui",
      disconnected: await vincentClient.vincentDisconnect(),
    };
  }

  if (capability === "terminal-vincent-update-strategy") {
    const request: VincentStrategyUpdateRequest = {};
    if (typeof params?.strategy === "string") {
      request.strategy =
        params.strategy as VincentStrategyUpdateRequest["strategy"];
    }
    if (params?.params && typeof params.params === "object") {
      request.params = params.params as Record<string, unknown>;
    }
    if (typeof params?.intervalSeconds === "number") {
      request.intervalSeconds = params.intervalSeconds;
    }
    if (typeof params?.dryRun === "boolean") {
      request.dryRun = params.dryRun;
    }
    return {
      viewType: "tui",
      update: await vincentClient.vincentUpdateStrategy(request),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
