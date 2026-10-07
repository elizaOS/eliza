import type { PageLayoutManifest, SurfaceManifest } from "@elizaos/core";
import { IMMERSIVE_WALLPAPER_SURFACE } from "@elizaos/core/protocol";

/** A route-sensitive surface policy used by launcher roots with opaque children. */
export interface BuiltinRouteConditionalSurface {
  readonly shared: (trimmedNavigationPath: string) => boolean;
}

/** Surface policy declared by a host-owned route. */
export type BuiltinRouteSurfaceDeclaration =
  | SurfaceManifest
  | BuiltinRouteConditionalSurface;

interface BuiltinRouteDescriptor {
  readonly path: string;
  readonly layout: PageLayoutManifest;
  readonly surface?: BuiltinRouteSurfaceDeclaration;
  /** Dynamic children composed by this builtin's host-owned renderer. */
  readonly dynamicChildren?: readonly BuiltinDynamicViewDescriptor[];
}

interface BuiltinDynamicViewDescriptor {
  readonly viewId: string;
  readonly componentExport: string;
}

export const DATABASE_VECTOR_VIEW = Object.freeze({
  viewId: "vector-browser",
  componentExport: "VectorBrowserView",
});

const CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "view",
  gutter: "standard",
});

const SHELL_CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "shell",
  gutter: "standard",
});

const SHELL_WIDE_CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "wide",
  scroll: "shell",
  gutter: "standard",
});

const WORKSPACE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "workspace",
  width: "wide",
  scroll: "view",
  gutter: "standard",
});

/** Routes whose rendered view owns its canonical FramedPage width and gutter. */
const FRAMED_PAGE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "view",
  gutter: "none",
});

const FULL_WORKSPACE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "workspace",
  width: "full",
  scroll: "view",
  gutter: "none",
});

const IMMERSIVE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "immersive",
  width: "full",
  scroll: "view",
  gutter: "none",
});

const AMBIENT_IMMERSIVE_LAYOUT: PageLayoutManifest = Object.freeze({
  ...IMMERSIVE_LAYOUT,
  topology: "ambient",
});

export const BUILTIN_ROUTE_DESCRIPTORS = {
  chat: {
    path: "/chat",
    layout: AMBIENT_IMMERSIVE_LAYOUT,
    surface: IMMERSIVE_WALLPAPER_SURFACE,
  },
  phone: { path: "/phone", layout: FULL_WORKSPACE_LAYOUT },
  messages: { path: "/messages", layout: FULL_WORKSPACE_LAYOUT },
  contacts: { path: "/contacts", layout: WORKSPACE_LAYOUT },
  camera: { path: "/camera", layout: FULL_WORKSPACE_LAYOUT },
  tasks: { path: "/apps/tasks", layout: FRAMED_PAGE_LAYOUT },
  browser: {
    path: "/browser",
    layout: FULL_WORKSPACE_LAYOUT,
    surface: {
      isolation: "native-webview",
      background: "opaque",
      header: "fullscreen",
    },
  },
  stream: { path: "/stream", layout: CONTENT_LAYOUT },
  apps: {
    path: "/apps",
    layout: IMMERSIVE_LAYOUT,
    surface: { shared: (path) => path === "/apps" },
  },
  views: {
    path: "/views",
    layout: IMMERSIVE_LAYOUT,
    surface: { shared: (path) => path === "/views" },
  },
  character: { path: "/character", layout: FRAMED_PAGE_LAYOUT },
  "character-select": {
    path: "/character/select",
    layout: FRAMED_PAGE_LAYOUT,
  },
  clock: { path: "/clock", layout: FRAMED_PAGE_LAYOUT },
  automations: { path: "/automations", layout: FRAMED_PAGE_LAYOUT },
  inventory: { path: "/wallet", layout: SHELL_WIDE_CONTENT_LAYOUT },
  documents: {
    path: "/character/documents",
    layout: WORKSPACE_LAYOUT,
  },
  files: { path: "/apps/files", layout: SHELL_CONTENT_LAYOUT },
  plugins: { path: "/apps/plugins", layout: WORKSPACE_LAYOUT },
  skills: { path: "/apps/skills", layout: WORKSPACE_LAYOUT },
  trajectories: { path: "/apps/trajectories", layout: WORKSPACE_LAYOUT },
  transcripts: { path: "/apps/transcripts", layout: CONTENT_LAYOUT },
  relationships: {
    path: "/apps/relationships",
    layout: WORKSPACE_LAYOUT,
  },
  experience: { path: "/character/experience", layout: FRAMED_PAGE_LAYOUT },
  "character-skills": {
    path: "/character/skills",
    layout: FRAMED_PAGE_LAYOUT,
  },
  memories: {
    path: "/apps/memories",
    layout: FRAMED_PAGE_LAYOUT,
    surface: { background: "opaque" },
  },
  runtime: { path: "/apps/runtime", layout: WORKSPACE_LAYOUT },
  database: {
    path: "/apps/database",
    layout: FRAMED_PAGE_LAYOUT,
    dynamicChildren: [DATABASE_VECTOR_VIEW],
  },
  desktop: { path: "/desktop", layout: FULL_WORKSPACE_LAYOUT },
  settings: { path: "/settings", layout: FULL_WORKSPACE_LAYOUT },
  vault: { path: "/vault", layout: FRAMED_PAGE_LAYOUT },
  logs: { path: "/apps/logs", layout: CONTENT_LAYOUT },
  background: {
    path: "/background",
    layout: IMMERSIVE_LAYOUT,
    surface: IMMERSIVE_WALLPAPER_SURFACE,
  },
} as const satisfies Record<string, BuiltinRouteDescriptor>;

/** Built-in tab identifiers derived from the route authority. */
export type BuiltinTab = keyof typeof BUILTIN_ROUTE_DESCRIPTORS;

export interface ResolvedBuiltinRouteDescriptor extends BuiltinRouteDescriptor {
  readonly id: BuiltinTab;
}

const BUILTIN_ROUTE_BY_ID: Readonly<Record<string, BuiltinRouteDescriptor>> =
  BUILTIN_ROUTE_DESCRIPTORS;

/** Built-in ids in stable declaration order. */
export const BUILTIN_ROUTE_IDS = Object.freeze(
  Object.keys(BUILTIN_ROUTE_DESCRIPTORS) as BuiltinTab[],
);

/** Resolve the route owned by a built-in tab. */
export function resolveBuiltinRouteDescriptor(
  id: string,
): ResolvedBuiltinRouteDescriptor | null {
  const descriptor = BUILTIN_ROUTE_BY_ID[id];
  if (!descriptor) return null;

  return {
    id: id as BuiltinTab,
    ...descriptor,
  };
}

/** Map every built-in id without introducing another hand-maintained key list. */
export function mapBuiltinRoutes<Value>(
  select: (descriptor: ResolvedBuiltinRouteDescriptor) => Value,
): Record<BuiltinTab, Value> {
  return Object.fromEntries(
    BUILTIN_ROUTE_IDS.map((id) => {
      const descriptor = resolveBuiltinRouteDescriptor(id);
      if (!descriptor) {
        throw new Error(`Builtin route "${id}" has no descriptor`);
      }
      return [id, select(descriptor)];
    }),
  ) as Record<BuiltinTab, Value>;
}
