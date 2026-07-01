# In-chat onboarding (chat-centric first-run) — design + work order

Closes the real intent of #9952 (and feeds #10198's walkthrough). The first
surface a fresh user sees is the **real floating chat over the homescreen**, with
the agent greeting + onboarding choices rendered as the SAME inline widgets the
live chat uses — not a separate full-screen wizard, and not a separate
chat-looking surface.

## What shipped before this (verified gap)

- `CompactOnboarding.tsx` was deleted (#10167), but first-run is still a
  **full-screen pre-shell gate**: `App.tsx:2122` (`!isShellPaintableNow →
  <StartupScreen/>`) → `StartupShell` (`view.kind === "first-run"`) →
  `StartupFirstRunBackground` → `FirstRunChat`. The chat shell never paints
  during first-run, so the agent is not the first surface.
- `FirstRunChat.tsx` is a **separate** `fixed inset-0` surface that hand-renders
  an `AgentBubble` transcript with `ChoiceWidget`/`CredentialRequestWidget` — a
  second chat-looking UI, not the live `ContinuousChatOverlay`.
- `useFirstRunController.ts` (1,454 LOC) is still a step machine; a **duplicate**
  provisioning path lives in `useFirstRunCallbacks.ts:runFirstRunChatHandoff`.
- A dedicated first-run **voice TTS/ASR** stack exists only for onboarding.
- No **tutorial-or-skip** step after onboarding.

## Target architecture

1. **Land in chat.** When `firstRunComplete=false`, the startup coordinator's
   `first-run-required` phase is **shell-paintable** (`startup-coordinator.ts`
   `isShellPaintable`) and `use-startup-shell-controller.ts` no longer forces a
   `first-run` view. The app mounts the homescreen + `ContinuousChatOverlay`,
   auto-opened.
2. **Seed onboarding into the live transcript.** A headless first-run conductor
   pushes synthetic assistant `ConversationMessage`s via `setConversationMessages`:
   greeting → `[CHOICE:first-run id=runtime]` (Cloud / Local / Other) → Cloud OAuth
   via the message `secretRequest` field → `[CHOICE:first-run id=provider]`
   (role-correct default pre-highlighted) → "other" → Settings handoff → final
   `[CHOICE:first-run id=tutorial]` (Take the tutorial / Skip). Widgets render for
   free via `InlineWidgetText` (`ContinuousChatOverlay:974`) + `SensitiveRequestBlock`.
3. **Display-only widgets, logic in a use case.** First-run-scoped choice
   `sendAction(value)` is intercepted and routed to the headless use case
   (the surviving `finishLocal`/`finishCloud`/`finishCloudWithSelection`/
   `selectOrProvisionCloudAgent`/`submitFirstRun` from `useFirstRunController`,
   plus `first-run-config.ts` defaults). One `POST /api/first-run`.
4. **Delete** `FirstRunChat.tsx`, the first-run startup phase +
   `StartupFirstRunBackground`, the dead `.eliza-onboarding-overlay-shell` CSS,
   the step/picker presentation, the duplicate `runFirstRunChatHandoff`, and the
   dedicated first-run voice stack (voice = normal chat voice).
5. **Test the whole walkthrough in chat** — deterministic "ideal" mock-LLM lane
   (seeded onboarding driven end-to-end + SSE-mock chat round-trip) AND a
   real-LLM scenario for the post-onboarding chat; per-step screenshots
   desktop+mobile + vision review; tutorial-or-skip exercised.

## Key seams (file:line)

- Floating chat + widget render: `components/shell/ContinuousChatOverlay.tsx:974`
  (`InlineWidgetText content={message.content}`), `:978` (`secretRequest`).
- CHOICE marker grammar: `components/chat/message-choice-parser.ts` —
  `[CHOICE:<scope> id=<id> allow_custom]\nvalue=label\n[/CHOICE]`; pick →
  `ctx.sendAction(value)`.
- Seed point: `state/ConversationMessagesContext.hooks.ts` `setConversationMessages`
  (functional form precedent at `state/useChatCallbacks.ts:644`).
- Startup gating: `state/startup-coordinator.ts` (`isShellPaintable` ~:463,
  phase union ~:41), `state/use-startup-shell-controller.ts:248-260` (`showFirstRun`),
  `App.tsx:1661/2122`.
- Use case to keep/move: `first-run/use-first-run-controller.ts`
  (`finishLocal` @562, `finishCloud` @933, `finishCloudWithSelection` @744,
  `selectOrProvisionCloudAgent` via client, `submitFirstRun` @544);
  `first-run/first-run-config.ts` (`defaultProviderForRuntime`, `needsProviderSetup`);
  `first-run/first-run.ts` (`buildFirstRunSubmitPlan`).
- Persist: `app-core/src/api/first-run-routes.ts:167` (POST /api/first-run, sets
  `meta.firstRunComplete`).
- Tutorial: `components/pages/tutorial/tutorial-controller.ts` (`startTutorial`).

## Test harnesses

- Deterministic/"ideal" mock LLM: Playwright `page.route` SSE interception of
  `/messages/stream` (precedent: `walkthrough/walkthrough-capture-smoke.spec.ts`
  `installWalkthroughConversationStore`). Onboarding itself is seeded (deterministic
  by construction); the post-onboarding chat round-trip uses the SSE mock.
- Real LLM: `packages/scenario-runner` scenario with a live key (`--report`);
  `SCENARIO_USE_LLM_PROXY=1` flips to the deterministic proxy.
- Screenshots/review: `bun run --cwd packages/app audit:app` + a dedicated
  `full-walkthrough` ui-smoke spec writing `NN-step.png` (desktop+mobile) fed to
  `scripts/ai-qa/review-screenshots.mjs`.

## Status

- [ ] Phase 1: land-in-chat gating + seed onboarding into `ContinuousChatOverlay`.
- [ ] Phase 2: route first-run choices → headless use case; persist once; tutorial-or-skip.
- [ ] Phase 3: delete `FirstRunChat` + gate + dead CSS + duplicate handoff + voice stack.
- [ ] Phase 4: full in-chat walkthrough spec (mock-LLM) + real-LLM scenario + screenshots/review.
- [ ] Phase 5: `audit:app` 5-loop, evidence, PR.
