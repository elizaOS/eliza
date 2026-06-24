# Aesthetic + UX review — Clone Ur Crush (`packages/examples/cloud/clone-ur-crush`)

**Verdict: `good`** · reviewed live (desktop 1280×900 + mobile 390×844) on
`next dev`, agent (Claude) screenshot + critique. Human sign-off: _pending_
(see contact sheet).

Screenshots: [`clone-ur-crush-desktop.png`](clone-ur-crush-desktop.png) ·
[`clone-ur-crush-desktop-step2.png`](clone-ur-crush-desktop-step2.png) ·
[`clone-ur-crush-mobile.png`](clone-ur-crush-mobile.png)

## Final HTML output

A glassmorphic multi-step onboarding card floating over a blurred lifestyle
photo. Step 1: a "Clone Your Crush" gradient wordmark, a "What's her name?" input
with an inline random-name (dice) action, a 5-step progress indicator, and a
"Next →" CTA. Step 2: "Tell me about her" with a "✨ Generate" action and a
description field, plus "← Back" / "Next →".

## Brand / color

- **No blue UI chrome.** Adversarial computed-style scan (excluding the Next dev
  overlay) found **0** blue-dominant chrome elements. The background photograph
  contains blue denim — that is photographic content, not UI, and registers no
  blue computed color.
- **Accent = pink↔purple gradient** (wordmark, primary CTA, progress fill,
  Generate label). Clone Ur Crush is a standalone consumer creator app with its
  own deliberate identity — the Eliza Cloud "orange platform accent" rule governs
  the cloud dashboard (`cloud-frontend`), not a creator's own app. The discipline
  that DOES carry over — no stray blue chrome, one cohesive accent family, legible
  contrast, smooth hover — holds.

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

- None blocking. Follow-up (nice-to-have): confirm the "✨ Generate" path renders
  a friendly inline error (not a thrown 500) when the upstream provider balance is
  exhausted — `DEPLOY_AND_VALIDATE.md` already records the upstream 403→503 fix on
  the cloud side; a matching client-side toast would close the loop.
