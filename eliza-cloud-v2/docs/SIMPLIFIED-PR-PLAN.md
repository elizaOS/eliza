# Simplified PR Plan for ui/redesign-dashboard

> **Created:** After PR #1 completion
> **Branch:** `ui/redesign-dashboard`
> **Compared to:** `origin/dev`

---

## Overview

| PR     | Name                        | Files | Status                                    |
| ------ | --------------------------- | ----- | ----------------------------------------- |
| **#1** | Foundation + Auth + Landing | 30    | ✅ Created (`ui/foundation-auth-landing`) |
| **#2** | Dashboard Redesign          | 70    | 🔲 Pending                                |

**Total:** 100 files

---

## PR #1: Foundation + Auth + Landing ✅

**Branch:** `ui/foundation-auth-landing`
**Status:** Created and pushed

### Files (30)

```
# Foundation (9)
components/brand/eliza-logo.tsx (A)
components/brand/brand-button.tsx (M)
components/brand/brand-card.tsx (M)
components/brand/index.ts (M)
components/ui/button.tsx (M)
components/ui/dialog.tsx (M)
components/ui/select.tsx (M)
app/globals.css (M)
lib/hooks/use-typing-placeholder.ts (A)

# Auth Pages (7)
app/login/page.tsx (M)
app/login/page-old.tsx (A)
app/auth/cli-login/page.tsx (M)
app/auth/cli-login/page-old.tsx (A)
app/auth/error/page.tsx (M)
app/auth/error/page-old.tsx (A)
app/app-auth/authorize/page.tsx (M)

# Landing Page (14)
app/page.tsx (M)
app/oldlanding/page.tsx (A)
components/landing/landing-page-new.tsx (A)
components/landing/landing-page.tsx (M)
components/landing/hero-chat-input.tsx (A)
components/landing/discover-agents.tsx (A)
components/landing/discover-apps.tsx (A)
components/landing/bottom-chat-bar.tsx (A)
components/landing/chat-message.tsx (A)
components/landing/TopHero.tsx (M)
components/landing/TopHero-old.tsx (A)
components/landing/Footer.tsx (M)
components/layout/landing-header.tsx (M)
components/layout/landing-header-old.tsx (A)
```

---

## PR #2: Dashboard Redesign 🔲

**Branch:** `ui/dashboard-redesign` (to be created)
**Depends on:** PR #1 merged into dev

### Files (70)

#### Layouts (3)

```
app/layout.tsx (M)
app/dashboard/layout.tsx (M)
app/dashboard/(chat-build)/layout.tsx (M)
```

#### Sidebar & Header (9)

```
components/layout/sidebar.tsx (M)
components/layout/sidebar-data.ts (M)
components/layout/sidebar-item.tsx (M)
components/layout/sidebar-section.tsx (M)
components/layout/header.tsx (M)
components/layout/chat-header.tsx (M)
components/layout/chat-sidebar.tsx (M)
components/layout/sidebar-chat-rooms.tsx (M)
components/layout/user-menu.tsx (M)
```

#### Dashboard Home (7)

```
app/dashboard/page.tsx (M)
components/dashboard/survey-banner.tsx (A)
components/dashboard/agents-section.tsx (M)
components/dashboard/apps-section.tsx (M)
components/dashboard/containers-section.tsx (M)
components/dashboard/overview-metrics.tsx (M)
lib/actions/dashboard.ts (M)
```

#### Apps Pages & Components (15)

```
app/dashboard/apps/page.tsx (M)
app/dashboard/apps/[id]/page.tsx (M)
app/dashboard/apps/[id]/app-page-wrapper.tsx (A)
app/dashboard/apps/apps-empty-state.tsx (A)
app/dashboard/apps/apps-page-wrapper.tsx (A)
app/dashboard/apps/build-with-ai-button.tsx (A)
components/apps/app-analytics.tsx (M)
components/apps/app-details-tabs.tsx (M)
components/apps/app-domains.tsx (M)
components/apps/app-overview.tsx (M)
components/apps/app-promote.tsx (M)
components/apps/app-settings.tsx (M)
components/apps/app-users.tsx (M)
components/apps/apps-table.tsx (M)
components/promotion/promote-app-dialog.tsx (M)
db/repositories/apps.ts (M)
```

#### App Builder (5)

```
app/dashboard/apps/create/page.tsx (M)
components/app-builder/agent-picker.tsx (M)
components/app-builder/chat-input.tsx (M)
components/app-builder/session-loader.tsx (M)
lib/app-builder/markdown-components.tsx (M)
```

#### Containers (5)

```
app/dashboard/containers/page.tsx (M)
app/dashboard/containers/containers-empty-state.tsx (A)
app/dashboard/containers/containers-page-wrapper.tsx (A)
app/dashboard/containers/deploy-from-cli.tsx (A)
components/containers/containers-table.tsx (M)
```

#### MCPs (4)

```
app/dashboard/mcps/page.tsx (M)
app/dashboard/mcps/mcps-page-wrapper.tsx (A)
app/dashboard/mcps/mcps-section.tsx (A)
components/mcps/index.ts (D)
components/mcps/mcps-page-client.tsx (D)
```

#### Agents & My Agents (7)

```
app/dashboard/my-agents/my-agents.tsx (M)
components/agents/agent-card.tsx (A)
components/agents/index.ts (A)
components/my-agents/character-filters.tsx (M)
components/my-agents/character-library-grid.tsx (M)
components/my-agents/character-library-card.tsx (D)
components/my-agents/empty-state.tsx (M)
```

#### API Explorer (4)

```
app/dashboard/api-explorer/page.tsx (M)
components/api-explorer/auth-manager.tsx (M)
components/api-explorer/endpoint-card.tsx (M)
components/api-explorer/openapi-viewer.tsx (M)
```

#### Misc Components (8)

```
components/builders/quick-create-dialog.tsx (M)
components/chat/build-mode-assistant.tsx (M)
components/chat/eliza-chat-interface.tsx (M)
components/billing/credit-pack-card.tsx (M)
components/image/image-generator-advanced.tsx (M)
components/invoices/invoice-detail-client.tsx (M)
components/video/video-page-client.tsx (M)
docs/PENDING-FEATURES.md (A)
```

---

## Execution Steps

### Step 1: Merge PR #1

Wait for `ui/foundation-auth-landing` to be reviewed and merged into dev.

### Step 2: Create PR #2 Branch

```bash
# After PR #1 is merged:
git checkout dev && git pull origin dev
git checkout -b ui/dashboard-redesign

# Checkout all remaining files from redesign branch
git checkout ui/redesign-dashboard -- \
  app/layout.tsx \
  app/dashboard/layout.tsx \
  app/dashboard/(chat-build)/layout.tsx \
  app/dashboard/page.tsx \
  app/dashboard/api-explorer/page.tsx \
  app/dashboard/apps/ \
  app/dashboard/containers/ \
  app/dashboard/mcps/ \
  app/dashboard/my-agents/ \
  components/layout/sidebar.tsx \
  components/layout/sidebar-data.ts \
  components/layout/sidebar-item.tsx \
  components/layout/sidebar-section.tsx \
  components/layout/header.tsx \
  components/layout/chat-header.tsx \
  components/layout/chat-sidebar.tsx \
  components/layout/sidebar-chat-rooms.tsx \
  components/layout/user-menu.tsx \
  components/dashboard/ \
  components/agents/ \
  components/api-explorer/ \
  components/app-builder/ \
  components/apps/ \
  components/billing/credit-pack-card.tsx \
  components/builders/quick-create-dialog.tsx \
  components/chat/ \
  components/containers/ \
  components/image/image-generator-advanced.tsx \
  components/invoices/invoice-detail-client.tsx \
  components/mcps/ \
  components/my-agents/ \
  components/promotion/promote-app-dialog.tsx \
  components/video/video-page-client.tsx \
  db/repositories/apps.ts \
  lib/actions/dashboard.ts \
  lib/app-builder/markdown-components.tsx \
  docs/PENDING-FEATURES.md

# Handle deleted files
git rm components/mcps/index.ts components/mcps/mcps-page-client.tsx components/my-agents/character-library-card.tsx

git add .
git commit -m "feat: Dashboard UI redesign

- Update sidebar and header components
- Redesign dashboard home page with survey banner
- Update apps pages and components
- Update app builder UI
- Update containers and MCPs pages
- Update agents and my-agents components
- Update API explorer components
- Misc component styling updates

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push -u origin ui/dashboard-redesign
gh pr create --base dev --title "feat: Dashboard UI Redesign" --body "$(cat <<'EOF'
## Summary
- Complete dashboard UI redesign (70 files)
- Updated sidebar, header, and layout components
- Redesigned all dashboard pages (home, apps, containers, MCPs, agents)
- Updated app builder and API explorer components
- Misc component styling updates

## Depends On
- PR #1 (Foundation + Auth + Landing) must be merged first

## Test Plan
- [ ] `bun install` succeeds
- [ ] `bun run build` succeeds
- [ ] No TypeScript errors
- [ ] Visual inspection of all dashboard pages
- [ ] Sidebar navigation works correctly
- [ ] All page layouts render properly

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification Checklist

### Per PR

- [ ] `bun install` succeeds
- [ ] `bun run build` succeeds
- [ ] No TypeScript errors
- [ ] Visual inspection of affected pages
- [ ] No missing imports

---

## Notes

- PR #2 should only be created **after PR #1 is merged** to avoid conflicts
- Delete `docs/PR-SPLIT-PLAN.md` after both PRs are merged (it contains the old 8-PR plan)
