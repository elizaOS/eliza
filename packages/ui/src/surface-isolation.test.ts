/**
 * Validates the isolation catalogue against shipped manifests so its security
 * boundary descriptions cannot drift as unreferenced architecture prose.
 */

import {
  IMMERSIVE_WALLPAPER_SURFACE,
  resolveSurfaceManifest,
  type SurfaceIsolationLevel,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveBuiltinSurfaceManifest } from "./builtin-tab-registry";
import { SANDBOX_PROBE_MANIFEST } from "./components/views/sandbox-probe-view";
import { SURFACE_ISOLATION_CATALOGUE } from "./surface-isolation";

const SHIPPED_REPRESENTATIVES: Readonly<
  Record<SurfaceIsolationLevel, { id: string; resolved: SurfaceIsolationLevel }>
> = {
  "in-process": {
    id: "settings",
    resolved: resolveSurfaceManifest(null).isolation,
  },
  "sandboxed-iframe": {
    id: "sandbox-probe",
    resolved: resolveSurfaceManifest({ surface: SANDBOX_PROBE_MANIFEST })
      .isolation,
  },
  "native-webview": {
    id: "browser",
    resolved: resolveBuiltinSurfaceManifest("browser").isolation,
  },
  immersive: {
    id: "chat",
    resolved: resolveSurfaceManifest({ surface: IMMERSIVE_WALLPAPER_SURFACE })
      .isolation,
  },
};

describe("surface isolation catalogue", () => {
  it.each(Object.entries(SHIPPED_REPRESENTATIVES))(
    "%s is backed by its shipped representative manifest",
    (level, representative) => {
      const isolation = level as SurfaceIsolationLevel;
      expect(representative.resolved).toBe(isolation);
      expect(SURFACE_ISOLATION_CATALOGUE[isolation].level).toBe(isolation);
      expect(SURFACE_ISOLATION_CATALOGUE[isolation].examples).toContain(
        representative.id,
      );
    },
  );
});
