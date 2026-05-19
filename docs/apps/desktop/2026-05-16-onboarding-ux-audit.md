# Onboarding UX Audit — `enoomian/shell-foundation`

- **Date**: 2026-05-16
- **Branch**: `enoomian/shell-foundation` (off `upstream/shaw/eliza-app-release-blockers @ 5d5545f2b5`)
- **Built from**: Eliza App, `packages/app` (built via `vite build` with `@vitejs/plugin-react-swc` + `import React from "react"` workaround)
- **Served**: custom Bun static server at `http://localhost:5173/` against `packages/app/dist/`
- **Viewports tested**: 1280×800 (desktop), 375×812 (mobile)
- **Backend**: none — voice API + persistence fetches all fail. Items tagged `[NO-BACKEND]` are only listed where they reveal UX gaps (e.g., no error recovery affordance); the underlying 404 itself isn't counted.

## Severity legend

- **P0** — Blocks completion of the step, or breaks accessibility law (WCAG A failures)
- **P1** — Damages the experience meaningfully; first thing to fix after P0
- **P2** — Visible roughness; should fix before public release
- **P3** — Polish; nice-to-have / brand consistency

## Top-line summary

The onboarding flow renders end-to-end (Steps 1–7 → Hello launcher → Setup screen) and reaches the cloud/on-device choice. Underneath the surface there are **systemic problems** that affect every screen, plus **per-screen issues** ranging from a hardcoded developer name in a production input to invisible text caused by a `text-black` class clashing with the `~#050506` near-black background.

### Cross-cutting issues (apply to most/all screens)

| # | ID | Severity | Issue |
|---|---|---|---|
| X1 | `theme.text-black-on-near-black` | **P0** | Outer onboarding shell sets `class="… text-black"` on `pre-agent-cloud-shell`, so every text child without an explicit `text-*` class inherits `color: rgb(0,0,0)`. Body background is `rgb(5,5,6)`. The h2 "Welcome", h2 "Device check", h2 "Models", h2 "Listen", h2 "Speak", h2 "Owner", h2 "Family", and the long body paragraphs all compute black-on-near-black — **contrast ~1:1, WCAG AA needs 4.5:1**. Cause: see `[data-testid="pre-agent-cloud-shell"]`'s `text-black` Tailwind utility. Fix: drop `text-black` and let the theme `text-foreground` (or `text-txt`) take over, OR move the dark backdrop out from under a light-mode container. |
| X2 | `a11y.no-h1` | **P0** | Steps 1–7 use `<h2 data-testid="voice-prefix-step-name">` as the page heading. There is no `<h1>` in the onboarding flow until the **Setup** screen. Screen readers and document-outline tools treat each step as a section without a parent. Fix: either promote the per-step heading to `<h1>` (it changes per step, that's fine) or render a hidden `<h1>` like "Eliza onboarding". |
| X3 | `a11y.no-focus-visible-token` | ~~P0~~ **NEEDS REAL-KEYBOARD TEST** | All onboarding buttons use Tailwind `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. Token check on the live build: `--ring` resolves to `#ff8a24` (brand orange) against `--bg: #050506` (near-black) — that's ~7:1 contrast, which would meet WCAG AAA for non-text. The audit downgraded this to "needs real-keyboard test" because the synthetic eval (programmatic `.focus()` + dispatched `KeyboardEvent`) does not trigger `:focus-visible` in Chromium, so the runtime style under actual Tab navigation could not be confirmed from the preview tools. Manual verification step: in Chrome, Tab through the onboarding buttons and confirm the orange ring renders against the dark background. If it doesn't, define a dedicated `--ring-shell` token (e.g. `var(--brand-white)`) for the shell-foundation overlay layer. |
| X4 | `a11y.step-not-progressbar` | **P1** | The "Step N of 7" indicator is a plain `<span data-testid="voice-prefix-progress">` inside `<header>`. No `role="progressbar"`, no `aria-valuenow`/`aria-valuemax`, no `aria-live` on the wrapper, so a screen reader user who advances by clicking Continue gets no announcement that the step changed. Fix: add `role="progressbar" aria-valuenow={N} aria-valuemax={7} aria-valuetext="Step N of 7"`, OR wrap the step heading in an `aria-live="polite"` region. |
| X5 | `a11y.no-main-landmark-on-launcher` | **P1** | The Hello / Tap-to-begin launcher renders a `<div>` shell only — no `<main>`, no headings. A screen reader user hits this screen and gets "Tap to begin, button" with no context. Fix: use `<main>` and either a visible or `sr-only` heading like "Wake your agent". |
| X6 | `forms.buttons-as-submit` | **P1** | Every onboarding step's action buttons are `type="submit"` (`voice-prefix-back`, `voice-prefix-continue`, `voice-prefix-welcome-request-mic`, `Confirm OWNER`, `Play greeting`, `Record 5 s sample`, `Skip`). They are *not* inside a `<form>` that POSTs anywhere, but `type="submit"` still triggers any enclosing form's submit handler and is the default action for the first such button when Enter is pressed. On Step 1, hitting Enter triggers "Grant microphone access" rather than the intuitive "Continue". Fix: `type="button"`. |
| X7 | `i18n.british-vs-american` | **P3** | "recognise" appears in Step 4 and Step 7 ("to recognise your voice"). The rest of the app uses US English ("Confirm OWNER", "Sign in"). Pick one and lint for it. |
| X8 | `responsive.card-position-mobile` | **P2** | At 375×812 viewport, the onboarding card is offset toward the left edge of the viewport rather than centered. The outer wrapper applies `items-center justify-center` but the inner card's `max-w-xl` is wider than 375px and clips. Visual: see Step 1 mobile screenshot. Fix: drop or reduce `max-w-xl`, use `w-full max-w-[100%-2rem]` on small viewports. |
| X9 | `responsive.desktop-wasted-space` | **P2** | At 1280×800 the entire onboarding card occupies a narrow strip ~510px wide in the middle of the viewport. The body video background is faintly visible behind. On a desktop monitor this feels phone-shaped and inflicts long thin reading lines or, conversely, lots of empty surface. Fix: at desktop breakpoint either widen the card, OR commit to a fullscreen layout, OR clearly center+style as a modal. |
| X10 | `a11y.video-not-aria-hidden` | **P2** | The decorative `<video>` (poster `/clouds/poster.jpg`, src `/clouds/clouds_8x_480p.webm`) on the Hello launcher and as the onboarding backdrop has no `aria-hidden="true"`. Assistive tech may try to surface it. Fix: `aria-hidden="true"` on decorative video; or wrap in `<div role="presentation">`. |
| X11 | `html.dir-missing` | **P3** | `<html lang="en">` is set ✓ but `<html dir>` is empty. Should be `dir="ltr"` explicitly so future RTL work has a clean baseline. |
| X12 | `a11y.no-aria-live-for-errors` | **P1** | Error states like Step 5 "Voice profiles endpoint unavailable" render as a plain `<p class="text-xs text-warn">` with no `role="alert"` and no `aria-live`. Screen readers will miss them entirely. Fix: add `role="alert"` (or wrap in `aria-live="assertive"`) on any failure message. |
| X13 | `errors.raw-api-paths-leaked` | **P1** | Error copy on Step 5: `Voice profiles endpoint unavailable: /api/voice/onboarding/profile/start`. Showing an internal route to a user is sloppy. Fix: human-readable error ("We couldn't reach the voice service. Try again or skip for now.") plus a Retry / Skip affordance. |
| X14 | `forms.unlabeled-inputs` | ~~P0~~ **MISDIAGNOSED** | Inputs on Step 6 (Display name) and Step 7 (Name, Relationship) appeared unlabeled in the initial DOM probe (`label[for=""]`, `input` with no `id`). On re-reading the source, the inputs are **nested inside their `<label>` element** (e.g. `<label className="flex flex-col gap-1">Display name <input … /></label>`), which is a valid implicit-label association recognised by all major screen readers. No fix required. Keeping the entry for traceability. (Could still improve by adding explicit `id`/`htmlFor` for redundancy.) |
| X15 | `forms.no-form-validation-state` | **P2** | None of the inputs have `required`, `aria-invalid`, or `aria-describedby` wiring for help/error text. There is no client-side validation surface at all. Fix: per-field validation with `aria-describedby` linking to the help/error node. |
| X16 | `buttons.continue-always-enabled` | **P1** | The Continue button is enabled on every step, including before required actions are taken (mic permission on Step 1, recording on Step 5, voice profile on Step 5). Users can race past required steps. Fix: gate Continue on a `stepState` machine; only allow advance when the step's invariant is satisfied (or label it Skip explicitly). |
| X17 | `theme.color-scheme-not-declared` | **P2** | `<html>` and `<body>` have no `color-scheme: dark` declaration. Form controls, scrollbars, and native UI render in light-mode chrome over the near-black backdrop. Fix: `:root { color-scheme: dark; }` (or dynamic). |

---

## Per-screen audit

### Step 1 of 7 — Welcome / Grant mic access

**Mockup intent**: Brief intro, ask for mic permission, advance.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 1.1 | `welcome.h2-invisible` | P0 | `<h2 data-testid="voice-prefix-step-name">Welcome` computes `color: rgb(0,0,0)` against body `rgb(5,5,6)`. Visually black-on-black. | Remove the outer `text-black`; use theme `text-foreground`/`text-txt`. (See **X1**.) |
| 1.2 | `welcome.p2-invisible` | P0 | The second `<p>` ("You'll talk to your agent…") also computes black. | Same root cause as 1.1. |
| 1.3 | `welcome.continue-skips-mic` | P1 | Continue button is enabled before the user grants microphone permission. Tapping it advances to Step 2 with no permission acquired, defeating the step's purpose. | Disable Continue until `navigator.permissions.query({name:'microphone'})` is `granted` OR rename to "Continue without mic". (See **X16**.) |
| 1.4 | `welcome.back-enabled-on-step-1` | P1 | "Back" is enabled even though Step 1 is the first step in the wizard. Clicking does nothing visible. | Hide or disable Back on Step 1. |
| 1.5 | `welcome.button-hierarchy` | ~~P1~~ **RESOLVED BY X16** | "Grant microphone access" is full-width (476px) with the brand-orange treatment. "Continue" is small (91px) with the same orange treatment. Two visually identical primary buttons compete; users will not know which is "the" action. | With X16 applied, Continue starts disabled (opacity 0.5, 86px) until the user grants/denies mic access. The mic button (opacity 1, 476px) is the only visually live action on first paint, which produces the correct hierarchy as a side effect. No additional fix needed. |
| 1.6 | `welcome.buttons-submit-type` | P1 | All three buttons (`Grant microphone access`, `Back`, `Continue`) are `type="submit"`. | `type="button"`. (See **X6**.) |
| 1.7 | `welcome.copy-redundant` | P3 | Subtitle "Grant mic access and meet your agent." restates the step header "Welcome" + the CTA. The longer paragraph then says the same thing a third way. | Tighten to two sentences max. |
| 1.8 | `welcome.no-link-to-privacy` | P2 | Asking for mic permission with no link to a privacy explanation ("what we do with your audio") is below modern consent UX standards. | Add an inline link to the privacy note before the user grants permission. |
| 1.9 | `welcome.no-skip-affordance` | P2 | There is no obvious "Use text-only" path for users who cannot or do not want to grant mic permission, even though the app technically supports typed input. | Add a tertiary "Use text only" link. |

**Screenshot (mobile, 375×812):** see commit history; "Welcome" header, "You'll talk to your agent…" body text both nearly invisible against the dark card.

---

### Step 2 of 7 — Device check

**Mockup intent**: Tell the user their hardware is OK to run voice.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 2.1 | `devicecheck.h2-invisible` | P0 | "Device check" h2 — black-on-near-black. | See **X1**. |
| 2.2 | `devicecheck.no-detail` | P1 | The "GOOD" badge + "Your device can run the full voice stack." asserts a verdict but doesn't show what was tested (CPU/GPU/RAM/network), so a user with concerns can't audit. Verdict appears instant (no actual probe visible) — possibly hardcoded. | Show 2–3 measured rows (e.g. "Apple M2 — fast", "16 GB RAM — fast", "Bun runtime — present") with green checks. |
| 2.3 | `devicecheck.no-warn-or-fail-state` | P2 | Only a "GOOD" badge is shown; the doc doesn't reveal how "OK"/"slow"/"unsupported" verdicts render. Without seeing those states it's impossible to confirm they are usable. | Add Storybook stories for all device-check verdicts. |
| 2.4 | `devicecheck.copy-soft-claim` | P3 | "Expect roughly half a second between when you stop talking and when the agent starts responding." — a *measurable* number that, if wrong, undermines trust. If this number isn't actually measured per-device, replace with a range. | "Expect under a second of latency" or measure-and-report. |
| 2.5 | `devicecheck.buttons-submit-type` | P1 | Back + Continue are submit. | `type="button"`. (See **X6**.) |
| 2.6 | `devicecheck.back-returns-to-fresh-step1` | P1 | Pressing Back returns to Step 1 in a fresh state, losing the user's progress on Step 1 (e.g., mic-permission state). | Persist per-step state in the step machine. |

---

### Step 3 of 7 — Models (OPTIONAL)

**Mockup intent**: Optionally download voice models.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 3.1 | `models.h2-invisible` | P0 | "Models" h2 black-on-dark. | See **X1**. |
| 3.2 | `models.copy-jargon` | P2 | "Downloading the voice bundle (ASR, turn detector, emotion classifier, speaker encoder, VAD, wake-word, Kokoro voice)." dumps seven acronyms on a first-time user. | Move the acronym list to a "What's in this bundle?" disclosure; keep the headline plain. |
| 3.3 | `models.optional-shown-thrice` | P3 | "OPTIONAL" appears in the header badge AND in the step subtitle AND implicitly in the Skip button. | Pick one signal. |
| 3.4 | `models.no-progress-ui` | P1 | The copy says "the model panel in Settings shows progress" but the step itself shows no progress, ETA, size, or completion state. Without backend it's stuck at "Downloading…". | Render an inline progress bar with bytes downloaded / total and ETA; on completion advance the Continue button visual state. |
| 3.5 | `models.no-disk-or-network-warn` | P2 | The voice bundle is large enough to matter (multiple GB?) but no size estimate, no network/Wi-Fi check, no cellular warning. | Show total size up front; warn on cellular if mobile. |
| 3.6 | `models.skip-vs-continue` | P1 | Both Skip and Continue advance past the step. The only difference would be whether download starts in the background — but there's no visual confirmation of that. | Replace Continue with "Download in background" so the buttons communicate distinct outcomes. |
| 3.7 | `models.buttons-submit-type` | P1 | Back, Skip, Continue are all submit. | `type="button"`. (See **X6**.) |

---

### Step 4 of 7 — Listen

**Mockup intent**: Let the user hear the agent's voice.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 4.1 | `listen.h2-invisible` | P0 | "Listen" h2 black-on-dark. | See **X1**. |
| 4.2 | `listen.play-no-audio-element` | P2 | "Play greeting" button is present but no `<audio>` element is in the DOM and no inline player UI shows what's playing or how to stop. | Render an `<audio>` with controls or a custom player; show "Playing… / Stop" state. |
| 4.3 | `listen.play-button-submit-type` | P1 | "Play greeting" is `type="submit"`. | `type="button"`. (See **X6**.) |
| 4.4 | `listen.continue-without-listening` | P2 | Continue is enabled without the user having clicked Play. The step is named "Listen" but listening is optional in practice. | Either gate Continue on first play OR rename to "Choose your voice". |
| 4.5 | `listen.voice-not-chooseable` | P2 | Copy says "in the voice you selected" — but the user has not selected a voice up to this point. Implicit selection from device locale? Unclear. | Add a voice picker (3–5 options) or remove the "you selected" claim. |
| 4.6 | `listen.british-spelling` | P3 | "to recognise your voice" — see **X7**. |
| 4.7 | `listen.greeting-copy-leaks-state` | P3 | "I need to learn how you sound" is the agent revealing its onboarding model. Talk in user-language ("Eliza will learn your voice during Step 5"). |

---

### Step 5 of 7 — Speak

**Mockup intent**: User records three prompts for voice-profile training.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 5.1 | `speak.h2-invisible` | P0 | "Speak" h2 black-on-dark. | See **X1**. |
| 5.2 | `speak.raw-api-error` | P1 | The error copy is literally `Voice profiles endpoint unavailable: /api/voice/onboarding/profile/start`. Shows internal route. (See **X13**.) | Replace with friendly copy + Retry button. |
| 5.3 | `speak.error-no-aria-live` | P1 | The error `<p class="text-xs text-warn">` is not announced by screen readers (no `role="alert"`, no `aria-live`). (See **X12**.) | `role="alert"` on the error element. |
| 5.4 | `speak.continue-while-failed` | P1 | Even with the voice-profile endpoint unavailable, Continue is enabled and lets the user skip this required step silently. (See **X16**.) | Block Continue, or split into "Skip and continue" with explicit copy. |
| 5.5 | `speak.preparing-no-timeout` | P2 | "Preparing capture session…" spinner with no timeout, no retry, no fallback. If the backend is unreachable it stays forever. | Time out after 5s and surface a Retry. |
| 5.6 | `speak.no-record-ui-without-backend` | P2 | No microphone-level visualization, no waveform, no "X seconds remaining" appears in the step. We can't audit the recording UX because it gates on a backend response. | Mock the recording UX in Storybook so the local-only Flow is testable. |
| 5.7 | `speak.buttons-submit-type` | P1 | Back + Continue are submit. | `type="button"`. (See **X6**.) |

---

### Step 6 of 7 — Owner

**Mockup intent**: User confirms they are the OWNER role.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 6.1 | `owner.hardcoded-name-shaw` | **P0** | The "Display name" `<input>` ships with `value="Shaw"` baked in. **This is a developer's personal name leaking into production**. Any user opening Step 6 sees a stranger's name pre-filled. | Default to empty or to OS account name. Track down the source (likely `loadOwnerProfile`/storage default or a dev seed). |
| 6.2 | `owner.input-unlabeled` | P0 | "Display name" `<label>` has `for=""`; input has no `id`, no `name`, no `aria-label`. Screen readers will not announce a label. (See **X14**.) | `<label htmlFor={id}>Display name</label>` + matching `id` on input. |
| 6.3 | `owner.three-button-confusion` | P1 | The step has three primary-ish buttons in the action row: **Confirm OWNER**, **Back**, **Continue**. Users won't know which one finalizes the step or what Continue does *without* confirming. | Pick one action button. Confirm = primary. Continue can disappear or live inside the Confirm button text. |
| 6.4 | `owner.copy-all-caps-OWNER` | P3 | "You are the OWNER." with OWNER in caps in body copy is jarring (caps for role badges is fine, caps for inline nouns isn't). | "You are the owner." (or pull "Owner" out to its own visual badge). |
| 6.5 | `owner.copy-presumptuous` | P3 | "You are the OWNER. The agent will only execute privileged actions for you." presumes the person on the device IS the owner. Shared devices exist. | Frame as a choice: "Are you the owner of this device?" with [Yes, that's me] / [No, I'm a guest]. |
| 6.6 | `owner.no-explanation-of-owner-role` | P2 | "Privileged actions" is hand-wavy. What actions? Why does it matter? | One-sentence inline help or a "What can the owner do?" disclosure. |
| 6.7 | `owner.h2-invisible` | P0 | "Owner" h2 black-on-dark. | See **X1**. |
| 6.8 | `owner.buttons-submit-type` | P1 | All three buttons are submit. | `type="button"`. (See **X6**.) |

---

### Step 7 of 7 — Family (OPTIONAL)

**Mockup intent**: Add other voices the agent should recognize.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| 7.1 | `family.h2-invisible` | P0 | "Family" h2 black-on-dark. | See **X1**. |
| 7.2 | `family.inputs-unlabeled` | P0 | Both inputs (Name, Relationship) have no `id`/`name`/`aria-label`; labels are `for=""`. (See **X14**.) | Wire `id` ↔ `htmlFor`. |
| 7.3 | `family.relationship-prefilled-family` | P2 | The Relationship input ships with `value="family"` pre-filled. Surprising default — users might submit without realizing. | Empty by default, with placeholder "family, colleague, …" as it already has. |
| 7.4 | `family.optional-shown-thrice` | P3 | "OPTIONAL" in header badge + "(optional)" in subtitle + "Optional: introduce other people…" in body. | Pick one. |
| 7.5 | `family.skip-vs-continue` | P1 | Skip and Continue both advance past the step without any added person. The semantic difference is unclear. | Merge into a single "Skip / Continue" button whose label changes based on form state. |
| 7.6 | `family.record-disabled-no-explanation` | P1 | "Record 5 s sample" is disabled with no inline reason (presumably backend unavailable). User cannot diagnose. | Inline tooltip "Voice service unavailable — try again in a moment." |
| 7.7 | `family.no-list-affordance` | P2 | "No additional people captured yet." is the empty state. There's no visible "Add another" button, no list rendering, so the multi-add flow isn't discoverable. | Always render an empty list with an "Add person" button as the primary affordance. |
| 7.8 | `family.copy-name-vs-relationship-order` | P3 | The sample prompt copy ("Hi, I'm a regular user of this device…") appears as a static instruction rather than a per-person template, but the step asks the user to record a sample. Confusing relationship between the quote and the action. | Treat the quote as a "read this aloud" template only when recording, and tie it to the active person. |
| 7.9 | `family.buttons-submit-type` | P1 | Back, Skip, Continue, Record are all submit. | `type="button"`. (See **X6**.) |

---

### Hello / Tap to begin (launcher)

**Mockup intent**: Welcoming, ambient, primary CTA to wake the agent.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| H.1 | `hello.no-headings` | P0 | No `<h1>`, no `<h2>`, no `<main>`. "Hello" is a `<div class="eliza-ob-hello-word">` styled at 104px. | Make it an `<h1>` (with `<main>` as the wrapping landmark). |
| H.2 | `hello.video-not-aria-hidden` | P2 | The decorative cloud video has no `aria-hidden="true"`. (See **X10**.) | Add. |
| H.3 | `hello.tap-button-no-focus-style` | P1 | Inspected button shows `outline: 0px` and no obvious focus ring on tab. Keyboard users cannot tell focus is on it. (See **X3**.) | Add a focus-visible ring with explicit contrast. |
| H.4 | `hello.copy-mobile-only-language` | P3 | "Tap to begin" assumes a touch device. On desktop, "Click" or "Press to begin" would be more correct. | Conditional copy or "Continue" / "Begin". |
| H.5 | `hello.no-skip-or-back` | P2 | The launcher gives no way to go back into onboarding to re-configure a setting. Users who realize they made a mistake in Step 6 are stuck. | Add a small "Onboarding" link in a corner, OR ensure Settings can re-trigger onboarding. |
| H.6 | `hello.no-accessibility-route` | P2 | No keyboard equivalent for "Tap" beyond focusing the button. There is no described shortcut (e.g., spacebar wake). | Document keyboard equivalents inline or via a hidden help dialog. |

---

### Setup screen — Choose Cloud vs On-Device

**Mockup intent**: Pick where Eliza runs.

| # | ID | Sev | Issue | Recommendation |
|---|---|---|---|---|
| S.1 | `setup.lang-buttons-not-buttons` | P1 | The four language entries (🇺🇸 English / 🇪🇸 Spanish / 🇯🇵 Japanese / 🇰🇷 Korean) appear in `rootText` but query for buttons/roles returns nothing — they are not focusable, not labelled, and likely render as text+emoji only. | Wire them as `<button>` or `<input type="radio">` with proper labels. |
| S.2 | `setup.flag-as-language` | P2 | Flags are not languages: 🇺🇸 for "English" excludes English-as-spoken-everywhere-else; 🇪🇸 for Spanish excludes ~half a billion Spanish speakers in the Americas. Standard i18n guidance is to avoid flags for language. | Use ISO language codes + native-language names: "English", "Español", "日本語", "한국어". |
| S.3 | `setup.choice-no-aria-pressed` | P1 | The two big choice tiles (`Cloud`, `On-Device`) communicate selection via a `.selected` CSS class but have no `aria-pressed` or `aria-checked`. Screen readers won't know which is selected. | Use `<button aria-pressed={selected}>` or `<input type="radio">`. |
| S.4 | `setup.copy-grammar-fewer` | P3 | "Running in the cloud means I have a lot less limitations around what I can do." — should be "**fewer** limitations" (countable). | Edit. |
| S.5 | `setup.button-title-case-inconsistent` | P3 | "Connect To Remote Instance" uses Title Case; "Continue" uses Sentence case; "Cloud" / "On-Device" mix. | Pick one (sentence case is the modern default). |
| S.6 | `setup.no-h2-or-instructions` | P2 | There's no h2 grouping the two tiles, and no explicit instruction like "Pick where Eliza runs". The agent's first-person blurb ("I recommend cloud…") substitutes for an instruction, which conflates voice. | Add a neutral h2 "Where should Eliza run?" plus the agent commentary below. |
| S.7 | `setup.remote-instance-cta-mystery` | P2 | "Connect To Remote Instance" is a tertiary button but isn't obviously different from On-Device. It implies BYOI servers but isn't explained. | Demote to "Advanced: connect to a remote instance" with a link icon, or hide behind a disclosure. |
| S.8 | `setup.cloud-implies-account` | P2 | "Cloud — Sign in and start talking." promises an account flow but no sign-in surface is shown on this screen. Users may not know they're about to sign in. | Either inline the sign-in (Google/Apple/etc.) on selection, or change copy to "Cloud — Account required." |
| S.9 | `setup.agent-voice-recommendation` | P3 | "I recommend cloud for your device" — the agent is making a recommendation based on what? Earlier the Device check said the device could run the *full* voice stack, contradicting this recommendation. | Either cite a reason ("…because your device has less than 8 GB RAM" / "…because cloud is faster for first-time use") or remove the recommendation. |

---

## Summary table

| Severity | Count |
|---|---|
| P0 | **14** (theme-text-black + 7× h2 invisible + 3× unlabeled-input groups + 1× hardcoded "Shaw" + h1-missing + no-focus-token + no-headings-on-launcher) |
| P1 | 27 |
| P2 | 19 |
| P3 | 14 |

(Per-step counts overlap with cross-cutting issues; the table double-counts where an issue manifests on each step.)

---

## Recommended fix order

1. **X1 (`text-black` on shell wrapper)** — single change unblocks ~7 of the P0 contrast issues at once.
2. **X14 (unlabeled inputs)** — three input groups need `id`/`htmlFor`. Quick win for P0 a11y.
3. **6.1 (hardcoded "Shaw")** — production-critical defaults bug. Single-file edit once located.
4. **X3 (focus token)** — define a high-contrast focus ring; affects every button on every screen.
5. **X2 (no h1) + H.1 (no landmarks on launcher)** — semantic landmarks for a11y compliance.
6. **X6 (buttons-as-submit) + X16 (continue-always-enabled)** — change `type` and gate the step machine; affects every step.
7. **X12 + X13 (error a11y + raw API leakage)** — fix on Step 5 specifically, then audit other failure surfaces.
8. **S.1 + S.3 (Setup screen interactive elements not real buttons)** — broken interaction model on the most important post-onboarding decision.

Everything else is per-step polish that can ride in subsequent PRs.

---

## What this means for the shell-foundation work

The shell foundation spec (sibling doc: [`2026-05-16-shell-foundation-design.md`](./2026-05-16-shell-foundation-design.md)) is **additive** to this onboarding surface — `HomePill`/`AssistantOverlay`/`ChatSurface` mount as siblings to `StartupShell` and do not modify these screens. The audit findings here are mostly inherited bugs in **Shaw's onboarding work**, not blockers for our shell-foundation effort.

That said, two of the cross-cutting issues directly affect our spec:

- **X1 (text-black) + X3 (focus token)** — our new components must avoid both anti-patterns from day one. We'll use explicit `text-foreground` / `text-txt` and define a high-contrast focus ring token in the design.
- **X4 (step a11y)** — our state machine should expose a similar `aria-live`/`role` pattern so the pill state changes are announced. Mirror what we recommend for the step indicator.

Suggested cadence: file the cross-cutting fixes (X1–X16) as their own follow-up PR(s) against Shaw's branch BEFORE we layer the home pill — that way the shell foundation lands on a cleaner base. Alternative: land shell-foundation first, file these as parallel work.
