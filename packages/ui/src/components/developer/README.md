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
expandable **Details**, and a fixed composer. **Settings** contains the existing
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

Replies outside the recent summary window initially show **Details**. Opening
it loads matching counts and keeps them visible after collapse. Unloaded counts,
failed reads, absent foreground runs and zero-valued usage have distinct labels;
background-only results remain inspectable in Trajectories.

Summary polling reads 50 records every 500ms while sending and every five
seconds while idle. Polls never overlap. Hidden documents, pause, unmount and
authorization failures stop automatic reads. **Details** keeps the raw evidence
disclosures: initial detail reads use `includePayloads: false` after expansion
or advanced inspection; full prompts, tools, results and context load behind
another disclosure. Routine polling remains lightweight and excludes payloads.

Reply token counts include recorded post-turn evaluation. Expanded calls
distinguish foreground, evaluation and background memory; provider adapters
often label every call `external_llm`, so the recorded semantic stage determines
the evaluation lane. Missing usage is unknown, partial totals are labeled, and
estimated per-call usage carries `≈`. Run duration may include evaluation;
overlapping stage durations must not be added. HTTP attempts, queue time and
provider first-token timing are not measured here. Configured routing does not
prove the provider used: recorded calls can show fallback providers.

## Message trajectories

The **Trajectories** tab lazily finds all runs for the reply through the existing
paginated search API, accepting only exact room and message ID matches. It can
find runs beyond the live summary window. Foreground, recovery and background
memory runs expand separately, using the shared `TrajectoryDetailView`.

Compact call rows show recorded input/output tokens and time. Opening a call
reveals complete **Input**, **Output** and **System** raw text with **Copy**.
Recorded handler, planner and tool steps expose their input, output and complete
step record; model stages describe the calls above, not additional calls.
**Copy entire recorded run** preserves the full returned record. Context and
timeline remain optional diagnostics.

Inspection makes no model calls. Full payload reads occur only for open runs,
refresh when the run revision changes and abort on cleanup. These payloads may
contain private conversation content and remain untruncated. Missing separately
recorded provider payloads are labeled unavailable; the complete recorded model
input remains viewable and copyable.

## Layout and accessibility

The transcript follows new replies only while the user is near the bottom.
Unchanged messages are memoized across polls. The composer remains outside the
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
Original local validation exercised real Home and Notes prompts, live counts,
route isolation, and desktop/mobile layouts. The pull request tracks validation
on the current branch and any remaining evidence requirements. Local behavior
checks do not establish full release or latency acceptance.
