# @elizaos/cloud-ui

The **Eliza Cloud product UI** — the dashboard, public/auth/payment, billing,
approvals, and account-management surfaces of Eliza Cloud — as a standalone
package split out of `@elizaos/ui` (arch #12092 item 23).

## Why it is a separate package

The cloud SaaS UI is ~57k lines. It must ship in cloud-enabled web builds and be
**completely absent** from the agent app (mobile / desktop / `ELIZA_DISABLE_WEB_SHELL=1`).
Previously it lived under `@elizaos/ui/src/cloud` and was excluded by
build-config aliasing (Vite passthrough stubs for the two lazy entry points plus
a `load()` plugin that emptied the subtree). That made cloud-free builds depend
on app-level Vite stubs, and adding a cloud domain meant editing the shared
`@elizaos/ui` trunk.

As its own package the boundary is real:

- **Cloud builds** import `@elizaos/cloud-ui`; each surface self-registers into
  `@elizaos/ui`'s shared registries at import time, and the trunk
  `CloudRouterShell` renders whatever the registry holds.
- **Cloud-free builds** never import the package. The app only imports it inside
  the `__ELIZA_WEB_SHELL__`-guarded lazy block in `packages/app/src/main.tsx`,
  which is statically unreachable when the shell is excluded — so the whole
  surface tree-shakes out with **no stub alias**.

## The seam

`@elizaos/ui` (trunk) keeps only:

- the **cloud-route registry** (`@elizaos/ui/cloud/shell/cloud-route-registry`)
  and the **settings-section registry**
  (`@elizaos/ui/components/settings/settings-section-registry`) — both keyed on a
  process-global symbol, so a route registered from this package lands in the
  same store the shell reads;
- the **`CloudRouterShell`** mount seam that reads `listCloudRoutes()`.

`@elizaos/cloud-ui` depends on `@elizaos/ui` (registry + shared primitives). The
direction is one-way: **the trunk never imports this package.**

## Boot hook

```ts
import { registerCloudUiSurfaces } from "@elizaos/cloud-ui";
registerCloudUiSurfaces(); // idempotent
```

The app shell calls this alongside `registerAllCloudSurfaces()` from the trunk,
inside the web-shell-only lazy factory.

## Status — incremental migration

This package currently owns the **Approvals** domain (`dashboard/approvals`) as
the proof slice for the boundary. The remaining `@elizaos/ui/src/cloud/*` slices
move here incrementally (see the migration plan in the arch-audit issue).
