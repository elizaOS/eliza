# Agent Surface

The unified layer that makes every plugin **view** fully controllable by the
agent through the floating pill (voice/text) — so views never ship their own
chat surface. Every interactive element opts in once and becomes addressable,
focus-aware, fillable, clickable, and visible to the agent.

## How it fits together

```
DynamicViewLoader (host)
 └─ AgentSurfaceProvider viewId/viewType         ← owns one ViewAgentRegistry
     ├─ <YourView/>  ── useAgentElement(...) ────► registers elements
     └─ AgentElementOverlay                       ← draws indicators on highlight
                         ▲
   view-interact handler ┘  POST /api/views/:id/interact → WS → here
       routes agent-surface capabilities to handleAgentSurfaceCapability(registry, …)
```

The provider + overlay are mounted by `DynamicViewLoader` for **every** view, so
a view only has to call `useAgentElement`. `@elizaos/ui` and `react` are
externalised in the view bundle (see `packages/scripts/view-bundle-vite.config.ts`),
so the hook resolves to the host singleton and shares the loader's React context.

## Capabilities (handled generically for any view)

| capability        | params              | result                                   |
| ----------------- | ------------------- | ---------------------------------------- |
| `list-elements`   | `{role?, group?}`   | filtered `AgentElementSnapshot[]`        |
| `describe-element`| `{id}`              | one `AgentElementSnapshot`               |
| `get-focus`       | —                   | `{focusedId, element}`                   |
| `get-agent-state` | —                   | full `AgentSurfaceSnapshot`              |
| `agent-click`     | `{id}`              | `{ok, reason?}`                          |
| `agent-fill`      | `{id, value}`       | `{ok, value?, reason?}`                  |
| `agent-focus`     | `{id}`              | `{ok}`                                   |
| `agent-scroll-to` | `{id}`              | `{ok}`                                   |
| `set-highlight`   | `{on}`              | `{highlighting}`                         |

The legacy standard caps (`get-state`, `focus-element`, `click-element`,
`fill-input`) also accept `{agentId}` and route through the registry; `get-state`
returns the registry snapshot when elements are registered.

## Converting a view

```tsx
import { useAgentElement } from "@elizaos/ui";

function RefreshButton({ onClick }: { onClick: () => void }) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",          // stable, unique within the view
    role: "button",
    label: "Refresh",              // what the user would say to target it
    group: "toolbar",
    description: "Reload the data",
  });
  return <button ref={ref} {...agentProps} onClick={onClick} aria-label="Refresh">⟳</button>;
}
```

Rules:

- **One element, one stable id.** Ids are the agent's address space — keep them
  semantic (`tab-positions`, `input-amount`, `action-send`).
- **Hooks can't run in `.map()`** — extract a tiny child component that calls
  `useAgentElement` (see `WalletRailTabButton` in `plugin-wallet-ui`).
- **Roles** drive fill/click affordances:
  `FILLABLE_ROLES` = text-input, number-input, textarea, select, slider;
  `CLICKABLE_ROLES` = button, link, toggle, tab, menu-item, list-item, card.
- **Controlled components** pass `onFill` / `onActivate` so the registry drives
  React state instead of the DOM; uncontrolled native fields work automatically.
- **Tabs/segments**: role `tab`, `status: active ? "active" : "inactive"`, and an
  `aria-current` — the `data-state` also counts as a visual indicator in the
  view audit.
- **Selects/choice pickers**: pass `options` to whitelist valid fill values.
- Don't add a `capabilities` array to `plugin.ts` — the verbs above are universal.

`AgentButton`, `AgentInput`, and `IconTag` are ready-made wrappers for the
common cases.

## Server-side weighting

`packages/agent/src/runtime/view-action-affinity.ts` keeps the active view's
scoped actions at full parameter detail in the planner prompt (set by
`POST /api/views/:id/navigate`), so the agent can act on whatever the user is
looking at even with no intent keyword.
