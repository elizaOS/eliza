# Automations UX Redesign

## Scope

This writeup covers the Automations product surface: overview, creation, task editing, workflow editing, drafts, events, graph/data flow, sidebar navigation, nodes, and the right sidebar agent. It is intentionally a product and interaction spec, not a visual mood board. The goal is to make automations feel obvious, compact, and powerful without exposing internal implementation details.

Primary references:

- n8n AI Workflow Builder: natural-language creation, build feedback, review, refinement, and credential review are core to the builder model. Source: https://docs.n8n.io/advanced-ai/ai-workflow-builder/
- Slack Workflow Builder: starts from templates or scratch, distinguishes steps, connector steps, activity, errors, and management actions. Source: https://join.slack.com/help/articles/360035692513-Guide-to-Slack-Workflow-Builder
- Zapier drafts and versions: drafts belong in the editor/sidebar, can be deleted, and publish/version history is separate from active runtime state. Source: https://help.zapier.com/hc/en-us/articles/9693520498445-Create-Zap-drafts-and-versions
- Apple Shortcuts: shortcuts are multi-step action sequences, actions are the atomic building blocks, and gallery/examples teach by showing useful possibilities. Source: https://support.apple.com/guide/shortcuts/welcome/ios

## North Star

Automations should feel like this:

1. Say what should happen.
2. Let the system choose the simplest shape.
3. Inspect only the parts that affect trust: start condition, action path, state, and errors.
4. Edit either by clicking a compact visual element or by telling the sidebar agent what to change.

The user should not have to learn our backend vocabulary. They should not see UUIDs, room IDs, node catalog counts, coordinator language, or empty debug panels. They should see live work, drafts, problems, and the graph when the automation is actually a graph.

## Current Screenshots

### Screenshot A: Catalog-First Overview

What is really there:

- Left sidebar with Overview, Workflows, Coordinator, Scheduled, and Node Catalog.
- Main content opens on a Heartbeat automation and immediately exposes schedule metadata, run history, and an Automation Nodes catalog.
- Status appears as a large ACTIVE badge instead of a lightweight state signal.
- The page spends the user's primary workspace on implementation internals.

Why it is weak:

- The overview should answer operational questions, not teach the node registry.
- Node Catalog implies building from primitives, which is the opposite of the desired AI-generated workflow model.
- Scheduled, Workflows, and Coordinator create overlapping concepts without explaining user intent.
- Empty run history and node lists make the page feel like a debug console.

What should replace it:

- Overview: command input, health strip, next item, running items, drafts, failures, recent changes.
- Nodes: a collapsed secondary section for users who need primitives.
- Agent Owned: collapsed by default, no add button, framed as system-owned automations.

### Screenshot B: Draft Workflow With Two Chats

What is really there:

- A workflow draft detail page with a graph canvas, a local Automations Assistant panel, and a separate right sidebar chat.
- The draft content is mostly empty: no generated nodes, no clear primary action, and no durable editor state beyond the draft label.
- The assistant panel asks the user to describe a workflow even though there is already a page-level chat.

Why it is weak:

- Two chat surfaces split responsibility. Users cannot know which one edits the workflow.
- The draft is not useful until it becomes the actual editor object.
- The graph is correct as the primary workflow surface, but it needs one obvious start action.

What should replace it:

- One right sidebar agent only.
- A visible "Describe your workflow" command box on the workflow editor when no nodes exist.
- Drafts remain real selectable objects with delete and continue actions.

### Screenshot C: Sparse Overview With Floating Chat

What is really there:

- Sidebar contains Tasks, Workflows, Agent Owned, and Nodes.
- Main overview shows top-line counts and a mostly empty content area.
- Right chat is present, but the page itself gives little direction.

Why it is weak:

- Sparse is better than slop, but empty space must still guide the user's next action.
- Counts alone do not explain what needs attention.
- The overview should fill the page with useful operational state when data exists and useful creation affordances when it does not.

What should replace it:

- Empty state: one sentence explaining tasks vs workflows, one command input, a few example chips.
- Non-empty state: compact command center with next, running, needs attention, drafts, and recent changes.

## Element-by-Element Spec

### 1. Left Sidebar

What each element does:

- Overview opens the command center.
- Tasks lists prompt-based automations.
- Workflows lists graph-based n8n automations.
- Agent Owned contains system-managed automations and should start collapsed.
- Nodes opens the node catalog only when the user explicitly needs primitives.
- Plus buttons beside Tasks and Workflows create that shape directly.
- Status dots show live, draft/setup, paused, or failed without full badges.

Defense:

- The sidebar is navigation, not analytics. Counts on the right of headers add noise and do not help users choose where to go.
- Tasks above Workflows is correct because tasks are simpler and more common.
- Agent Owned belongs below user-owned objects because it is not where users start.

Does it need to be there:

- Required: Overview, Tasks, Workflows, status dots, add buttons for user-created sections.
- Optional: Nodes, but it should remain secondary.
- Not needed: search in the sidebar for early scale; it takes space and does not solve the primary creation problem.

Other ways to do it:

- A single Automations list with filters would reduce taxonomy but hide the task/workflow difference too late.
- A nested tree by trigger type would help admins but increase mental overhead for normal users.

How other companies do it:

- Zapier and Slack keep primary navigation centered on created automations/workflows and management views, not primitive catalogs.
- Apple Shortcuts uses Gallery and Shortcuts as high-level concepts; actions are deeper inside editing.

Responsive rules:

- Desktop sidebar can show section labels and rows.
- Tablet can keep labels but collapse secondary sections.
- Mobile should become a drawer or bottom sheet; status dots remain, but section controls need larger tap targets.

### 2. Overview Command Center

What each element does:

- Command input creates from intent: "What should happen?"
- Status strip summarizes Live, Timed, Events, and Attention.
- Next panel shows the next scheduled run or the next draft to continue.
- Running panel shows enabled automations.
- Needs attention shows failures or blocked setup.
- Drafts shows unfinished tasks/workflows that can be resumed or deleted.
- Recently changed provides a lightweight recency trail.
- Task and Workflow inventory stays lower because inventory is less urgent than operational state.

Defense:

- The overview is the product's cockpit. It should answer: what will run, what is live, what is broken, and what should I create next?
- It should not duplicate every detail from the editor.
- It should not display UUIDs, room IDs, raw node counts, coordinator internals, or empty log panels.

Does it need to be there:

- Required: command input, Next, Needs attention.
- Strongly useful: Running, Drafts, Recently changed.
- Optional: detailed inventory if the lists become long enough to require a table.

Other ways to do it:

- Table-first dashboard. Efficient at high scale but cold and harder for new users.
- Activity-feed-first dashboard. Good after heavy use, poor for first-run creation.
- Card grid. Friendly but wastes space and repeats labels.

How other companies do it:

- Slack emphasizes workflow starts, steps, activity, and errors.
- Zapier separates drafts/versioning from live Zap operation.
- Apple Shortcuts starts with useful examples and created shortcuts, not raw internals.

Responsive rules:

- Desktop: command input and Next panel can sit in a two-column top area.
- Tablet: top area stacks, status chips wrap.
- Mobile: command input first, then Next, Attention, Drafts, Running, Recent. Inventory can collapse behind section headers.

### 3. Single Creation Input

What each element does:

- Text input captures intent.
- Create button submits intent.
- The system infers task vs workflow using simple defaults.
- Direct Task and Workflow buttons remain as escape hatches for users who know the shape.

Defense:

- Asking users to pick Task or Workflow before describing the automation makes them solve our information architecture first.
- Most simple scheduled prompts should become tasks.
- Conditional, event-based, multi-step, or pipeline prompts should become workflows.

Does it need to be there:

- Required. It is the most important simplification.

Other ways to do it:

- Modal wizard: clearer validation, slower creation.
- Template gallery first: good onboarding, slower for users with intent.
- Chat-only creation: powerful, but invisible unless the user already trusts the chat.

How other companies do it:

- n8n's AI builder starts from a workflow description, then refines.
- Zapier supports AI-assisted Zap creation but still exposes the resulting editor.
- Slack starts from templates or scratch and then manages steps.

Responsive rules:

- Input must remain the largest obvious target on every viewport.
- Submit button stacks below on narrow screens.
- Placeholder should be an example, not a paragraph.

### 4. Task Editor

What each element does:

- Name/title identifies the task.
- Prompt/instructions is the task body.
- Starts when controls schedule or event trigger.
- Status controls live, paused, or draft.
- Runs/history shows outcomes after execution.
- Advanced settings contain raw details only when needed.

Defense:

- A task is not a graph. It should be a simple text editor plus trigger configuration.
- The task body is the primary content; surrounding settings should not dominate it.
- Event and schedule triggers should use the same start-condition model as workflows.

Does it need to be there:

- Required: prompt, start condition, status, save/delete.
- Useful: run history and failure repair.
- Not needed by default: raw cron, UUIDs, backing room, internal wake mode.

Other ways to do it:

- Form-only wizard. Clear but too rigid for editing.
- Chat-only task editor. Fast but poor for verification.
- YAML/JSON editor. Powerful but wrong for this product surface.

How other companies do it:

- OpenClaw Heartbeat-like tasks are background prompts with a schedule, but user-facing editing should stay simpler than implementation.
- Apple Shortcuts keeps action details editable but hides platform internals.

Responsive rules:

- Mobile task editor should put prompt first, then trigger, then actions.
- Save/delete should be sticky or reachable without scrolling through advanced details.

### 5. Workflow Editor

What each element does:

- Header identifies title, status, start condition, and primary actions.
- Graph canvas displays the directed workflow.
- Node inspector edits selected node details.
- Data-flow strip summarizes how information moves from input to output.
- Settings panel controls trigger, credentials, enablement, and advanced execution details.
- Sidebar agent can generate, revise, explain, or repair the workflow.

Defense:

- Workflows are directed graphs. The graph is not decorative; it is the user's proof of what will happen.
- A workflow needs both a visual overview and a compact linear explanation because graphs can become hard to parse.
- n8n compatibility matters, but Eliza should wrap n8n complexity in clearer product language.

Does it need to be there:

- Required: graph, start condition, status, save/delete/duplicate, agent edit path.
- Useful: node inspector, data-flow strip, undo/redo.
- Advanced-only: raw n8n JSON, node IDs, credential IDs, execution internals.

Other ways to do it:

- Linear step editor. Easier for mobile and simple workflows, weaker for branching.
- Full embedded n8n. Maximum power, less integrated and more intimidating.
- Mermaid-like generated preview. Readable, but not sufficiently editable.

How other companies do it:

- n8n uses a canvas as the real workflow editor.
- Zapier's editor is step-oriented because most Zaps are linear.
- Slack workflows use starts and steps, emphasizing understandable sequence over raw graph internals.

Responsive rules:

- Desktop: graph left, inspector/settings right or drawer, agent in global sidebar.
- Tablet: graph full width, inspector below or slide-over.
- Mobile: graph should have a step-list fallback because canvas manipulation is difficult on small screens.

### 6. Events and Information Flow

What each element does:

- Event trigger defines the incoming payload.
- First node receives that payload.
- Each node declares what it consumes and produces.
- Edges represent data movement, not just execution order.
- Data-flow strip names the path in plain language.

Defense:

- Users need to know what information is available to each step.
- Discord, Telegram, email, and similar messages should normalize to generic events like `message.received` where possible.
- Raw event names should be inspectable but not the default language.

Does it need to be there:

- Required for workflow trust.
- Required for event-triggered tasks.

Other ways to do it:

- Hide payloads entirely. Simpler, but users cannot debug why a step lacks data.
- Show raw JSON everywhere. Precise, but too technical.
- Schema chips per edge. Strong future direction, but only useful after payload schemas are normalized.

How other companies do it:

- n8n exposes node input/output data in executions.
- Zapier maps fields from prior steps into later steps.
- Slack workflow variables expose outputs from earlier steps.

Responsive rules:

- Desktop can show graph plus compact flow strip.
- Mobile should prioritize the linear data-flow strip over the freeform canvas.
- Raw payload drawer should be copyable and collapsible.

### 7. Draft Management

What each element does:

- Drafts appear in the sidebar and overview.
- Draft detail opens the actual task/workflow editor.
- Delete removes drafts after confirmation.
- Duplicate creates a separate draft from an existing automation.
- Publish/enable changes runtime state.

Defense:

- Drafts are work, not placeholders.
- Users need to safely explore, duplicate, abandon, and resume ideas.
- "What would you like to automate?" is an entry prompt, not a draft detail page.

Does it need to be there:

- Required: list, open, delete, continue.
- Strongly useful: duplicate.
- Optional: version history, publish comparison.

Other ways to do it:

- Auto-delete empty drafts. Reduces clutter, but risks losing intent.
- Single draft per user. Simple, but blocks parallel work.
- Hidden drafts only in editor. Keeps sidebar clean, but users cannot recover them easily.

How other companies do it:

- Zapier treats drafts and versions as explicit objects separate from published behavior.
- n8n keeps workflows editable and inactive until activated.

Responsive rules:

- Draft rows should be compact and clearly marked with a yellow dot.
- Delete must remain a confirmed destructive action.
- Mobile should expose delete in an overflow menu, not as an accidental row tap.

### 8. One Sidebar Agent

What each element does:

- The right sidebar chat is the only conversational assistant.
- Page controls can prefill the chat with workflow/task-specific prompts.
- The agent can generate, edit, explain, repair, duplicate, enable, disable, or inspect automations.

Defense:

- Two assistant panels create ambiguity and duplicated state.
- One assistant makes all automation operations auditable in one place.
- The editor should show the object; the chat should operate on it.

Does it need to be there:

- Required if conversational editing exists.

Other ways to do it:

- Inline assistant inside the graph. Useful as a launcher, but should still use the same conversation.
- Modal assistant. Focused, but blocks the editor.
- No chat. Cleaner surface, but loses the core AI-generated workflow advantage.

How other companies do it:

- n8n AI builder keeps AI creation close to the workflow editor.
- AI coding products generally converge on one assistant surface with file/object context rather than multiple independent chats.

Responsive rules:

- Desktop: persistent right sidebar.
- Tablet: collapsible right drawer.
- Mobile: chat opens as a full-height sheet with clear return to editor.

### 9. Nodes Catalog

What each element does:

- Nodes lists available primitives/actions for workflow construction.
- It helps advanced users understand what can be used.
- It should not be the overview content.

Defense:

- Node catalogs are important for builders, but they are not the user's primary mental model.
- "Nodes" is clearer and shorter than "Node Catalog."
- Showing node counts in the header suggests implementation detail instead of user progress.

Does it need to be there:

- Optional for most users, required for advanced editing and debugging.

Other ways to do it:

- Node picker only inside the workflow editor. Cleaner, but less discoverable.
- Marketplace/integrations page. Better for connectors, too broad for workflow primitives.

How other companies do it:

- n8n has a node picker/catalog because it is a builder tool.
- Zapier hides most primitive catalog concerns behind app/action selection.

Responsive rules:

- Desktop can show Nodes in the sidebar footer.
- Mobile should expose nodes from the workflow editor, not global nav.

### 10. Failures and Repair

What each element does:

- Failure row shows the blocked automation, cause, and one next action.
- Possible actions: Connect account, Retry, Open workflow, Ask agent to fix.
- Logs remain available behind a disclosure.

Defense:

- Users do not want logs first. They want repair.
- Red should be reserved for actionable failures, not empty or paused state.
- Credential/setup errors should be normalized enough to map to repair actions.

Does it need to be there:

- Required once automations can fail.

Other ways to do it:

- Full run log as default. Good for engineers, too much for normal users.
- Toast-only errors. Easy to miss.
- Email alerts only. Useful supplement, not a dashboard replacement.

How other companies do it:

- Slack exposes workflow activity and errors.
- Zapier blocks publishing or highlights steps needing attention.
- n8n execution logs are powerful but technical; Eliza should surface repair first.

Responsive rules:

- Mobile failure rows should fit one line with a clear action button.
- Details open in a sheet or drawer.

## Implementation Pass

Implemented now:

- Added a top-level command input to the overview and create dialog.
- Added prompt-shape inference: simple recurring prompts open a task draft form, complex/event/multi-step prompts generate workflow drafts.
- Reworked overview toward a command center: Next, Running, Needs attention, Drafts, Recently changed, with task/workflow inventory below.
- Replaced metric-card dashboard emphasis with compact status chips.
- Preserved the graph and data-flow strip for workflows.
- Kept drafts as real selectable/deletable items.

Deliberately not implemented in this pass:

- Full mobile step-list fallback for graph editing, because that needs a dedicated graph interaction pass.
- Connector-specific failure repair actions, because credential/setup errors need normalized backend causes first.
- True in-flight "Running" state, because the current frontend can only safely represent enabled/live automations until execution state is exposed.

## Quality Bar

The accepted UX should satisfy these checks:

- A new user with no automations sees one sentence, one creation input, and useful examples.
- A returning user sees what will happen next, what is live, what is broken, and what is unfinished.
- A task can be created without understanding graphs.
- A workflow can be generated from description and inspected as a graph.
- Drafts can be opened and deleted.
- Event-triggered automations show events as start conditions, not fake schedules.
- The right sidebar is the only assistant chat.
- UUIDs, room IDs, and raw backend details stay out of the default path.
