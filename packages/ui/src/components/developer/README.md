# Local developer chat

Open `/dev` in a development build on a loopback host. This separate surface
uses the existing Eliza app, conversation and theme. Normal `/chat`, `/notes`
and `/calendar` routes do not mount developer chrome, even when a tab retains
the old `eliza.developer-workspace` session flag or `?devtools=1` query.

## Same app, separate view

Keep `/dev` and the normal app in separate tabs on the same loopback origin.
The developer composer relays prompts to the selected normal app tab through
`developer-tab-bridge`; that tab owns the actual conversation, send/stop path
and view navigation. A single matching app tab is selected automatically. With
multiple app tabs, use **App tab** to select the target. **Open app** opens
`/chat` when none is available. Requests are correlated and time out visibly;
stale tabs and tabs for another agent are not valid targets.

Sending “open Notes” from `/dev` therefore navigates the selected normal tab to
`/notes`. The developer tab stays at `/dev` and displays the shared conversation
and recorded trajectories. The hidden app mount supplies the existing app
context; it is not a second visible app pane. **Exit** opens the normal route.

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
contain private conversation content and remain untruncated. Context providers use a selector with **Result**, **Request** and **Raw data**
views. Status, duration, text size and application provider-cache reuse are shown
as readable summaries; provider-cache reuse is distinct from model prompt caching.
Requests with a message field display actual line breaks instead of escaped JSON.
All compact text blocks have visible labels and copy the entire recorded text.

New state-composition reads retain each provider's complete secret-redacted text
only after the final audience and cancellation checks. Cached reads retain the
same text without executing the provider again. Internal provider values/data
are not newly captured. Compositions failing those checks retain metadata without text. A later
assembly failure can still have recorded provider results. Older records lacking text say **Provider result text was not recorded**;
a recorded empty string says **Provider returned no text**. Provider output is
not proof that a later model call included it; inspect that call's recorded input.
Missing separately recorded payloads cannot be reconstructed from a size/hash.

## Layout and accessibility

The transcript follows new replies only while the user is near the bottom.
The inspection dialog keeps controls outside the raw-text scroll area, traps
keyboard focus and restores focus to **Inspect** when closed. Escape closes it.
Details disclosures use the shared Collapsible and Button controls; complete JSON uses a read-only Textarea so it remains keyboard-selectable. Borders and table rows use the shared Separator and TableRow owners. Unchanged messages are memoized across polls. The composer remains outside the
scroll region. Enter sends; Shift+Enter inserts a newline; IME composition does
not submit. Failed sends preserve the draft without replacing newly typed text.

The normal app is viewed in its separate tab at every viewport width. Buttons
and disclosures have visible focus and accessible names. The live indicator
respects reduced motion. Colors, typography and controls reuse the shared app
design system described in `../../../PRODUCT.md`.

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
Real Home, Notes, Calendar and note-creation checks have been run on the local
integration branch. The pull request distinguishes that supporting evidence
from validation on its isolated head. Full current-head screenshot, video,
OCR and log evidence and the repository verification gate remain requirements
for final acceptance. Recorded input/output counts are not first-token timing
or proof that foreground latency and quota costs are fully optimized.
