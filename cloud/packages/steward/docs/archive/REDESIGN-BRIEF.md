# Steward.fi Redesign Brief

## Objective
Rebuild the entire frontend as a single Next.js app under `web/`. Merge the landing page and dashboard into one cohesive app with avant-garde design. This is for the Synthesis hackathon (March 13-22, 2026). The product is agent wallet infrastructure with policy enforcement.

## Architecture
- **Single app**: `web/` directory, Next.js 15, App Router
- Landing page at `/`
- Dashboard at `/dashboard` (and sub-routes like `/dashboard/agents`, `/dashboard/approvals`, etc.)
- Delete `packages/dashboard` entirely after migrating its routes

## Design Direction

### Aesthetic: Brutalist-Editorial Hybrid
Think: Bloomberg Terminal meets Virgil Abloh. Raw, typographic, information-dense but beautiful. Not the typical dark-mode-with-gradients crypto site.

### Typography
- **Display font**: Something with extreme character. Consider: Space Grotesk, Clash Display, Satoshi, Syne, or Unbounded. NOT Inter, NOT Roboto, NOT generic sans.
- **Body font**: Pair with something clean but not boring. Instrument Sans, Outfit, or a tight grotesque.
- **Use extreme type scale**: Hero text should be massive (8-12rem). Use fluid clamp() sizing.
- **Variable font weights for hierarchy**

### Color
- NOT the cyan-on-dark AI slop palette
- NOT purple-to-blue gradients
- Consider: Near-black background (#0a0a0a ish) with a sharp singular accent. Could be a warm tone (burnt orange, deep red) or an unexpected one (acid yellow, muted olive). ONE dominant accent, not a rainbow.
- Tint your neutrals. No pure gray. Warm or cool tinted grays.
- Use OKLCH for color definitions

### Layout
- Asymmetric compositions. Not everything centered.
- Break the grid intentionally for emphasis
- Generous whitespace. Let things breathe.
- No card-soup. Not every section needs a rounded rectangle container.
- Left-aligned text where it makes sense (not everything centered)
- Full-bleed sections for drama

### Motion (CRITICAL - use these)
- **Framer Motion** for all animations
- Staggered entrance animations on page load
- Scroll-triggered reveals
- Hover interactions that feel alive
- Use ease-out-quart/quint/expo timing, NOT bounce/elastic
- Parallax where it adds depth
- Consider: text that reveals character by character, elements that slide in from unexpected directions

### What NOT to do
- No emojis anywhere
- No gradient text on headings
- No glassmorphism
- No generic card grids (icon + heading + text repeated)
- No "Great question!" energy in copy
- No rounded rectangles with colored borders on one side
- No sparklines as decoration
- No hero metric layout template (big number, small label)
- No centered-everything layout
- No bounce/elastic easing

### Libraries to Install & Use
```
framer-motion          - all animations
@fontsource/syne       - display font (or similar distinctive font)
@fontsource/instrument-sans  - body font
```

Also look into:
- Custom cursor effects
- Noise/grain texture overlays (CSS)
- Scroll-driven animations (CSS scroll-timeline if supported, else Framer)

### Copy & Voice
- Direct, confident, no fluff
- No buzzwords unless earned
- Write like you're briefing someone smart, not selling to them
- Example: "Agent wallets. Policy enforcement. Self-hosted." not "Revolutionizing the future of AI agent finance"
- Technical but accessible

## Landing Page Sections

### 1. Hero
- Massive typography. The product name and a one-line description.
- Something visual that isn't a generic gradient blob. Could be:
  - An ASCII/monospace art piece
  - A real-time visualization (animated SVG of a policy evaluation flow)
  - A code snippet that types itself out showing the SDK
  - Generated artwork via fal.ai seedream (abstract, dark, architectural)
- CTA: GitHub link + Dashboard link

### 2. The Problem (brief)
- Why agents need wallets but raw keys are insane
- Keep it to 2-3 punchy lines

### 3. How It Works
- Visual flow: Agent requests tx -> Policy engine evaluates -> Approved/Queued/Rejected -> Signed if approved
- Could be an animated diagram, not a static image
- Or: SDK code snippets that are real and runnable

### 4. SDK Section
- Show the actual code. `createWallet`, `signTransaction`, `getPolicies`
- Syntax highlighted, with a typing animation or progressive reveal
- This is the selling point for Shaw/Eliza Cloud

### 5. For Platforms
- Brief pitch for why platforms should embed this
- Multi-tenant, webhook-driven, no per-tx rent
- Logos/names: Eliza Cloud, waifu.fun, eliza-cloud (styled as text, no actual logos needed)

### 6. Footer
- GitHub, steward.fi, hackathon link
- Minimal

## Dashboard Pages

### Layout
- Sidebar navigation (but make it interesting, not a generic sidebar)
- Or: top-nav with command-palette style navigation
- Dense information display. Think terminal aesthetic but with excellent typography.

### Pages to build:
1. **Overview** (`/dashboard`) - Key metrics, recent activity, quick actions
2. **Agents** (`/dashboard/agents`) - List + create. Show wallet addresses, balance, policy count
3. **Agent Detail** (`/dashboard/agents/[id]`) - Full agent view with transactions, policies, activity
4. **Approvals** (`/dashboard/approvals`) - Pending approval queue, approve/reject actions
5. **Transactions** (`/dashboard/transactions`) - Filterable transaction history across all agents
6. **Settings** (`/dashboard/settings`) - Connection config, webhook setup, SDK snippet

### Dashboard Design Notes
- Use `@stwd/sdk` for API calls (import from source, use `transpilePackages`)
- All client-side rendered (`"use client"`)
- Make empty states interesting (not just "nothing here" with an icon)
- Status indicators should be sharp and clear
- Address displays should be monospace + copyable
- Tables should feel more like data grids, less like Bootstrap tables

## Existing Code to Reference
- SDK client: `packages/sdk/src/client.ts`
- Shared types: `packages/shared/src/types.ts`
- Current dashboard utils: `packages/dashboard/src/lib/utils.ts` (address shortening, formatting helpers)
- Current dashboard API client: `packages/dashboard/src/lib/api.ts`

## Environment
- `NEXT_PUBLIC_STEWARD_API_URL` - API endpoint (default: http://localhost:3200)
- `NEXT_PUBLIC_STEWARD_API_KEY` - API key for auth
- `NEXT_PUBLIC_STEWARD_TENANT_ID` - Tenant ID

## Tech Constraints
- Next.js 15 with App Router
- React 19
- Tailwind CSS 3.x
- TypeScript strict
- Must work with Vercel deployment
- Part of Turborepo monorepo (workspace: `web`)
