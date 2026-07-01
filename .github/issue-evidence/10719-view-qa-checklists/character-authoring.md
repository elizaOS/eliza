# Character & Automation Authoring — QA Checklist

Scope: character editor (`components/character/CharacterEditor.tsx` + `CharacterEditorPanels`), character roster/select (`CharacterRoster.tsx`, `CharacterHubView.tsx`), documents (`pages/DocumentsView.tsx` + `documents-upload.tsx` + drag-drop), fine-tuning/advanced (`training/injected.tsx` → `TrainingDashboard.tsx`), automations/triggers (`pages/AutomationsFeed.tsx`), custom actions (`custom-actions/CustomActionsPanel.tsx` + `CustomActionEditor.tsx`, `chat/SaveCommandModal.tsx`).

Routes (from `navigation/index.ts` TAB_PATHS): `character`→`/character`, `character-select`→`/character/select`, `documents`→`/character/documents`, `automations`/`triggers`→`/automations`, `advanced`/`fine-tuning`→`/apps/fine-tuning`. Custom-actions panel has NO route — it is a modal toggled via the `toggle-custom-actions-panel` window event. SaveCommandModal is opened from chat message context-menu ("save as command").

Legend for coverage: **[COV]** committed test exercises it · **[SMOKE]** only render/visit smoke or story-gate · **[GAP]** no committed coverage.

---

## Character Editor (`/character`)

### Entry / Nav
- [ ] Reach via `character` tab → route `/character` renders `CharacterEditor` shell (`data-testid` companion-character-editor in overlay mode). [SMOKE all-views-interaction.spec `/character`]
- [ ] Fresh reload on `/character` restores editor with active character loaded (not blank). [GAP]
- [ ] Reach from chat "edit my character / open character editor" (agent-surface `tab-*` + `action-*` ids). [GAP]
- [ ] Back-button from `/character` returns to prior tab and does not lose unsaved draft warning. [GAP]
- [ ] Deep-link directly to a sub-page tab (personality/style/examples/documents) selects that page on load. [GAP]
- [ ] Enter editor with NO character selected → prompted to pick from roster, Save disabled. [GAP]

### Primary interactions
- [ ] Tab bar (personality/style/examples/documents) — clicking each `role="tab"` `tab-<page>` switches `activePage`; `rightTab` syncs to style/examples. [GAP]
- [ ] Identity panel fields (name, bio, system, topics, adjectives) — typing round-trips into draft and flips `hasPendingChanges` true. [GAP]
- [ ] Style panel: add-style-entry input + Add → appends unique entry to style.all/chat/post; blank/whitespace input is a no-op (`handleAddStyleEntry` trims). [GAP]
- [ ] Style panel: remove (x) on a chip → `handleRemoveStyleEntry` splices exactly that index, others unchanged. [GAP]
- [ ] Duplicate style entry is rejected (no dup row) — `!nextItems.includes(value)`. [GAP]
- [ ] Examples panel: add/edit message-example turns round-trip; empty turns preserved while composing (`hasValidMessageExamplesShape` skips normalize). [GAP]
- [ ] Upload VRM button (`action-upload-vrm`) triggers hidden `<input type=file>` click. [GAP]
- [ ] Export JSON button (`action-export-json`) downloads current character; disabled when `!currentCharacter`. [GAP]
- [ ] Reset button (`action-reset`) opens confirm dialog; disabled when no roster entry / no character. [GAP]
- [ ] Reset confirm → applies preset defaults; Cancel closes dialog leaving draft untouched. [GAP]
- [ ] Save button (`action-save`) calls `handleSaveAll` (character + voice); shows "saving…"; disabled while `characterSaving||voiceSaving||!hasPendingChanges||!currentCharacter`. [GAP]
- [ ] Save clears `hasPendingChanges` and updates `agentStatus` on the save button back to inactive. [GAP]
- [ ] Voice config edits (premade voice / api key) dispatch `VOICE_CONFIG_UPDATED_EVENT` and persist with Save. [GAP]
- [ ] Character name inline input (line ~1495) edits round-trip to draft. [GAP]

### State matrix
- [ ] Empty: brand-new character preset shows placeholder copy, Save disabled until a field changes. [GAP]
- [ ] Loading: character fetch in flight shows skeleton/spinner, not a flash of empty fields. [GAP]
- [ ] Populated: existing character hydrates all panels from server data. [SMOKE]
- [ ] Save failure (network 500) surfaces error, keeps `hasPendingChanges` true, does NOT clear draft. [GAP]
- [ ] Offline save → visible error, retry works after reconnect. [GAP]
- [ ] Guest/unauthenticated → editor read-only or gated (no silent 401 save). [GAP]
- [ ] Long bio/system (10k+ chars) does not break layout; textarea scrolls. [GAP]

### Repeated / rapid-fire
- [ ] Mash Save 5× rapidly → exactly one save request per change batch, button latched disabled during save, no dup PUT. [GAP]
- [ ] Double-click Reset → single confirm dialog, not two stacked. [GAP]
- [ ] Rapidly click Add-style with same value → only one chip added. [GAP]
- [ ] Spam tab switches personality↔style↔examples → no lost draft, no render-guard trip (`useRenderGuard`). [GAP]

### Back-and-forth / recovery
- [ ] Edit a field, navigate away with unsaved changes → `pendingNavigation` guard dialog (Save / Discard / Cancel) fires. [GAP]
- [ ] Guard "Save" persists then navigates; "Discard" navigates losing draft; "Cancel" stays. [GAP]
- [ ] Switch character→character-select→character rapidly → draft/selection restored or cleanly reset, not corrupted. [GAP]
- [ ] Background app mid-edit and resume → draft still present. [GAP]
- [ ] Reload mid-edit (before save) → unsaved draft is lost cleanly (no ghost pending state). [GAP]

### Fuzz / adversarial
- [ ] Paste 100k-char bio → no crash, save either accepted or bounded-rejected with message. [GAP]
- [ ] Emoji / RTL / IME composition in name+style → stored verbatim, round-trips on reload. [GAP]
- [ ] Whitespace-only name → Save rejects or trims (must not persist empty identity). [GAP]
- [ ] Injection-ish `{{handlebars}}` / `<script>` in system prompt → stored as text, not executed/interpolated in UI. [GAP]
- [ ] Import malformed VRM/JSON → error, editor state unchanged. [GAP]
- [ ] Invariant: `hasPendingChanges` is true iff draft ≠ saved character. [GAP]

### Input modalities
- [ ] Tab order flows name→panels→toolbar buttons→Save; Enter in single-line inputs does not submit whole form. [GAP]
- [ ] Escape closes Reset/Nav-guard dialogs. [GAP]
- [ ] Mobile viewport: tab bar and Save reachable; panels stack; 44px targets on toolbar icon buttons (h-9 w-9). [GAP]
- [ ] Touch tap on roster entry selects; long-press does nothing unexpected. [GAP]

### A11y / geometry
- [ ] Reset + Nav-guard dialogs trap focus and restore focus to trigger on close. [GAP]
- [ ] Toolbar icon buttons have aria-labels (upload/export/reset present). [SMOKE story-gate axe]
- [ ] Save button hover: accent gradient → darker accent (never orange→black), no blue anywhere. [GAP]
- [ ] `role="tab"`/aria-selected on page tabs correct; axe pass after switching pages. [GAP]
- [ ] Reduced-motion: greeting animation (`resolveCharacterGreetingAnimation`) respects prefers-reduced-motion. [GAP]

### Concurrency / races
- [ ] Save while a prior save in-flight → second click ignored (button disabled), no interleaved PUT. [GAP]
- [ ] Switch character while save pending → in-flight save completes for the right character, not the newly-selected one. [GAP]
- [ ] Voice save + character save fired together resolve without clobbering each other's success state. [GAP]

---

## Character Select / Roster (`/character/select`)

### Entry / Nav
- [ ] Reach via `character-select` tab → `/character/select`; `CharacterRoster` grid (`data-testid <prefix>-roster-grid`) renders. [SMOKE all-views-interaction.spec]
- [ ] Fresh reload on `/character/select` renders grid populated from presets + custom packs. [GAP]
- [ ] Selecting an entry (`<prefix>-preset-<id>`) calls `onSelect` and navigates to `/character` with that character active (`setTab("character")`). [GAP]
- [ ] Back from editor returns to select with prior selection highlighted. [GAP]

### Primary interactions
- [ ] Each roster tile is a button; click selects + routes; keyboard Enter/Space selects. [GAP]
- [ ] Custom pack entries (`createCustomPackRosterEntry`) appear alongside built-ins (`resolveRosterEntries`). [GAP]
- [ ] CharacterHubView sections (overview / learned skills / personality timeline) render for selected character. [SMOKE character-stories-smoke]

### State matrix
- [ ] Empty custom packs → only built-in presets shown, no blank grid. [GAP]
- [ ] Many presets (50+) → grid scrolls, virtualized/paged without jank. [GAP]
- [ ] Loading roster → skeleton tiles, not layout jump. [GAP]
- [ ] Failed pack fetch → built-ins still shown, error toast for packs only. [GAP]

### Repeated / rapid-fire
- [ ] Double-tap a tile → single navigation, not double-push into history. [GAP]
- [ ] Rapidly select A→B→C tiles → last selection wins, editor loads C not a stale one. [GAP]

### Back-and-forth / recovery
- [ ] Select→edit→back→select preserves scroll position of the grid. [GAP]
- [ ] Reload after selecting keeps the same active character in editor. [GAP]

### Fuzz / adversarial
- [ ] Custom pack with huge/emoji name → tile label truncates, no overflow. [GAP]
- [ ] Corrupt custom pack entry → skipped, other tiles unaffected. [GAP]

### Input / A11y / geometry
- [ ] Tab traverses tiles in DOM order; focus ring visible. [GAP]
- [ ] Tiles ≥44px tap target on mobile; grid reflows to 1–2 cols. [GAP]
- [ ] Tile hover: neutral→neutral-opacity (no blue, no orange→black). [GAP]
- [ ] axe pass on grid. [SMOKE story-gate]

### Concurrency
- [ ] Selecting a tile while roster still loading packs → selection queued/applied once loaded, no crash. [GAP]

---

## Documents (`/character/documents`)

### Entry / Nav
- [ ] Reach via `documents` tab → `/character/documents` (`DocumentsView`); also rendered inside CharacterEditor "documents" sub-page. [COV documents-view.spec desktop+mobile]
- [ ] Fresh reload on `/character/documents` renders list + upload zone. [COV documents-view.spec]
- [ ] Reach from chat "add a document / upload knowledge". [GAP]
- [ ] Back-button returns to editor documents sub-page vs standalone tab correctly. [GAP]

### Primary interactions (upload — `documents-upload.tsx`)
- [ ] "Choose Files" button opens file picker (`fileInputRef.click`); selecting files calls `handleFileSelect`→upload. [GAP]
- [ ] Drag file over dropzone sets `dragOver` highlight; drop calls `handleDrop` and uploads. [GAP]
- [ ] "Add from URL" toggles URL input; submit (`handleUrlSubmit`, Enter or button) ingests URL; empty URL is no-op. [GAP]
- [ ] "New Text Document" toggles text input; Title(optional)+body submit (`handleTextSubmit`) creates a text doc; empty body no-op. [GAP]
- [ ] Scope selector (`selectedScope` DocumentScope) changes upload scope. [GAP]
- [ ] Uploaded doc appears in the list without full reload. [GAP]
- [ ] Document row: open detail (`documents-detail.tsx`) shows content; delete removes row. [COV documents-detail.test.tsx (2 cases)]

### State matrix
- [ ] Empty: no documents → empty-state copy + prominent upload zone. [COV documents-view.spec]
- [ ] Loading: fetch in flight → skeleton. [GAP]
- [ ] Populated: many docs → list scrolls, counts correct. [COV documents-view.spec]
- [ ] Upload failure (413/500) → error surfaced, dropzone re-enabled. [GAP]
- [ ] Offline upload → queued/rejected with clear message, no silent drop. [GAP]
- [ ] Permission-denied on native file pick → message, not a crash. [GAP]
- [ ] Large doc (multi-MB) → progress or bounded reject. [GAP]

### Repeated / rapid-fire
- [ ] Drop the same file twice → dedup or two distinct rows deliberately, no half-uploaded ghost. [GAP]
- [ ] Mash "Choose Files" → single picker instance. [GAP]
- [ ] Submit URL twice quickly → one ingest request, not two. [GAP]
- [ ] Spam-toggle URL/Text panels → inputs reset cleanly, no stacked panels. [GAP]

### Back-and-forth / recovery
- [ ] Start URL entry, switch tab, return → draft URL cleared or preserved consistently. [GAP]
- [ ] Navigate away mid-upload → upload continues or is cancelled cleanly (no orphan). [GAP]
- [ ] Open doc detail → back → list scroll position retained. [GAP]
- [ ] Reload mid-upload → no partial/corrupt doc persisted. [GAP]

### Fuzz / adversarial
- [ ] Paste 500k chars into text-doc body → bounded accept/reject, no freeze. [GAP]
- [ ] URL input: `javascript:`/`file://`/malformed → rejected (scheme allowlist). [GAP]
- [ ] Drop a non-text binary / 0-byte file → handled with message. [GAP]
- [ ] Emoji/RTL title round-trips into list + detail. [GAP]
- [ ] Drop 50 files at once → all queued or bounded, UI stays responsive. [GAP]

### Input modalities
- [ ] Keyboard: Tab to Choose Files/URL/Text buttons, Enter activates; URL input Enter submits. [GAP]
- [ ] Touch: drag-drop replaced by Choose Files on mobile (no dead dropzone). [COV documents-view.spec mobile viewport]
- [ ] Escape closes an open detail/preview. [GAP]

### A11y / geometry
- [ ] Dropzone has `aria-label` (`aria.documentsUpload`) and is focusable. [GAP]
- [ ] Buttons ≥44px; upload icons labelled. [GAP]
- [ ] Detail/preview modal traps focus. [GAP]
- [ ] Hover states obey orange-accent rule; no blue. [COV documents-view.spec aesthetic check]

### Concurrency
- [ ] Two uploads in flight → both complete, list reflects both, counts correct. [GAP]
- [ ] Delete a doc while another upload pending → no index/ID mismatch. [GAP]

---

## Fine-Tuning / Advanced (`/apps/fine-tuning`)

### Entry / Nav
- [ ] Reach via `fine-tuning` OR `advanced` tab → both map to `/apps/fine-tuning` (`FineTuningView`→`TrainingDashboard` fallback, or injected boot-config component). [COV apps-model-training-interactions.spec `fine-tuning-view`]
- [ ] Route resolves from internal-tool-apps registry (`getInternalToolAppWindowPath`). [COV internal-tool-apps.test.ts]
- [ ] Fresh reload on `/apps/fine-tuning` renders dashboard. [COV]
- [ ] Reach from chat "fine-tune / train a model". [GAP]

### Primary interactions
- [ ] Select trajectories → Build Dataset → Start Job flow (recorder asserts buildDataset + startJob payloads). [COV apps-model-training-interactions.spec "selects trajectories, builds a dataset, and starts a job"]
- [ ] Jobs table row click selects job → `JobDetailPanel` opens; close returns. [SMOKE (render); GAP interaction detail]
- [ ] Models table "Train" button (`onTrainClick`) starts a job for that model. [GAP]
- [ ] Create Job button (`handleCreateJob`) disabled while `createLoading`. [GAP]
- [ ] Cancel a running job → status flips to cancelled (`/cancelled/i` visible). [COV apps-model-training-interactions.spec]
- [ ] Budget panel + Inference endpoint panel inputs round-trip. [GAP]

### State matrix
- [ ] Empty: no jobs/models → empty-state, Start disabled without a dataset. [GAP]
- [ ] Loading jobs/models → skeleton tables. [GAP]
- [ ] Populated: jobs listed with status/started columns. [COV]
- [ ] Start-job failure → error surfaced, no phantom "running" row. [GAP]
- [ ] Offline → training actions disabled/queued with message. [GAP]

### Repeated / rapid-fire
- [ ] Mash "Start Job" → one job created, button latches disabled. [GAP]
- [ ] Double-click a jobs-table row → single detail panel. [GAP]
- [ ] Cancel job twice → idempotent, one cancel request. [GAP]

### Back-and-forth / recovery
- [ ] Build dataset, leave view, return → dataset selection preserved or cleanly reset. [GAP]
- [ ] Job started → navigate away → return shows job still running (polled). [GAP]
- [ ] Reload during job start → job either created once or not at all (no dup). [GAP]

### Fuzz / adversarial
- [ ] Zero trajectories selected → Build Dataset disabled/rejected. [GAP]
- [ ] Negative/NaN budget or epoch values → validation blocks Start. [GAP]
- [ ] Huge trajectory selection (all) → bounded, no freeze. [GAP]

### Input / A11y / geometry
- [ ] Keyboard: Tab through trajectory list → Build → Start; Enter activates. [GAP]
- [ ] Tables have header semantics; row buttons labelled. [GAP]
- [ ] Mobile: tables scroll horizontally, actions reachable. [GAP]
- [ ] Hover on Train/Start obeys accent rule. [GAP]

### Concurrency
- [ ] Start Job while dataset build still in flight → Start waits or is disabled until dataset ready. [GAP]
- [ ] Two job-detail polls overlapping → no state thrash. [GAP]

---

## Automations / Triggers (`/automations`)

### Entry / Nav
- [ ] Reach via `automations` OR `triggers` tab → both `/automations`; shell `data-testid automations-shell`. [COV automations.spec]
- [ ] Fresh reload on `/automations` renders feed + filter chips + stats. [COV]
- [ ] Deep-link with filter (via `useAutomationDeepLink` / `show only failed runs` custom event sets `filter`). [COV automation-feed-filter.test.ts unit]
- [ ] Reach from chat "show my automations / schedule a task". [GAP]

### Primary interactions
- [ ] Filter chips All/Tasks/Workflows/Active/Inactive (`tab-<filter>`) filter rows; counts (`filterCounts`) show per chip. [COV automations.spec "Tasks 0/1", "Workflows 0/1"]
- [ ] Stat cards (active / success / error) reflect `allRows` derivations (`data-testid automation-stat-<key>`). [GAP (values not asserted)]
- [ ] "Create in chat" button (`focusAutomationChat`) focuses chat composer for authoring. [GAP]
- [ ] Task row open → detail; workflow row open shows JSON (`workflow-editor-json`) + Graph. [COV automations.spec "inspect workflow JSON"]
- [ ] "Run {name} now" button (`onRunNow`) calls `client.runWorkflowDefinition(workflowId)` and refreshes. [GAP (button present, run not asserted)]
- [ ] Scheduled-task editor open (`scheduledEditorId`) edits a task. [COV ScheduledTaskEditor.test.tsx]
- [ ] Event-trigger row renders ("On message.received") and creating an event automation works. [COV automations.spec "renders an event trigger and creates"]

### State matrix
- [ ] Empty: "Nothing scheduled yet", chips read 0, encourages create. [COV automations.spec]
- [ ] Loading: `loading` true (no cached) → skeleton, not empty flash. [GAP]
- [ ] Populated: tasks + workflows listed, mixed kinds. [COV]
- [ ] Error: `client.listAutomations()` throws → error state shown, retry path. [GAP]
- [ ] Cached automations render instantly then refresh (loading starts false when cache present). [GAP]
- [ ] Offline → stale cache shown with offline indicator. [GAP]

### Repeated / rapid-fire
- [ ] Mash "Run now" on a workflow → one `runWorkflowDefinition` call, no dup runs. [GAP]
- [ ] Rapid filter chip toggling → final filter applied, counts stable, no flicker. [GAP]
- [ ] Double-click a row → single detail open. [GAP]

### Back-and-forth / recovery
- [ ] Set filter=Workflows, open a row, back → filter still Workflows, scroll retained. [GAP]
- [ ] Navigate away during list fetch → request cancelled, no setState-after-unmount. [GAP]
- [ ] Reload with a filter active → filter reset to All (default) unless deep-linked. [GAP]

### Fuzz / adversarial
- [ ] Automation with huge/emoji/RTL title → row truncates, filter still matches. [GAP]
- [ ] Workflow JSON with 10k lines → editor scrolls, Graph renders bounded. [GAP]
- [ ] Rapid interleave: filter + run-now + open-detail → no inconsistent counts (invariant: sum of chip counts consistent with row set). [GAP]
- [ ] `passesFilter` invariant: a row appears in exactly the chips whose predicate it matches. [COV automation-feed-filter.test.ts]

### Input modalities
- [ ] Keyboard: Tab across filter chips (role tab), Enter selects; Tab into rows. [GAP]
- [ ] Touch: tap chips + rows; swipe on row (if wired) does nothing unexpected. [GAP]
- [ ] Escape closes an open scheduled-task/workflow editor. [GAP]

### A11y / geometry
- [ ] Filter chips have aria-selected/role tab; stat cards labelled. [GAP]
- [ ] Run-now button aria-label `Run {name} now` present. [COV present in DOM]
- [ ] Chips/rows ≥44px on mobile. [GAP]
- [ ] Hover on Run/Create obeys accent rule; no blue. [GAP]
- [ ] axe pass on populated feed. [GAP]

### Concurrency
- [ ] Run-now on workflow A while list refresh in flight → refresh reflects A's new run, not stale. [GAP]
- [ ] Two run-now on different workflows → both dispatch, dashboard refreshes once consistently. [GAP]

---

## Custom Actions Panel + Editor (modal — `toggle-custom-actions-panel` event)

### Entry / Nav
- [ ] Panel opens via `toggle-custom-actions-panel` window event (no route); toggling event twice closes it. [GAP]
- [ ] Reach from chat "create a custom action / add a tool". [GAP]
- [ ] Panel has no deep-link URL — verify it does NOT persist open across reload (modal, not route). [GAP]

### Primary interactions (Panel — `CustomActionsPanel.tsx`)
- [ ] Search input (`search` state) filters the actions list. [GAP]
- [ ] "New Custom Action" button (`handleCreate`) opens editor with null action. [GAP]
- [ ] Row Edit button (`handleEdit`) opens editor pre-filled with that action. [GAP]
- [ ] Row enable/disable Switch (`onCheckedChange`→`handleToggleEnabled`) persists enabled flag. [GAP]
- [ ] Row Delete button (`handleDelete`) confirms then removes; delete failure shows message. [GAP]
- [ ] Close button (`onClose`) dismisses panel. [GAP]

### Primary interactions (Editor — `CustomActionEditor.tsx`)
- [ ] Name / description / similes inputs round-trip. [GAP]
- [ ] Handler-type selector http/shell/code/ai (`handlerType`) swaps the config sub-form. [GAP]
- [ ] HTTP: method dropdown (GET/POST/…), URL, header rows (add/remove), body round-trip. [GAP]
- [ ] Shell: command input round-trips. [GAP]
- [ ] Code: code textarea round-trips. [GAP]
- [ ] Parameters editor: add/remove ParamDef rows. [GAP]
- [ ] AI generate: prompt input + Generate (`handleGenerate`, Enter or button) fills the form; `generating` disables. [GAP]
- [ ] Test section expand (`testExpanded`): fill test params → Test (`handleTest`) auto-saves first then invokes; result/error shown. [GAP]
- [ ] Save (`handleSave`) validates then persists; `formError` on invalid; `saving` disables. [GAP]
- [ ] Close (X) button (`onClose`) discards editor. [GAP]

### State matrix
- [ ] Empty: no custom actions → panel shows empty-state + New button. [GAP]
- [ ] Loading actions (`loading`) → skeleton. [GAP]
- [ ] Populated: actions listed with enabled state. [SMOKE customactions-stories-smoke]
- [ ] Save/delete/toggle failure → error message, list unchanged. [GAP]
- [ ] Test with server error → error result rendered, not swallowed. [GAP]
- [ ] Generate failure → formError, form not corrupted. [GAP]

### Repeated / rapid-fire
- [ ] Mash Save → one create/update request, `saving` latches. [GAP]
- [ ] Spam enable/disable toggle on a row → final state persisted matches last toggle, no dup PATCH. [GAP]
- [ ] Double-click New → single editor instance. [GAP]
- [ ] Mash Generate → one generate call at a time (`generating` guard). [GAP]
- [ ] Test twice quickly → save happens once, one test invocation. [GAP]

### Back-and-forth / recovery
- [ ] Open editor, edit, close without save → list unchanged; reopen New starts blank (state reset on open — verify `setTestExpanded/setTestParams/setTestResult` reset). [GAP]
- [ ] Toggle panel closed mid-edit → draft discarded; reopening does not resurrect stale draft. [GAP]
- [ ] Edit existing action → close → reopen shows persisted (not draft) values. [GAP]

### Fuzz / adversarial
- [ ] HTTP URL: `javascript:`/`file://`/SSRF-ish localhost → validated/blocked at save or execution boundary. [GAP]
- [ ] Shell command with `rm -rf`/injection → stored as text; execution gated by confirmation/sandbox. [GAP]
- [ ] Code handler with infinite loop/huge output → Test bounded (timeout), no UI freeze. [GAP]
- [ ] Name with spaces/special chars → validation per action-name rules (`custom-action-form.ts`). [GAP]
- [ ] Similes with 200 comma entries → parsed bounded. [GAP]
- [ ] Emoji/RTL in name/description round-trips. [GAP]
- [ ] Whitespace-only name → Save rejected with formError. [GAP]

### Input modalities
- [ ] Keyboard: Tab through form in logical order; Enter in AI-prompt triggers Generate; Escape closes editor. [GAP]
- [ ] Focus trapped inside modal; returns to trigger on close. [GAP]
- [ ] Touch: header add/remove rows tappable ≥44px on mobile. [GAP]

### A11y / geometry
- [ ] Close button aria-label (`common.close`); Delete/Edit buttons titled. [GAP]
- [ ] axe pass on editor open. [SMOKE story-gate]
- [ ] Save/Generate hover obeys accent rule; no blue. [GAP]
- [ ] Reduced-motion respected for panel transitions. [GAP]

### Concurrency
- [ ] Save while a prior Test's auto-save in flight → single coherent write, no lost update. [GAP]
- [ ] Toggle enabled on row A while deleting row B → both resolve, list consistent. [GAP]

---

## Save Command Modal (`chat/SaveCommandModal.tsx`)

### Entry / Nav
- [ ] Opens from chat message context-menu "save as command"; `isOpen` gates render. [GAP]
- [ ] Escape/backdrop click closes (`onClose`) when open. [GAP]

### Primary interactions
- [ ] Name input round-trips into `name` state. [GAP]
- [ ] Save (`handleSubmit`) validates via `NAME_PATTERN`; invalid → error (`nameRequired`/`nameFormat`), no `onSave`. [GAP]
- [ ] Valid name → `onSave(name)` fires once, modal closes. [GAP]
- [ ] Cancel button (`onClose`) dismisses without saving. [GAP]

### State matrix / rapid-fire
- [ ] Empty name → `nameRequired` error, Save blocked. [GAP]
- [ ] Bad-format name (spaces/symbols failing NAME_PATTERN) → `nameFormat` error. [GAP]
- [ ] Mash Save with valid name → `onSave` called exactly once. [GAP]
- [ ] Reopen after cancel → name field reset to empty. [GAP]

### Fuzz / A11y
- [ ] Emoji/RTL/very-long name → validated by pattern, no crash. [GAP]
- [ ] Focus trapped; auto-focus name input on open; Enter submits. [GAP]
- [ ] Save/Cancel hover obeys accent rule; no blue. [GAP]
- [ ] axe pass. [GAP]

---

## Coverage summary

| View | Existing test path(s) | Biggest gap |
|---|---|---|
| Character Editor | `all-views-interaction.spec.ts` (visit smoke), `character/__tests__/character-stories-smoke.test.tsx` (story render), `App.navigate-view-wiring.test.tsx` (wiring mock) | No behavioral test of the entire save/dirty/reset/nav-guard lifecycle — `handleSaveAll`, `hasPendingChanges`, style add/remove, and the unsaved-nav guard are wholly untested. |
| Character Select / Roster | `all-views-interaction.spec.ts` (visit), `character-stories-smoke.test.tsx` | No test that selecting a roster tile navigates to `/character` with the correct character active; selection/scroll recovery untested. |
| Documents | `packages/app/test/ui-smoke/documents-view.spec.ts` (visual+smoke desktop/mobile), `documents-detail.test.tsx` (2 cases) | Upload paths — drag-drop, Choose Files, URL ingest, text-doc create, scope, failure/dup handling — have zero committed coverage. |
| Fine-Tuning / Advanced | `apps-model-training-interactions.spec.ts` (build dataset + start + cancel job), `internal-tool-apps.test.ts` (routing) | Models-table "Train", validation of bad budget/zero-trajectory, and rapid-fire Start idempotency untested. |
| Automations / Triggers | `automations.spec.ts` (empty/list/create/workflow-JSON/event-trigger), `automation-feed-filter.test.ts`, `scheduled-task-to-automation.test.ts`, `ScheduledTaskEditor.test.tsx`, `AutomationsFeed.test.tsx` (2) | "Run {name} now" (`runWorkflowDefinition`) is never asserted to fire — the one destructive/side-effecting button in the feed has no dup-request/idempotency coverage; error-state of `listAutomations` untested. |
| Custom Actions Panel + Editor | `custom-actions/__tests__/customactions-stories-smoke.test.tsx` (story render only) | Entire editor is untested behaviorally: handler-type switching, HTTP/shell/code config, AI-generate, Test (auto-save+invoke), enable/disable toggle idempotency, and adversarial URL/shell/code inputs — all GAP. Highest-risk surface in the group (executes user-authored HTTP/shell/code). |
| Save Command Modal | `App.navigate-view-wiring.test.tsx` mocks it to `null` | `NAME_PATTERN` validation and single-fire `onSave` have no committed test. |

**Single biggest gap in this group:** the **Custom Actions Editor** (`CustomActionEditor.tsx`) — a surface that lets users author and execute arbitrary HTTP requests, shell commands, and code, plus an AI-generate and a save-then-Test path — has only a Storybook render smoke test. None of its validation, handler-type branching, Test/execute flow, toggle-idempotency, or adversarial-input (SSRF/`javascript:` URL, `rm -rf` shell, injection) behavior is covered by any committed test, despite being the most security-sensitive authoring flow in the app.
