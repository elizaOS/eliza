# View Bundle Build System

View bundles are compiled JavaScript ES modules that plugin UIs ship as. Instead of bundling all plugin UIs into one monolithic file, each plugin with views builds its own self-contained bundle. The agent serves these bundles at `/api/views/<id>/bundle.js`; the frontend shell loads them dynamically via `import()`.

## Why view bundles?

- **Isolation** — a broken plugin UI cannot crash the shell or other views.
- **Lazy loading** — the shell pays zero cost for views the user never opens.
- **Independent shipping** — a plugin can rebuild and redeploy its view without touching the main app bundle.
- **Agent-served** — the agent runtime is the single distribution point; no CDN or separate static host required.

## Architecture

```
Plugin declares ViewDeclaration in Plugin.views[]
  └─ bundlePath: "dist/views/bundle.js"
  └─ componentExport: "MyView"

Agent startup / plugin load
  └─ registerPluginViews() → ViewRegistry.set(id, entry)

Browser shell
  └─ GET /api/views          → list all registered views
  └─ import("/api/views/<id>/bundle.js")  → ES module
  └─ mount module[componentExport]        → React component

Agent HTTP server
  └─ views-routes.ts         → serves bundle.js from disk
  └─ views-registry.ts       → resolves bundlePath → absolute disk path
```

## Externals contract

The shell provides these packages as shared singletons. Every view bundle must externalize them — do not bundle React inside the view bundle.

| Package | Shell global (UMD fallback) |
|---|---|
| `react` | `React` |
| `react-dom` | `ReactDOM` |
| `react/jsx-runtime` | `React` |
| `@elizaos/core` | `ElizaCore` |
| `@elizaos/ui` | `ElizaUI` |
| `@elizaos/shared` | `ElizaShared` |
| `lucide-react` | `LucideReact` |

## Adding a view bundle to a plugin

### 1. Write the view component

Create `src/views/MyView.tsx`. Export a named React component and a `default` alias:

```tsx
export function MyView() {
  return <div>Hello from MyView</div>;
}
export default MyView;
```

Do not import `@elizaos/ui` or React — the shell provides them. Use `fetch("/api/...")` for data.

### 2. Create the view bundle Vite config

Create `vite.config.views.ts` in the plugin root:

```ts
import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/my-plugin",
  viewId: "my-view",
  entry: "./src/views/MyView.tsx",
  componentExport: "MyView",   // optional, for documentation
});
```

### 3. Declare the view in the plugin

In `src/index.ts` (or `src/plugin.ts`), add a `views` array to the `Plugin` object:

```ts
export const myPlugin: Plugin = {
  name: "my-plugin",
  // ...
  views: [{
    id: "my-view",                          // must match viewId above
    label: "My View",
    description: "What this view does",
    icon: "Layers",                         // Lucide icon name
    path: "/my-view",                       // URL path in the shell
    bundlePath: "dist/views/bundle.js",     // relative to plugin package root
    componentExport: "MyView",
    visibleInManager: true,
    desktopTabEnabled: true,
  }],
};
```

### 4. Build

Build a single plugin:

```bash
bun x vite build --config vite.config.views.ts
```

Or build all plugins with view configs from the repo root:

```bash
bun run build:views
```

The bundle lands at `dist/views/bundle.js` inside the plugin directory.

## Platform constraints

| Platform | Dynamic `import()` | Notes |
|---|---|---|
| Web (browser) | Yes | Standard ES module dynamic import |
| Desktop (Electron/Electrobun) | Yes | Same as web |
| iOS App Store | No | Bundles must be pre-compiled into the app binary; agent serves from bundled assets |
| Android Play Store | No | Same restriction as iOS |

On restricted platforms, the build pipeline pre-compiles known view bundles into the app binary. The `platforms` field on `ViewDeclaration` lets plugins declare which platforms they support.

## Build script reference

`scripts/build-views.mjs` scans `plugins/` for `vite.config.views.ts` and runs `vite build` in each directory.

```bash
node scripts/build-views.mjs                         # build all
node scripts/build-views.mjs --filter wallet         # only plugins matching "wallet"
node scripts/build-views.mjs --dry-run               # list without building
```

## Vite config factory reference

`scripts/view-bundle-vite.config.ts` exports `createViewBundleConfig(options)`.

| Option | Type | Default | Description |
|---|---|---|---|
| `packageName` | `string` | required | Plugin package name (metadata only) |
| `viewId` | `string` | required | View id — must match `ViewDeclaration.id` |
| `entry` | `string` | required | Entry file relative to plugin root |
| `outDir` | `string` | `"dist/views"` | Output directory |
| `componentExport` | `string` | — | Documentation only; shell reads from `ViewDeclaration` |
| `additionalExternals` | `string[]` | `[]` | Extra packages to externalize beyond the defaults |

The factory always produces:
- Format: `es` (ES module, compatible with `import()`)
- Single output file: `bundle.js`
- No code splitting (`inlineDynamicImports: true`)
- Source maps: off (reduce bundle size)
