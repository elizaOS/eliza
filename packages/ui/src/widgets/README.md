# Widgets

Plugin-contributed UI fragments rendered into named **slots** across the app
(`packages/ui/src/widgets/types.ts` → `WidgetSlot`):

`chat-sidebar` · `character` · `nav-page` · **`home`**

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
**and** its declaration visibility allows it:

- `visibility: "always"` is for core surfaces with no loadable plugin package
  (for example `welcome`, `needs-attention`). These render without waiting for
  a runtime plugin snapshot, while an explicit `present + disabled` snapshot
  entry still hides them.
- `visibility: "fallback"` is for store/compat-backed surfaces that should
  render when the snapshot is empty or omits the plugin, but still respect an
  explicit disabled snapshot entry.
- omitted / `visibility: "snapshot"` is the normal plugin gate: the plugin must
  be present and enabled/active.

## The `home` / frontpage surface (#9143)

The Home/Launcher surface mounts `<WidgetHost slot="home" layout="grid" …>`
on the home page next to the launcher. Home is intentionally sparse: the
ambient time/weather base and pinned notification center carry resting state,
while only essential self-hiding cards live in the ranked widget host. The
notification inbox is NOT a host widget: HomeScreen pins the dashboard
notification center
(`components/shell/NotificationsHomeCenter.tsx`) directly below the
time/weather base, so a registry declaration would double-render it.

**To put a plugin on the frontpage:** declare a widget with `slot: "home"` only
when it is a keeper for the sparse home surface. Read your own store/API in the
component; it receives `WidgetProps` (`pluginId`, `events?`, …). Keep it
compact and self-hiding — domain dashboards belong in launcher/routed views, not
resident home cards.

If a plugin has live state but no bundled React card, opt into a shared default
sink instead of shipping a component:

```ts
{
  id: "my-plugin.default-home",
  pluginId: "my-plugin",
  slot: "home",
  label: "My Plugin",
  defaultWidget: "activity", // "notifications" | "messages" | "activity"
  signalKinds: ["workflow", "activity"],
}
```

Default-sink declarations are participation records: the shared Activity card
no longer renders on sparse home, while the declaration lets coverage prove the
plugin is frontpage-aware. The `notifications` / `messages` / `activity` sink
kinds yield no home tile — notification content already surfaces through the
pinned notification center, and activity/detail surfaces live in launcher/routed
views.

The home is **priority-ranked**, not all-or-nothing: `home-priority.ts`
(`rankHomeWidgets`) scores each home widget by base `order` plus decayed
attention signals and returns the top-N, so the most important widgets bubble up
the way a phone home screen does. Declare your widget; ranking decides placement.
