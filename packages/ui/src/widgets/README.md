# Widgets

Plugin-contributed UI fragments rendered into named **slots** across the app
(`packages/ui/src/widgets/types.ts` → `WidgetSlot`):

`chat-sidebar` · `chat-inline` · `wallet` · `browser` · `heartbeats` ·
`character` · `settings` · `nav-page` · `automations` · **`home`**

A `<WidgetHost slot="…">` (`WidgetHost.tsx`) resolves every enabled declaration
for a slot, wraps each in an error boundary, and renders the bundled React
component (or a declarative `uiSpec` fallback). It renders nothing when empty
(`hideWhenEmpty`, default on). Pass `layout="grid"` for a responsive 1→2 column
grid (used by the home), or the default `"stack"`.

## Registering a widget

A widget needs **two** things — a registered component and a declaration:

```ts
import { registerWidgetComponent } from "@elizaos/ui/widgets";

// 1. component, keyed by (pluginId, declarationId)
registerWidgetComponent("my-plugin", "my-plugin.summary", MySummaryWidget);

// 2. declaration (slot + metadata). Bundled widgets live in
//    registry.ts:BUILTIN_WIDGET_DECLARATIONS; external plugins push at runtime:
import { registerBuiltinWidgetDeclarations } from "@elizaos/ui/widgets";
registerBuiltinWidgetDeclarations([
  {
    id: "my-plugin.summary",
    pluginId: "my-plugin",
    slot: "home", // ← the frontpage
    label: "My Plugin",
    icon: "Sparkles",
    order: 80,
    defaultEnabled: true,
  },
]);
```

`resolveWidgetsForSlot(slot, plugins)` filters by `slot`, gates on the plugin
being enabled (`isWidgetEnabled`), and resolves the component by
`(pluginId, declarationId)`. A widget shows only when its component resolves
**and** the plugin is enabled — unless the `pluginId` is in
`ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS` (for **core** features with no
loadable plugin, e.g. `notifications`/`messages`).

## The `home` / frontpage surface (#9143)

The Home/Springboard surface mounts `<WidgetHost slot="home" layout="grid" …>`
on the home page next to the launcher. Ships with shared **default widgets** any
install gets out of the box — **Notifications**, **Messages**, and the
orchestrator **Activity** + **Apps** — so the frontpage shows real activity, not
just app icons.

**To put a plugin on the frontpage:** declare a widget with `slot: "home"` (as
above). Read your own store/API in the component; it receives `WidgetProps`
(`pluginId`, `events?`, …). Keep it compact — the home is a summary surface.

The home is **priority-ranked**, not all-or-nothing: `home-priority.ts`
(`rankHomeWidgets`) scores each home widget by base `order` plus decayed
attention signals and returns the top-N, so the most important widgets bubble up
the way a phone home screen does. Declare your widget; ranking decides placement.
