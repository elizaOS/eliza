# Local developer chat

Open `/dev` in a development build on a loopback host. This separate surface
uses the existing Eliza app, conversation and theme. Normal `/chat`, `/notes`
and `/calendar` routes do not mount developer chrome, even when a tab retains
the old `eliza.developer-workspace` session flag or `?devtools=1` query.

## Same app, separate view

The developer chat shares one `AppProvider`, active conversation, composer
draft, `sendChatText` path and stop handler with the app. Prompts control the
real app. There is no second agent, runtime or conversation. The app remains
mounted when hidden; **Show app** reveals it without changing the conversation.
Navigation stays inside `/dev#/notes`, `/dev#/chat`, etc. Both hash-aware
navigation and the privileged shell history writer preserve this boundary,
including imperative agent view actions. **Exit** opens the active app route
without developer chrome.

The default view is a single chat column: messages, recorded token counts,
an **Inspect** button on each reply, and a fixed composer. **Inspect** opens a
viewport-contained dialog with **Details** and **Trajectories**. It does not
expand the transcript or move the reader's chat position. **Settings** contains the existing
model configuration and Cerebras credential controls; **Advanced diagnostics**
contains the full run selector, pagination and pause control. Changing settings
changes this instance's configuration. Owner role gates remain in place.

## Live activity and recorded evidence

Server chat status and tool events drive live activity. A local elapsed clock
updates independently of the transcript. Token counts arrive after model calls
are recorded; unfinished calls do not have final usage. During sending, an
explicitly labeled latest run in the current room provides provisional run
details. Completed reply counts require an exact user message ID and room ID
match. Canonical `replyToMessageId` takes precedence even when its user message
is outside the loaded transcript; only replies without that link use adjacency.
Background memory runs correlate by the same IDs and remain separate.

Replies outside the recent summary window initially show **Inspect**. Opening
it loads matching counts and keeps them visible after closing. Unloaded counts,
failed reads, absent foreground runs and zero-valued usage have distinct labels;
background-only results remain inspectable in Trajectories.

Summary polling reads 50 records every 500ms while sending and every five
seconds while idle. Polls never overlap. Hidden documents, pause, unmount and
authorization failures stop automatic reads. **Details** keeps the raw evidence
disclosures: initial detail reads use `includePayloads: false` after expansion
or advanced inspection; full prompts, tools, results and context load behind
another disclosure. Routine polling remains lightweight and excludes payloads.

Reply and run token counts include every recorded call, including final-response
evaluation. Run source distinguishes chat from background memory. A semantic
stage named `evaluation` alone does not prove that it happened after delivery;
the viewer does not infer a foreground/post-turn split from it. Missing usage is
unknown, partial totals are labeled, and estimated per-call usage carries `≈`.
Overlapping stage durations must not be added. HTTP attempts, queue time and
provider first-token timing are not measured here. Configured routing does not
prove the provider used: recorded calls can show fallback providers.

## Message trajectories

The **Trajectories** tab lazily finds all runs for the reply through the existing
paginated search API, accepting only exact room and message ID matches. It can
find runs beyond the live summary window. Foreground, recovery and background
memory runs are selectable separately, using the shared `TrajectoryDetailView`.

The **Model call** selector switches directly between calls, showing recorded
input/output tokens and time. Complete **Input**, **Output** and **System** text
stays in a bounded scroll area with **Copy** above it. **Steps** selects handler,
planner and tool records with **Input**, **Output** and **Full step** tabs;
model stages describe the same calls, not additional calls. Tool activity
shows recorded action parameters as arguments. Valid preview-only effect receipts
are labeled **Preview · no changes**; explicit errors and invalid receipts retain
failure status. Full raw results remain available for inspection.
**Copy entire recorded run** preserves the full returned record. Context and
timeline have their own **Context & timeline** section.

Inspection makes no model calls. Full payload reads occur only for open runs,
refresh when the run revision changes and abort on cleanup. These payloads may
contain private conversation content and remain untruncated. Missing separately
recorded provider payloads are labeled unavailable; the complete recorded model
input remains viewable and copyable.

## Layout and accessibility

The transcript follows new replies only while the user is near the bottom.
The inspection dialog keeps controls outside the raw-text scroll area, traps
keyboard focus and restores focus to **Inspect** when closed. Escape closes it.
Details disclosures use the shared Collapsible and Button controls; complete JSON uses a read-only Textarea so it remains keyboard-selectable. Borders and table rows use the shared Separator and TableRow owners. Unchanged messages are memoized across polls. The composer remains outside the
scroll region. Enter sends; Shift+Enter inserts a newline; IME composition does
not submit. Failed sends preserve the draft without replacing newly typed text.

The app is hidden initially. When revealed, widths below 1280px show the app
with **Back to chat** available. Wider screens show the app beside a 480px chat
column. Buttons and disclosures have 44px targets, visible focus and accessible
names. The live indicator respects reduced motion. Colors, typography and
controls reuse the shared app design system described in `../../../PRODUCT.md`.

`DeveloperWorkspace.tsx` owns the shell, chat, settings and trace disclosures.
`useDeveloperTrajectories.ts` owns summary polling and advanced selection.
`DeveloperTrajectories.tsx` owns message-scoped discovery and run disclosures.
`../../styles/developer-workspace.css` contains scoped structural styles.
The design registry identifies reply and run inspectors as lifecycle owners;
recorded step toggles use the canonical Button and Separator, and NativeSelect
is registered as the existing native control owner.

## Local evidence

Focused tests cover canonical sending, message/room correlation, live elapsed
time before usage, lazy detail reads, unknown usage, stage classification,
polling cancellation, normal routes and developer navigation isolation.
`DeveloperWorkspace.stories.tsx` contains synthetic summary/trace fixtures.
Real Home and Notes prompts, live counts and route checks are documented in
`/Users/nubs/Documents/ChatGPT/test/eliza-dev-chat-isolation-20260909.md`.

The 2026-09-10 Trajectories check used a real Notes turn with three foreground
model calls, five semantic stages and a separate memory run. Clipboard and DOM
text matched exactly for 88,994 input characters, 53,759 system characters and
862 output characters. A separate background input copied all 50,758 characters.
Opening an older Calendar reply recovered five calls and 82,039 input / 835 output
tokens; its counts remained after collapse. All 36 focused tests passed.
The exact previously empty single-call reply also displayed and copied its
87,116-character input and 679-character output without changes.

The developer inspector and model settings now use the canonical controls;
their 14 previously recorded design findings were resolved. The latest root
verification still reports three unrelated NativeSelect overrides in
WorkflowTriggerPanel. No debt allowance or test expectation was relaxed.

The app capture audit passed 222 checks. Pixel triage reported 204 verified,
zero broken and 12 needing visual review across 216 captured views. This broad
capture predates the final developer-only label/control adjustments; the live
developer view is checked separately. Full release and latency acceptance remain
open. Evidence lives locally under
`/Users/nubs/Documents/ChatGPT/test/eliza-trajectories-20260910`.
