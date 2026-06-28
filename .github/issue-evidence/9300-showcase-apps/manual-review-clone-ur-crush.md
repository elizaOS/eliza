# Aesthetic + UX review — Clone Ur Crush (`packages/examples/cloud/clone-ur-crush`)

**Verdict: `good`** (after two rounds of no-blue fixes + a static brand-lint that
now guards against regression — see below) · reviewed live (desktop 1280×900 +
mobile 390×844) on `next dev`, agent (Claude) screenshot + critique, plus a real
Docker-image smoke test. Human sign-off: _pending_ (see contact sheet).

Screenshots: [`clone-ur-crush-desktop.png`](clone-ur-crush-desktop.png) ·
[`clone-ur-crush-desktop-step2.png`](clone-ur-crush-desktop-step2.png) ·
[`clone-ur-crush-mobile.png`](clone-ur-crush-mobile.png)

## Final HTML output

A glassmorphic multi-step onboarding card floating over a blurred lifestyle
photo. Step 1: a "Clone Your Crush" gradient wordmark, a "What's her name?" input
with an inline random-name (dice) action, a 5-step progress indicator, and a
"Next →" CTA. Step 2: "Tell me about her" with a "✨ Generate" action and a
description field, plus "← Back" / "Next →".

## Brand / color — TWO rounds of fix; now guarded by an automated lint

- **Round 1 (token fix) was incomplete — a real correction.** The first "no-blue"
  pass only recolored the Tailwind `accent` token (`#3f51b5` indigo → `#9c27b0`
  purple in `tailwind.config.ts`) and the `.gradient-text` CSS (`app/globals.css`).
  That review then claimed "post-fix the gradient carries no blue-dominant stop"
  and verdict `good` — **but that was wrong**: three JSX components hardcoded
  literal `blue-*` Tailwind utilities that never used the token, so the app still
  shipped blue. A second adversarial audit (#9300) caught them:
  - `app/page.tsx:451` — `from-blue-500/10` (full-viewport ambient overlay)
  - `app/page.tsx:478` — active progress dot `from-blue-500 to-pink-500`
  - `app/cloning/page.tsx:188` — page background `… to-blue-50`
- **Round 2 (the real fix, this pass):** those three are now `fuchsia`/`purple`
  (`from-fuchsia-500/10`, `from-purple-500`, `to-fuchsia-50`). A repo-wide grep
  for `(from|via|to|bg|text|border|ring|fill|stroke)-(blue|sky|cyan|indigo)-\d`
  across `app/` returns **zero** live hits (the only remaining match is a code
  comment that says "zero blue").
- **Guarded so it can't regress.** A static brand-lint spec
  (`packages/test/cloud-e2e/tests/showcase-brand-lint.spec.ts`) now greps both
  apps for blue-family utilities + indigo hex and **fails** with the offending
  `file:line`. It runs in the per-PR cloud-e2e lane (whose path filter now
  includes `packages/examples/cloud/**`) and the nightly showcase-mock job —
  verified to fail when a blue class is reintroduced. This is what makes the
  verdict trustworthy rather than a manual claim that already proved fallible.
- **Scope note:** Clone Ur Crush is a standalone consumer app with its own pink
  identity, not the Eliza Cloud dashboard (the strict orange-accent rule governs
  `cloud-frontend`). The change applies the **"no blue"** half of the rule and
  deliberately does NOT force the platform orange (wrong for this consumer app).
- The blurred background photograph contains blue denim — photographic content,
  not UI chrome (excluded from the lint).

## UX / flow (no dead ends)

- **Multi-step onboarding with two-way navigation:** step 1 → step 2 advances the
  progress indicator and exposes both Back and Next, so a user can never get
  stranded. Form state persists across reload (the name is retained), so a refresh
  doesn't lose progress.
- **Monetized action surfaced:** the "✨ Generate" control is the app's paid
  Eliza Cloud inference (character/scene/photo generation) — the revenue-driving
  action the showcase e2e loop bills + attributes to the creator. (Full keyed
  generation needs the app's provider/cloud keys; locally it is the action surface
  that's reviewed, with the real billed path covered by the e2e loop +
  `DEPLOY_AND_VALIDATE.md`.)
- **Responsive:** mobile (390×844) keeps the card, gradient title, input, and CTA
  fully on screen with no overflow or layout break.

## Console / network

- `0` console errors on load and through step 1 → step 2.

## Findings

- **[fixed]** indigo `#3f51b5` token in the brand gradient → no-blue purple
  `#9c27b0` (round 1).
- **[fixed]** three literal `blue-*` Tailwind classes still rendering blue
  (`page.tsx:451,478`, `cloning/page.tsx:188`) → `fuchsia`/`purple` (round 2),
  now guarded by `showcase-brand-lint.spec.ts`.
- **[fixed]** `app/layout.tsx` referenced `/og-image.png` that did not exist in
  `public/` (Open Graph/Twitter card 404) → added a brand-matched 1200×630
  `og-image.png` (pink→purple, no blue); the brand-lint asset check + the image
  smoke test both assert it serves.
- **[fixed]** the cloning-page redirect defaulted to `http://localhost:3000` when
  `NEXT_PUBLIC_ELIZA_CLOUD_URL` was unset (a localhost dead-end on a deployed
  container) → defaults to `https://www.elizacloud.ai` (`lib/constants.ts`,
  `next.config.ts`).
- **[fixed]** the showcase image published with no smoke-test gate AND a broken
  `/_next/static` path (Next standalone `distDir` mismatch → CSS/JS 404). The
  image build now copies static into the baked dist dir and a smoke gate asserts
  a `/_next/static` chunk + `og-image.png` serve `200` before push (verified in a
  real Docker image).
- Follow-up (nice-to-have): confirm the "✨ Generate" path renders a friendly
  inline error (the page already `alert()`s + recovers; an inline toast is polish).
