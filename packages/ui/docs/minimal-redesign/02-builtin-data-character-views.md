# UX / Code / State Inventory — Built-in Data / Dev / Character / Content Views

Repo: `/home/shaw/milady/eliza`. Views under `packages/ui/src/components/pages/` and `packages/ui/src/components/character/`. Routes from `packages/ui/src/navigation/index.ts` `TAB_PATHS` (lines 279–314).

Judged against the redesign direction: **minimalism** (cut text/borders/cards/badges/inputs/slop; icon+color+whitespace over text), **lighter feel** (single flat futuristic look, off heavy black; orange `#ff8a24` accent, blue `#1d91e8` info only, white/black/gray), **chat-first** (floating overlay is the primary interface; views are glanceable, voice-forward, view-dependent actions + proactive context + chat integration; exactly what they need, nothing more).

---

## Cross-cutting patterns (apply to all views below)

These recur everywhere and are the highest-leverage fixes:

1. **The uppercase micro-eyebrow label** — `text-2xs/xs-tight uppercase tracking-[0.12–0.16em] text-muted` — is the dominant decorative motif across Database, Memory, MediaGallery, Trajectories, Character, Relationships, Documents. It appears 6–12× per view. Replace with one tiny `<SectionLabel>` primitive and use it sparingly; drop most instances entirely (an icon does the job).
2. **The bordered row-card** — `rounded-sm border border-border/24 bg-card/32 px-3 py-2.x` — wraps every list row in Relationships (6+ duplications), Activity, Candidate-merges, Memory, Documents, Trajectories sidebar. Collapse to borderless rows with at most a hairline `divide-y`. This is the single biggest source of visual weight repo-wide.
3. **`PagePanel` is systematically negated** in DocumentsView/documents-detail with `!rounded-none !border-0 !bg-transparent !shadow-none !ring-0` (~12 occurrences). Strong evidence `PagePanel` is the wrong primitive there — use plain layout `div`s.
4. **Chat-as-search is the established contract** — `useRegisterViewChatBinding` + `ChatSearchHint` replaces in-page search inputs in Database, Memory, Documents, Logs, Relationships, MediaGallery, Trajectories, Help. KEEP this; it is exactly the chat-first direction. It means: there is no search input to redesign — the "search box" is the floating composer.
5. **Pill/badge soup** — `MetaPill`/`IconPill`/`StatChip`/`RowChip`/`FilterChipButton` are re-implemented per-view with the same `rounded-full border bg-*/* px-* py-*` recipe. A shared minimal chip primitive (icon+number, no border) would collapse a large fraction of chrome. Most badges should become plain inline text or icon+color.
6. **Hardcoded off-brand colors** — indigo `rgb(99,102,241)` and purple `rgb(168,85,247)` in Relationships ActivityFeed; blue `rgb(56,189,248)` + green + multi-color graph in CharacterExperienceWorkspace; `#FF5800` BRAND + `bg-red-500/90` in Help/Tutorial/Camera. These violate the no-blue / accent-only brand rule and bypass theme tokens.
7. **Agent-surface coverage is uneven** — heavily instrumented (Browser, Documents-upload, CharacterExperience ~17 hooks) vs zero (Camera, MemoryDetailPanel, documents-detail, RelationshipsCandidateMerges Accept/Reject, graph node-selection). Proactive-agent gaps where actions aren't agent-controllable.

---

## 1. Database (page wrapper)

- **id / route / file:** `database` · `/apps/database` · `DatabasePageView.tsx` (115 lines)
- **Purpose:** Thin segmented-control wrapper that swaps between Tables / Media / Vectors sub-views.
- **States:** sub-tab selection (`tables`/`media`/`vectors`, `databaseSubTab`); vectors lazy-loads a heavy three.js bundle via `DynamicViewLoader` (L98–108).
- **Visual structure:** 1 `SegmentedControl` (L70–76) + 3 ref-less `DatabaseTabButton` agent-surface registrants (L77–85). Each sub-view owns its own `PageLayout`+Sidebar. Wrapped in `ShellViewAgentSurface viewId="database"`.
- **Heaviness/slop:** minimal — it's a clean router. The only note: it duplicates `leftNav` (segmented control) into every branch.
- **Minimization:** fine as-is. The slop is in the children (DatabaseView below).
- **Even-simpler:** Media and Vectors could be top-level tabs rather than nested under "Database" — "Database / Media / Vectors" is an engineering grouping, not a user mental model. Consider promoting Media to the Gallery surface and Vectors to its own dev tool.

## 2. DatabaseView (Tables sub-view) — WORST DEDUP OFFENDER

- **file:** `DatabaseView.tsx` (1073 lines) + `database-utils.tsx` (283 lines)
- **Purpose:** SQL table browser + SQL editor.
- **States:** connecting (L384/713), disconnected (L552/737), loading-tables (L465/807), loading-rows (L604/901), no-table-selected (L577/874), empty-table (L650/956), populated (L611/908), error banner (L546/748), view sub-tabs tables/query (L348–374), SQL editor (L680/990), query-history (L515/1012), cell-inspect modal (L686/1067).
- **Visual structure:** ~19 `PagePanel` usages, ~6 header eyebrow+title blocks, ~10 descriptive text blocks (`QueryWorkspaceInfo`, `TableWorkspaceDescription`, `SQLWorkspaceDescription`, `ChatSearchHint`×4), ~12 pills/chips, ~15 explicit borders, ~8 button kinds. Heaviest JSX — the refresh button className is a ~600-char gradient+backdrop-blur+transition monster at `DatabaseView.tsx:410`, **copy-pasted verbatim 3×** (`:410`, `:524`, `:1021`). database-utils renders per-cell `border-r/border-b` gridlines (`:138`/`:178`) and an out-of-system `rounded-b-2xl` (`:242`).
- **Heaviness/slop:** **The entire component is rendered twice** — `showExternalSidebar` branch (L428–694) and legacy branch (L696–1072) re-implement the same screen: two table lists, two refresh buttons, two query-history blocks, two empty states, two `CellPopover` mounts. This is the single largest bloat in your view set. Plus the triplicated mega-className, 6 "DATABASE" eyebrows, per-cell gridlines, 10-branch type-badge color map.
- **Minimization:** (a) **Delete the legacy branch entirely** (~380 lines) — the shell layout is the live path. (b) Extract the gradient button to one `variant`. (c) Drop all `ChatSearchHint` repeats to one. (d) Remove the "DATABASE" eyebrows. (e) De-gridline the table (`database-utils`): hairline `divide-y` only, no `border-r`. (f) Drop the per-column type-badge color circus — show type only in a header tooltip. Essential info: table list + rows + run-query. Surface "explain this table / run a query" as chat affordances (already bound).
- **Even-simpler:** This is a power/dev tool. It could be demoted behind an "Advanced" gate. Most users will never open it; the agent can answer "how many memories do I have" in chat without exposing raw SQL.

## 3. MediaGalleryView

- **id / route / file:** `database` (media sub-tab) · `/apps/database` · `MediaGalleryView.tsx` (599 lines)
- **Purpose:** Scans DB tables for image/video/audio URLs; sidebar list + detail preview.
- **States:** loading (L477/437, rendered twice), error (L473), empty-no-media (L481), empty-no-match (L492), image/video/audio detail (L527/533/541), filter chips all/image/video/audio (L423–433), selected-item header (L499), media-details panel (L559).
- **Visual structure:** ~7 panels, 4 bordered filter chips (`:197`), per-item double type indicator (first-letter badge `:243` + type pill `:252`), detail type badge (`:510`), 3 uppercase micro-labels in details grid. `ChatSearchHint` (`:418`).
- **Heaviness/slop:** **Redundant detail metadata** — the header (L499–520) already shows title/type/source/date; the Media-Details panel (L559–593) re-prints Type/Source/URL. Double type indicator per list item. Duplicate "Scanning…" loading copy (`:439`,`:479`). Border-boxed chips.
- **Minimization:** Delete the Media-Details panel (redundant with header) — keep only the URL as a copy affordance. One type indicator per item. De-border filter chips into a segmented control or icon row. Essential: thumbnail grid + click-to-preview. Chat already drives search.
- **Even-simpler:** Could become a true grid of thumbnails (not list+detail) with the floating chat handling filter/find ("show me the videos from yesterday"). Merge with a future unified "files" surface alongside Documents.

## 4. MemoryViewerView + MemoryDetailPanel

- **id / route / file:** `memories` · `/apps/memories` · `MemoryViewerView.tsx` (853 lines); `MemoryDetailPanel.tsx` (131 lines, used by VectorBrowser not this view)
- **Purpose:** Feed/Browse browser over agent memories, with stats + type filters + people list.
- **States:** view-mode feed/browse (L816), feed loading/error/empty/populated (L295/299/307/324), browse loading/error/empty/populated (L471/473/477/496), card collapsed/expanded (L161), stats loading/error/loaded (L642), people loading/empty/loaded (L759), person-selected filter context (L822), type filter (L674).
- **Visual structure:** `MemoryCard` bordered button per memory (`:164`), memory-type badge + source label + relative-time per card, type-filter pill row ("All" + per-type with colored dot, `:679`/`:697`), stats grid (Total + per-type cards), expanded card shows 4 labeled UUID rows (Entity/Room/Created/ID). Wrapped in `ShellViewAgentSurface viewId="memories"`; `useRegisterViewChatBinding` binds browse search (only when not person-scoped); `ChatSearchHint` (`:470`).
- **Heaviness/slop:** **Memory types displayed in THREE places** — per-card badge, type-filter pills, AND stats grid. Expanded card dumps raw UUIDs (Entity/Room/ID) — low value, heavy. Two near-duplicate panels (`MemoryFeedPanel` vs `MemoryBrowserPanel`) with parallel loading/error/empty/list logic. Uppercase micro-labels everywhere. `MemoryDetailPanel` (separate, for vectors) has redundant id (header + metadata grid) and redundant type (h2 + metadata), 3 stacked bordered cards for a key/value dump.
- **Minimization:** Pick ONE place to show types (the filter pills double as the legend; drop the stats grid or shrink to a single total count). Remove raw UUIDs from the expanded card (keep created-time + a copy-id button). Unify Feed/Browse into one list with a time-vs-relevance toggle. De-border memory cards → divider rows. Surface "summarize my recent memories" / "forget X" as chat actions.
- **Even-simpler:** Feed and Browse are two views of the same data; merge to one. The whole stats sidebar is dev-facing — could be a single glanceable count + the agent answering "what do you remember about me" in chat.

## 5. LogsView

- **id / route / file:** `logs` · `/apps/logs` · `LogsView.tsx` (352 lines)
- **Purpose:** Filterable mono-font log table.
- **States:** initial loading (L247), load error (L229), empty/no-match (L249), populated (L265), client search (chat-bound), filters level/source/tag (L133/151/170), refresh (L202).
- **Visual structure:** filter `PagePanel` with "Filter logs" heading + count chip + `ChatSearchHint` + 3 `Select`s + Clear + Refresh + 2 status pills; custom CSS-grid "table" reimplemented in divs (`:267`). Per-row tag badges with an **inline 7-key color-map object re-allocated per row** (`:314–330`) + inline `style fontFamily` per badge. Wrapped in `ShellViewAgentSurface viewId="logs"`.
- **Heaviness/slop:** **Two redundant count surfaces** — `filteredLogs.length` chip (`:127`) AND "Showing N entries" pill (`:212`). "N active filters" pill (`:220`) is metadata-about-metadata. Per-row color-map re-alloc (perf+slop). Comment narrates a past refactor (L20–25). Tall busy filter header before any content. No per-control `useAgentElement` (agent can't drive the filters).
- **Minimization:** One count, not three. Drop the "N active filters" pill (the chips show their own active state). Hoist the tag color map to a module constant. Collapse the filter row to icon-buttons that reveal on demand. Instrument the level/source filters with `useAgentElement` so the agent can "show me only errors."
- **Even-simpler:** Logs are pure dev/diagnostic — gate behind Advanced. The agent reading "show me the last error" in chat covers 90% of use; the full table is for debugging only.

## 6. Documents (DocumentsView + documents-detail + documents-upload)

- **id / route / file:** `documents` · `/character/documents` · `DocumentsView.tsx` (1374), `documents-detail.tsx` (393), `documents-upload.tsx` (511)
- **Purpose:** Knowledge/documents browser (scope-filtered list + search + upload) with a detail viewer.
- **States:** loading/skeleton (L1206), service-warming 503 (L1338, exp-backoff retry), load error+retry (L1348), empty-no-docs (L1210), empty-no-match (L1219), empty-no-search-results (L1236), populated list, search mode (debounced server search L1111), client filter, uploading + progress (L382 in upload), deleting (per-id), scope filter chips×5, embedded/inModal/compact layout variants, desktop large-file confirm modal. Detail: no-selection, loading, error, populated, **editing form** (Textarea + Save), preview (2000-char truncate), fragments list/empty. Upload: drag-over, URL-form toggle, text-form toggle, scope selection, image-descriptions toggle, uploading-disabled.
- **Visual structure:** **PagePanel negated 7×** in DocumentsView, 5× in detail (`!rounded-none !border-0 !bg-transparent ...`). **Up to 4 badges per list row** (scope/type/editable/locked, `:286–304`); detail has a **9-badge metadata bar** (`:202–250`). Four parallel item components (full list, search-result, compact-doc-chip, compact-search-chip). Upload carries 3 input modes at once (files/URL/text) + scope chips + checkbox. `useRegisterViewChatBinding` for search; 14 `useAgentElement` across upload+list+chips; `ChatSearchHint`. **documents-detail has ZERO agent instrumentation** (agent can't drive Edit/Save).
- **Heaviness/slop:** PagePanel-as-styleless-wrapper everywhere. Badge overload (9 on detail, 4 per row). Three near-identical empty states. **Scope metadata defined 3×** with drifting shapes (`DocumentsView` SCOPE_FILTER_OPTIONS `:66`, detail ternary `:111`, upload options `:33`). Per-fragment chrome (numbered chip + "Chunk" label + 3-part meta line). Hardcoded English bypassing i18n in detail.
- **Minimization:** (a) Drop `PagePanel` for plain divs in DocumentsView/detail. (b) Collapse the 9-badge detail bar to one compact meta line (scope · type · size · date as plain text). (c) Reduce list rows to filename + one scope dot; drop type/editable/locked badges (show on detail only). (d) One canonical scope descriptor shared by all three files. (e) Delete the compact-chip variants if the rail handles narrow widths via CSS. (f) Instrument detail Edit/Save with `useAgentElement` so "edit this doc" works from chat. (g) Upload: collapse URL/text into a single "+" that the chat can also drive ("add this URL to my knowledge").
- **Even-simpler:** Documents could be largely chat-driven — "what do you know about X", "add this file", "forget that doc." The list view is a glanceable index; the editor and fragments inspector are dev-facing and could be demoted.

## 7. Relationships (workspace + sidebar + panels + graph + activity + merges)

- **id / route / file:** `relationships` · `/apps/relationships` · `RelationshipsView.tsx` (15, thin wrapper) → `relationships/RelationshipsWorkspaceView.tsx` (orchestrator), `RelationshipsSidebar.tsx`, `RelationshipsPersonPanels.tsx`, `RelationshipsActivityFeed.tsx`, `RelationshipsCandidateMergesPanel.tsx`, `RelationshipsGraphPanel.tsx` (1295), `RelationshipsIdentityCluster.tsx` (47)
- **Purpose:** People/identity knowledge-graph workspace: force-graph + per-person detail + activity feed + identity-merge proposals.
- **Composition:** page header comes from `contentHeader`/PageLayout (none of these files render a title). Sidebar = people list. WorkspaceView owns all state + toolbar + layout. PersonPanels = the detail body (summary + 6 data panels). GraphPanel = SVG canvas.
- **States:** graph loading (`:294`), graph error full-panel (`:285`) + inline banner (`:355`) + detail error banner (`:279`) — **three error surfaces**; empty no-people (`:298` with decorative stat tiles); populated; detail populated/loading/no-selection; owner-name inline editor form; per-panel empty (6×); documents-panel loading/error; many `<details>` disclosures; candidate-merges per-card pending/error; graph selection/tooltip/zoom states.
- **Visual structure:** Heaviest JSX is the repeated `rounded-sm border border-border/24 bg-card/32 px-3 py-2.x` row card — `RelationshipsPersonPanels.tsx:758/833/909/994/1057/1252`, `RelationshipsActivityFeed.tsx:126`, `RelationshipsCandidateMergesPanel.tsx:126`. Summary header stacks 3 count pills + button + label pills + contact cards + profiles `<details>`. `PanelMarker` count pill on every panel. Graph container has a huge radial+linear gradient className (`:1097`). Off-brand indigo/purple rgba in ActivityFeed (`:14–28`).
- **Heaviness/slop:** Every list row in every panel is its own bordered box — dominant weight. Pill overload (count shown twice via aria + visible pill). **Over-built empty state** with non-functional decorative stat tiles (`:316–350`). **Dead computation** in GraphPanel — `modeLabel`/`truncated` computed throughout `buildVisibleGraph` but never rendered. Triple-nested disclosures in Preferences. Owner-relationship section duplicates metrics. Hardcoded English in ActivityFeed.
- **Minimization:** (a) De-border all row cards → divider rows. (b) Collapse summary header to name + avatar + 2 essential counts (identities, facts) — drop the rest into the panels. (c) One unified error banner. (d) Remove decorative empty-state stat tiles → single line "No people yet." (e) Delete the dead `modeLabel` computation. (f) Fix indigo/purple → theme tokens. (g) Instrument Accept/Reject, sidebar selection, activity load-more, graph node-selection with `useAgentElement` (currently agent can't drive merges or selection). Essential: the graph + the selected person's facts; the agent narrates relationships in chat.
- **Even-simpler:** This is a rich dev/power surface. The graph is the glanceable hero; everything else (6 data panels, activity feed, merges) could be progressively disclosed or chat-answered ("who do I talk to most", "merge these two contacts"). Candidate-merges could be an agent-initiated chat prompt rather than a standing panel.

## 8. AutomationsFeed

- **id / route / file:** `automations`/`triggers` · `/automations` · `AutomationsFeed.tsx` (997 lines)
- **Purpose:** Unified list of tasks AND workflows; click opens the matching editor.
- **States:** loading skeleton (L451), empty with custom SVG illustration (L453), populated feed (L479), error banner (L443), filter chips all/tasks/workflows/active/inactive (L426), task-editor mode (full replace, L320), workflow-editor mode (L344), create-chooser modal (L529/868), workflow-loader error/loading/success (L966/981/988). Wrapped in `ShellViewAgentSurface viewId="automations"`.
- **Visual structure:** header = gradient medallion + h1 + 2 StatChip counts + Refresh + New. 5 FilterChipButtons each with a **nested count pill**. Per row: 36px medallion + title + StatusBadge + **up to 4 RowChips** (type/schedule/lastRun/lastUpdated). Custom ~80-line SVG empty illustration (L784). Chooser modal with 2 verbose-description option cards.
- **Heaviness/slop:** **Type signaled twice per row** — the medallion icon (L656) AND a "Task/Workflow" type chip (L678) encode the same thing. Header stat chips restate counts the filter chips already show. Four parallel pill components (StatChip/FilterChipButton/RowChip/StatusBadge). Filter chips carry count pills (badge-in-badge). 80-line hand-built SVG for an empty state. Verbose chooser copy. Comment narrates why it's separate from AutomationsView.
- **Minimization:** Drop the redundant type chip (medallion already encodes it). Drop header StatChips (filters show counts). Remove filter count pills. Reduce rows to: icon + name + next-run time + a run/pause action on hover. Replace the SVG illustration with a single icon + "No automations yet" + CTA. Unify the 4 pill components into one. Surface "create an automation" / "pause all" as chat actions (it already listens for `eliza:automations:setFilter` and `VISUALIZE_WORKFLOW_EVENT` — good proactive hooks).
- **Even-simpler:** The create-chooser modal (task vs workflow) is a decision the agent could make — "remind me every morning" → task; "when X, do Y and Z" → workflow. Let chat create automations and have this view just list them.

## 9. BrowserWorkspaceView

- **id / route / file:** `browser` · `/browser` · `BrowserWorkspaceView.tsx` (2990 lines)
- **Purpose:** Multi-tab in-app browser (desktop OOPIF webviews / web iframes / cloud screenshot preview) with agent-driven tabs, address bar, and EVM/Solana wallet + vault-autofill consent bridging.
- **States:** loading (L2622), empty + Browser-Bridge card (L2618), desktop/web/cloud populated modes (L2748/2778/2852), frame-blocked fallback (L2786), cloud snapshot pending (L2918), load/snapshot error banners, busy "watch" banner (L2583), wallet consent modal (L1045), vault autofill consent modal (L1417), tabs sidebar 3 sections (user/agent/app) + collapsed rail, address bar.
- **Visual structure:** toolbar = 5 nav buttons + address Input + go. Tabs sidebar = `AppPageSidebar` + 3 `CollapsibleSidebarSection` (props duplicated verbatim 3×) + per-tab rows (activate w/ monogram+agent-dot + 2-line label/description + close). Cloud mode = 3 stacked strips (header pills + screenshot + footer meta). **Entire browser chrome is agent-controllable** via `useAgentElement` (nav, address fill, tab switch/close); `setBrowserTabsRendererImpl` exposes `evaluate(tabId, script)` so the agent drives the page; 4 proactive polling intervals. Page-scoped chat wired but disabled/collapsed by default.
- **Heaviness/slop:** **Browser-Bridge install action set triplicated** (empty card L2709, chat actions L2129, status affordance) with duplicated copy. **~7 multi-line explanatory paragraphs**, several saying the same thing ("real browser session, not a raw iframe"). Cloud mode shows URL/label in 3 places (tab row + address bar + footer). Three near-identical collapsible sections. Heavy `border bg-card` layering on every chrome element. Defensive `catch {}` with comment-only justification.
- **Minimization:** De-triplicate the Browser-Bridge actions to one source. Cut the 7 explanatory blurbs to ≤2. Cloud mode: one strip, not three (URL is already in the address bar). Parameterize the 3 collapsible sections. Tab rows: name + favicon only; move the `Internal·provider·status·url` description to a tooltip. The agent-driving + watch-banner + wallet consent are the genuinely valuable, view-dependent surfaces — keep and foreground them.
- **Even-simpler:** This is inherently complex (real browser), but the empty-state Browser-Bridge onboarding is a candidate for a chat-driven setup flow. The view itself can't be removed, but its chrome can shed ~half its weight.

## 10. Trajectories (TrajectoriesView + TrajectoryDetailView)

- **id / route / file:** `trajectories` · `/apps/trajectories` · `TrajectoriesView.tsx` (620), `TrajectoryDetailView.tsx` (767). **NOT a plugin** — first-party `@elizaos/ui` builtin (do not confuse with `plugins/plugin-trajectory-logger`, a separate optional dev overlay at `/trajectory-logger`). Data via typed `client` → `@elizaos/plugin-training` HTTP routes.
- **Purpose:** Master/detail debug view of agent reasoning trajectories (LLM calls, pipeline stages, events, cache, provider accesses).
- **States:** sidebar loading/empty/populated (L496/500/507), content loading/empty/error (L601/603/595), pagination (L543, pageSize 50), inline confirm-delete + clear-all forms, 5-format export dropdown, busy sub-states. Detail: loading/error/not-found/populated; ~9 conditional sub-panels; stage-filter sub-tabs; per-call expand/collapse. Wrapped in `ShellViewAgentSurface viewId="trajectories"`; `useRegisterViewChatBinding` for search; `useAgentElement` on the clear-stage-filter button.
- **Visual structure:** Duplicated 3-line `triggerClassName/confirmClassName/cancelClassName` walls across both ConfirmDeleteControls (`:453–455`, `:475–477`). Two color maps (STATUS_COLORS 3, SOURCE_COLORS 6) with hand-mixed rgba. 5 export options. 3 decorative empty-state feature chips. Detail: ~7 `uppercase tracking-[0.16em]` eyebrow labels + 5 `0.14em` variants; **triple-duplicated scroll-`<pre>` className** (`:549`,`:673`,`:684`); up to 9 stacked bordered sections; panel-in-panel nesting.
- **Heaviness/slop:** Detail density is the problem — 9 sections, ~12 eyebrow labels, 3 duplicated pre blocks. Heavy presentation-layer computation/normalization in the view (~15 helper functions, `?? 0`/dual-field-name coalescing papering over an inconsistent event schema). Export menu is heavy for a debug tool.
- **Minimization:** Unify the eyebrow label + the scroll-pre into primitives. Collapse the 9 sections behind disclosure (show orchestrator summary + LLM-call list by default; everything else on demand). One ConfirmDelete style. Reduce export to a single "Export JSON." Move the schema-coalescing logic to the API/mapper layer (per architecture rules, presentation shouldn't normalize).
- **Even-simpler:** Pure dev/diagnostic surface — gate behind Advanced. It exists to debug the agent; most users never need it. The sibling composites under `components/composites/trajectories/` own most of the visual weight and must be touched for any real redesign.

## 11. CameraPageView

- **id / route / file:** `camera` · `/camera` · `CameraPageView.tsx` (275 lines) — AOSP-shell-gated
- **Purpose:** Full-bleed live camera with capture/switch + captured-photo review.
- **States:** starting (L155), live (L226), denied (L164), error (L184), captured-review/lightbox (L205), non-fatal error toast (L264), busy/capturing.
- **Visual structure:** no header, no cards, no badges. ~5 state-exclusive buttons. Switch + capture buttons have intentional ring borders (control affordances, not chrome). **Already the cleanest file in the set.**
- **Heaviness/slop:** minimal. Only off-brand: `bg-red-500/90` toast (L268) bypasses the `danger` token; two near-identical denied/error overlays.
- **Minimization:** Align the toast to `danger` token. Optionally collapse denied/error overlays to one parameterized component. Otherwise leave it — it's already minimal and voice-forward (full-bleed).
- **Even-simpler:** No — a camera needs a camera surface. **Gap:** zero agent/chat integration — "take a photo" can't be triggered from chat. Add `useAgentElement` on the capture button so the agent can drive it.

## 12. Character surface (Hub + Editor + panels + sections)

- **id / route / file:** `character` · `/character` · `character/CharacterHubView.tsx` (1047, the page shell), `CharacterEditor.tsx` (1639, controller + companion-overlay), `CharacterEditorPanels.tsx` (1007), `CharacterOverviewSection.tsx` (173, landing grid), `CharacterRoster.tsx` (182, avatar picker, NOT on hub page), `CharacterPersonalityTimeline.tsx` (116, **orphan on this route**), `CharacterLearnedSkillsSection.tsx` (368), `CharacterExperienceWorkspace.tsx` (1561, **heaviest file in the entire set**)
- **Composition:** `CharacterEditor` (exported as the route component) is a controller that, with `sceneOverlay=false`, delegates entirely to `CharacterHubView`. The hub renders a 5-tile overview grid → sub-sections (overview/personality/documents/skills/experience/relationships). The `sceneOverlay=true` path is the legacy companion-overlay tabbed editor.
- **States:** full-screen loading gate; section router (6 sections); per-source loading/error flags (documents/history/relationship-activity/learned-skills/experience); autosave debounce (700ms) coexisting with a manual Save; unsaved-changes + reset modals (overlay); style/examples edit buffers + drag-reorder + duplicate detection; experience triage with 6 filters + selection + edit form.
- **Visual structure / heaviness:**
  - `CharacterHubView`: **duplicate `listDocuments` fetch** (L414 + L468); 6 independent fetch effects with identical boilerplate; **two save paths** (manual Save button + 700ms autosave) for the same data; `historyError` captured then discarded (L215); chip-heavy overview tile bodies.
  - `CharacterEditor`: **~20 unused `useApp()` destructures** (registry/drop/wallet wiring) still pulled in, with `loadRegistryStatus`/`loadDropStatus` still called on mount (L302); hand-rolled SVG icon factory duplicating lucide; `onClick`+`onActivate` duplicated on every button; 3 inline accent-style objects with hardcoded `240,185,11`.
  - `CharacterEditorPanels`: **`STYLE_SECTION_KEYS = ["all"]`** — a single-element loop with maps keyed by one value (leftover multi-section infra); a dead no-op ternary (L243); 3 help paragraphs; duplicate-detection warning badges + count pills.
  - `CharacterOverviewSection`: 5 gradient medallion tiles with a 3-layer radial/linear gradient system; `isLoading` prop threaded but never used.
  - `CharacterPersonalityTimeline`: **not imported by the hub** — dead UI on `/character` (history is fetched only to set an overview "hasContent" flag).
  - `CharacterLearnedSkillsSection`: 4-stat uppercase meta row per skill; 3 near-identical SkillSection invocations; **duplicate `/api/skills/curated` fetch** (also fetched in the hub); long empty-copy paragraph.
  - `CharacterExperienceWorkspace`: **the worst single file** — a full custom force-graph (5 stacked glow `<span>`s per node), hardcoded blue `rgb(56,189,248)` + green + multi-color graph background (`:555`, violates no-blue), 6-control filter bar + 4 stat tiles + graph + queue + deeply nested detail panel with ~10 inputs and engineering-facing provenance IDs (room/trigger/trajectory/embedding dims), ~17 `useAgentElement` callsites, bespoke ranking math in presentation.
  - Heavy `useAgentElement` instrumentation throughout (good for chat-driving); `ShellViewAgentSurface viewId="character"`; voice/avatar bridge in the overlay path.
- **Minimization:** (a) **Delete the legacy `sceneOverlay` overlay editor path and its dead registry/drop/wallet wiring** if the companion 3D scene isn't the live `/character` surface — this is hundreds of lines. (b) Remove the duplicate document fetch and the curated-skills double-fetch; consolidate 6 effects into one data hook. (c) Pick ONE save path (autosave) — drop the manual Save button + divider. (d) Delete the orphan `CharacterPersonalityTimeline` or wire it in. (e) Collapse `STYLE_SECTION_KEYS` single-key abstraction. (f) **CharacterExperienceWorkspace:** drop the decorative force-graph (or make it opt-in), fix blue→accent, collapse the 6-filter bar to a search + the chat, hide provenance IDs behind an "advanced" toggle, reduce stat tiles to one. (g) Strip help paragraphs + count badges from the panels.
- **Even-simpler:** The character surface is the one place where editing is legitimately needed, but most of it is voice-addressable: "make her more sarcastic", "add an example", "what has she learned." The Experience workspace and Learned-Skills section are agent-introspection surfaces that could be chat-answered + a thin review queue rather than full graph/triage UIs. The overview grid is a reasonable glanceable hub; the deep editors should be progressively disclosed.

## 13. GeneratedViewHero

- **file:** `GeneratedViewHero.tsx` (232 lines)
- **Purpose:** **Not** the GenUI/A2UI renderer and **not** a header bar — it's a deterministic procedural thumbnail/hero-fill for view cards in the launcher/views grid that lack a real preview (FNV-1a hash of `viewId` → stable palette/shape/pattern). Pairs with `src/genui/` but is purely the placeholder art layer.
- **States:** no React state — pure deterministic render. Conditionals: pattern overlay vs none, pinned vs hashed palette, compact sizing.
- **Visual structure:** one gradient root div + SVG pattern overlay + oversized corner icon + centered glyph disc + bottom scrim (~5 layers). No header/cards/badges/inputs.
- **Heaviness/slop:** ~60 of 232 lines are doc/inline comments, several restating the obvious ("Centered foreground glyph…"). Two icon renders for one tile. Hardcoded hex palette (acknowledged as intentional brand-curated). Otherwise tight — the visual weight is deliberate decorative artwork.
- **Minimization:** Trim the narrating inline comments (keep the palette-rationale block). No structural change needed — it's a fill, not a page.
- **Even-simpler:** No. It's the right size for its job. No agent/chat hooks (correct — it's presentation-only).

## 14. Help

- **id / route / file:** `help` · `/help` · `help/HelpView.tsx` (185), `help/help-content.ts` (547)
- **Purpose:** Knowledge-base whose search box IS the floating chat composer; accordion results.
- **States:** empty/no-match (L117), browse (not searching, L107), searching (L102), accordion collapsed/expanded per entry. No loading (static), no modal. **Strong chat integration** via `useRegisterViewChatBinding` (composer placeholder "Ask a question about Eliza…", live draft → search); proactive auto-open-best-match effect (L61); deep-links can `startTutorial()`.
- **Visual structure:** 1 h1 + subtitle; up to 23 bordered accordion cards; per expanded entry a category badge + optional deep-link button. **`help-content.ts` = 23 entries** grouped in 9 categories, ~16 with deep-links; answers 2–4 sentences each.
- **Heaviness/slop:** Inline `onMouseEnter/onMouseLeave` orange→`#D44A00` hover on the deep-link button (L162) — **duplicated verbatim in TutorialSpotlight** (L279). Hardcoded `BRAND = "#FF5800"` (also in TutorialSpotlight) instead of a token. 5+ distinct text-opacity tiers, bespoke `text-[Npx]` sizes. Category badge adds noise (categories are never used as a filter — `HELP_CATEGORIES` is exported but dead). **Content near-duplication** in help-content: navigation entries overlap, 3 AI-model entries overlap, 3 Cloud entries repeat "optional/hosted", 2 voice entries overlap.
- **Minimization:** Extract one orange-button primitive (CSS hover) to kill the duplicated inline handlers in Help + Tutorial. Drop the category badge (or wire `HELP_CATEGORIES` as a real filter — pick one). Consolidate the ~8 near-duplicate help entries down to ~15. Collapse the opacity/size sprawl to a token scale.
- **Even-simpler:** Help is the most chat-replaceable view in the set — its entire purpose (ask a question, get an answer) is what the agent does natively. It could shrink to a thin "popular questions" list + the chat, with the 23-entry knowledge base feeding the agent's retrieval rather than a standalone accordion. **Strong merge/remove candidate.**

## 15. Tutorial (launcher + overlay + spotlight + steps)

- **id / route / file:** `tutorial` · `/tutorial` · `tutorial/TutorialView.tsx` (31, pure launcher — no UI, kicks off the overlay then redirects to chat), `tutorial/TutorialOverlay.tsx` (185, always-mounted engine), `tutorial/TutorialSpotlight.tsx` (303, portal spotlight), `tutorial/tutorial-steps.ts` (181, 10 steps)
- **Purpose:** Guided first-run tour — spotlights real chat controls, auto-advances on user action, narrates via speech.
- **States:** TutorialView is a launcher only. Overlay: inactive/null, active text-mode, active voice-mode, per-step "succeeded" beat, continue-fallback, last step, first-run auto-launch. Spotlight: SSR guard, no-target centered card, target-hole, blocking vs non-blocking, 3 card placements, reduced-motion, voice-busy pulse.
- **Visual structure:** Overlay renders no chrome (delegates to Spotlight). Spotlight: portal `fixed inset-0` + up to 4 backdrop rects + glow ring + card (Step X/Y badge + mode pill + h3 + p + Skip + Continue). `tutorial-steps.ts` = 10 steps, each with `body` + `voiceLine` + sometimes `voiceCommandHint`.
- **Heaviness/slop:** Densest className in the set is the Spotlight card (`TutorialSpotlight.tsx:235`, 9 utilities). Duplicated inline hover handler + `BRAND`/`#D44A00` (shared with Help). `zIndex: 2147483000` magic constant. **Dual-copy maintenance** — every step has `body` AND `voiceLine` (paraphrase drift), 3 steps add a third `voiceCommandHint` variant = ~20–23 hand-maintained strings for 10 steps. Three near-identical chat-detent drill steps (expand/minimize/reopen). Emoji in titles. Comment narrating a past fix (steps L147). 200ms polling loop while active. 7+ alpha tiers in Spotlight.
- **Minimization:** Share the orange-button primitive with Help. Derive `voiceLine` from `body` (or trim) to kill the dual-copy. Collapse the 3 chat-detent drills into 1. Move the z-index to a token. The tutorial is correctly voice-forward and chat-targeting — keep the structure, trim the copy and the duplicated styling.
- **Even-simpler:** The 3 redundant chat-drill steps could merge; the tour is otherwise appropriately lightweight (overlay, not a page). The launcher pattern (no UI, redirect to chat) is exactly right.

---

## Wiring notes (App.tsx)

- `automations`/`triggers` both render `<AutomationsFeed />` (App.tsx:764–765).
- `documents` is special-cased through `tab === "documents"` (App.tsx:843), nested under `/character/documents`.
- Most data views are lazy-loaded (`lazyNamedView`): Camera (150), Tutorial (174), Help (178), MemoryViewer (197), etc.
