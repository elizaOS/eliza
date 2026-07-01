# Data & Runtime Views — QA Checklist

Scope: FilesView, DatabaseView (+DatabasePageView/SqlEditorPanel), MemoryViewerView, TrajectoriesView (+TrajectoryDetailView), TranscriptsView, LogsView, RelationshipsView (RelationshipsWorkspaceView), SkillsView, PluginsView (+PluginCard/reorder), TasksPageView (ScheduledTaskEditor), RuntimeView.
Source: `packages/ui/src/components/pages/*View.tsx`, `packages/ui/src/components/transcripts/*`, `packages/ui/src/components/pages/relationships/*`.
Legend: `[COVERED: <spec>]` = a committed test exercises it; `[GAP]` = no committed test found.

---

## FilesView  (route `files` → `/apps/files`; App.tsx wraps in TabScrollView)

### Entry / Nav
- [ ] Reach via `/apps/files` deep-link on fresh reload → `data-testid="files-view"` renders, `aria-busy` while loading. [COVERED: files-view.spec.ts (viewport matrix)]
- [ ] Reach via apps grid tap on the Files tile → same view mounts. [COVERED: files-view.spec.ts]
- [ ] Reach via chat "show me my files" / view-chat-binding routing → composer becomes the filename filter (`onQuery` wired). [GAP]
- [ ] Back-button after opening a file action returns to grid with facet + query preserved. [GAP]

### Primary interactions
- [ ] Facet chips All/Images/Audio/Video/Documents (`file-facet-<facet>`): clicking sets `facet`, `aria-pressed` flips, grid narrows to matching `kindForMime`, count badge matches actual filtered count. [GAP — facet filter logic untested]
- [ ] Filename filter (floating composer `onQuery`→`setQuery`): typing narrows grid case-insensitively; clearing restores full list. [GAP]
- [ ] Download button (`file-download`): invokes `downloadAttachment(resolveAppAssetUrl(url), fileName)` — assert served URL + filename, not "no error". [GAP — no download assertion; share is covered but not download]
- [ ] Share button (`file-share`, only when `canShareFiles()`): invokes `shareAttachment` with served url+title; falls back to download when share returns false. [COVERED: files-view-share-journey.spec.ts (Web Share API invoked)]
- [ ] Delete button (`file-delete`): `window.confirm` shown; on confirm fires `DELETE /api/files/:filename`, optimistic row removal; on `deleted:false` or throw the row is restored + error alert. [COVERED (happy path): files-view-crud.spec.ts; GAP: rollback-on-failure path]
- [ ] Retry button (`files-retry-load`) in error alert re-calls `listFiles`. [GAP]

### State matrix
- [ ] Empty (0 files): `files-empty` with `ChatEmptyStateWithRecommendations` (3 recs). [GAP — asserted structure]
- [ ] Loading: `files-loading` spinner, `aria-busy=true`. [COVERED: files-view.spec.ts waits on visible]
- [ ] Populated: `files-grid` 1/2/3-col responsive; each `file-card` shows name/kind/size/relative-date. [COVERED: files-view.spec.ts (visual)]
- [ ] Filter-empty (query/facet excludes all): `files-empty-filter` PagePanel.Empty (distinct from zero-files empty). [GAP]
- [ ] Failed fetch: `listFiles` rejects → `role=alert` with message + Retry. [GAP]
- [ ] Image cards render `<img>` preview from `resolveAppAssetUrl(url)`; broken URL must not crash card. [GAP]
- [ ] Many items (100+): grid virtualization/scroll perf, no layout thrash. [GAP]

### Repeated / rapid-fire
- [ ] Mash Delete on same card: single confirm, single DELETE, `deletingName` guards double-fire, button `disabled` while deleting. [GAP]
- [ ] Rapid facet chip toggling: only final facet active, counts stay correct (invariant: Σ facet counts − all == 0). [GAP]
- [ ] Double-click Download: no duplicate download prompts beyond user intent (helper is idempotent per call). [GAP]

### Back-and-forth / recovery
- [ ] Delete a file → leave view mid-DELETE → return: grid reflects server truth after reload (not stale optimistic). [GAP]
- [ ] Switch files→database→files rapidly: no latched spinner, `loadFiles` re-runs, query/facet reset cleanly. [GAP]
- [ ] Background app during load then resume: load completes or re-fires; no stuck `aria-busy`. [GAP]

### Fuzz / adversarial
- [ ] Filename filter with emoji/RTL/whitespace-only/2000-char paste: no crash, filter still matches substring; whitespace-only trimmed to no-op. [GAP]
- [ ] File with pathological name (`../`, quotes, unicode) → `agentSafeId` sanitizes to `[a-z0-9_-]`; delete confirm string escapes name. [GAP]
- [ ] mimeType empty / malformed (`;` only) → `kindForMime` falls back to `document`, no throw. [GAP]

### Input modalities
- [ ] Tab order: facet chips → search → per-card Download/Share/Delete; Enter activates focused button. [GAP]
- [ ] Touch: tap targets ≥44px on mobile viewport; long-press does not misfire delete. [GAP — mobile viewport rendered but no tap-target assertion]
- [ ] No drag-drop upload wired here (files come from chat/agent) — assert dropping a file is a no-op, not a browser navigation. [GAP]

### A11y / geometry
- [ ] `role=toolbar` on facet bar, `aria-label` present; `role=alert` on error; axe pass after delete. [GAP]
- [ ] Facet active = `bg-accent/15 text-accent` (orange accent, no blue); hover neutral→neutral-opacity. [COVERED (visual): all-views-aesthetic-audit.spec.ts / builtin-views-visual.spec.ts]
- [ ] Destructive delete uses `surfaceDestructive` variant, not raw red-on-orange. [GAP]

### Concurrency / races
- [ ] Delete A while Delete B in flight: both DELETEs independent, both rows removed, both restore correctly on respective failure. [GAP]
- [ ] `loadFiles` (retry) fired while a delete is optimistic: server list wins, no resurrected deleted row. [GAP]

---

## DatabaseView  (route `database` → `/apps/database`; App.tsx renders `DatabasePageView`)

### Entry / Nav
- [ ] `/apps/database` fresh reload → `database-view`, seeds from `getCached("db:status")`/`db:tables` then revalidates. [COVERED: DatabaseView.test.tsx (connecting→loaded)]
- [ ] DatabasePageView wrapper (117 lines) supplies leftNav/contentHeader → assert sidebar + header slots render. [GAP]
- [ ] Chat "open the database" routes here; composer binding acts as table/row search. [GAP]

### Primary interactions
- [ ] Editor-mode tabs (`editor-mode-<mode>`, SegmentedControl via ref-less `ViewModeTab`): switch Browse↔Query, `status` active/inactive round-trips. [GAP — mode switch untested]
- [ ] Table list rows in sidebar: selecting a table calls `getDatabaseRows`, ResultsGrid populates. [COVERED: DatabaseView.test.tsx (loads rows on select)]
- [ ] Pagination (`PaginationBar` prev/next, ChevronLeft/Right): advances offset, refetches page, disables at bounds. [GAP]
- [ ] Column sort (SortDir) toggles asc/desc/none, re-queries or re-sorts. [GAP]
- [ ] CellPopover: click a cell → full-value popover (long/JSON values); Escape/outside-click closes. [GAP]
- [ ] SQL editor (SqlEditorPanel): Textarea `onChange`→queryText; Cmd/Ctrl-Enter runs; Run Query button fires `runQuery`; running state disables button ("Running..."). [GAP — SQL run path untested]
- [ ] Sample-query chips (`setQueryText(q)`): clicking populates editor textarea with the query. [GAP]

### State matrix
- [ ] Connecting: status pending state before table list. [COVERED: DatabaseView.test.tsx]
- [ ] Disconnected: `ServerOff` "database unavailable" message. [COVERED: DatabaseView.test.tsx]
- [ ] Status-load error: `getDatabaseStatus` rejects → user-visible error (not blank). [COVERED: DatabaseView.test.tsx]
- [ ] Empty table (0 rows): `ChatEmptyStateWithRecommendations` empty-table state. [COVERED: DatabaseView.test.tsx]
- [ ] Row-load error: `getDatabaseRows` rejects → surfaced error. [COVERED: DatabaseView.test.tsx]
- [ ] SQL query error (bad SQL): error rendered, editor stays populated for edit. [GAP]
- [ ] Large result set: horizontal + vertical scroll, sticky header, no overflow break. [GAP]

### Repeated / rapid-fire
- [ ] Mash Run Query: single in-flight query, button disabled while running, no duplicate `executeQuery`. [GAP]
- [ ] Rapid table switching: only last selection's rows render (no stale race overwrite). [GAP]
- [ ] Spam prev/next at bounds: offset never goes negative / past last page. [GAP]

### Back-and-forth / recovery
- [ ] Type SQL draft → switch to Browse → back to Query: draft textarea preserved (or documented reset). [GAP]
- [ ] Select table → leave view → return: last table + page restored from cache, revalidated. [GAP]
- [ ] Poll (`useIntervalWhenDocumentVisible`) pauses when hidden, resumes on visible — no fetch storm on background. [GAP]

### Fuzz / adversarial
- [ ] SQL editor: paste destructive/`DROP`/injection SQL — assert server-side guard governs (read-only vs write policy), UI doesn't silently pretend success. [GAP]
- [ ] Huge multi-line query / emoji / null bytes in query → no editor freeze. [GAP]
- [ ] Cell with binary/base64/2MB text → CellPopover truncates/scrolls, no DOM lock. [GAP]

### Input modalities
- [ ] Ctrl/Cmd-Enter in textarea runs query; Tab moves focus out of textarea (not inserting tab). [GAP]
- [ ] Keyboard nav across ResultsGrid cells; Escape closes CellPopover. [GAP]
- [ ] Touch: sidebar table list scroll + tap select on mobile. [GAP]

### A11y / geometry
- [ ] Editor-mode tabs `role=tab`; grid has table semantics; axe pass in both modes. [GAP]
- [ ] Orange accent only on active tab/run button; hover orange→darker-orange. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Run SQL while a table-row fetch is pending: results don't cross-contaminate the wrong panel. [GAP]
- [ ] Poll-revalidate lands while user is mid-pagination: user's page not yanked back. [GAP]

---

## MemoryViewerView  (route `memories` → `/apps/memories`)

### Entry / Nav
- [ ] `/apps/memories` fresh reload → `memory-viewer-view`; default `feed` mode. [GAP — no dedicated spec; chat-view-memory-stability covers chat side]
- [ ] Chat "what do you remember" routes here; composer binding = memory search. [GAP]
- [ ] Back from a person filter returns to unfiltered feed. [GAP]

### Primary interactions
- [ ] View-mode segmented (`memory-view-mode`, feed↔browse): `memory-feed` vs `memory-browser` container swaps. [GAP]
- [ ] Type filters (`memory-filter-<type|all>`): Messages/Memories/Facts/Documents narrow browse list; "all" resets. [GAP]
- [ ] Person filters (`memory-person-<entityId>`): scope memories to a person from `RelationshipsPersonSummary`. [GAP]
- [ ] Pagination (`memory-page-prev`/`memory-page-next`, BROWSE_PAGE_SIZE=50): advance/rewind, disabled at bounds. [GAP]
- [ ] Search (composer `onQuery`): re-queries browse; empty query → feed default. [GAP]
- [ ] Feed poll (FEED_POLL_MS=30s, `useIntervalWhenDocumentVisible`): new items prepend, capped at FEED_MAX_ITEMS=500. [GAP — cap invariant untested]

### State matrix
- [ ] Empty feed: `MEMORY_FEED_EMPTY_FEATURES` (Chat/Facts/Docs) empty panel. [GAP]
- [ ] Loading: `ListSkeleton`. [GAP]
- [ ] Populated feed vs browse: type badges (`.memory-type-badge-<key>`), unknown type → "unknown" bucket. [GAP]
- [ ] Failed fetch (browse/feed/stats): error surfaced, not blank. [GAP]
- [ ] Long memory content: `truncateText` at 200 chars, expand affordance. [GAP]
- [ ] Zero persons → person filter list hidden/empty gracefully. [GAP]

### Repeated / rapid-fire
- [ ] Spam feed↔browse toggle: correct container, no double-fetch, no skeleton latch. [GAP]
- [ ] Mash next-page at last page: page index clamped, no empty flash loop. [GAP]
- [ ] Rapid type-filter cycling: final filter's set only, counts consistent. [GAP]

### Back-and-forth / recovery
- [ ] Browse page 3 → leave → return: page + filter restored (or reset to 1 documented). [GAP]
- [ ] Feed scrolled deep → background → resume: poll doesn't reset scroll to top on prepend. [GAP]
- [ ] 500-item cap: after long poll session, `useDeferredValue` search stays responsive. [GAP]

### Fuzz / adversarial
- [ ] Search with emoji/RTL/injection/huge paste → no crash; whitespace-only = no-op. [GAP]
- [ ] Memory item with malformed/empty type → `memoryTypeKey` → "unknown", no throw. [GAP]

### Input modalities
- [ ] Tab across segmented→filters→pagination; Enter activates. [GAP]
- [ ] Touch scroll feed + tap filter chip on mobile ≥44px. [GAP]

### A11y / geometry
- [ ] Type badges use CSS custom-prop tokens (no inline rgba), sufficient contrast; axe pass. [GAP]
- [ ] Accent orange only; hover rules honored. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Feed poll lands while user paginates browse: modes independent, no cross-write. [GAP]
- [ ] Person-filter fetch overlapping type-filter fetch: last query wins, no merged garbage. [GAP]

---

## TrajectoriesView  (route `trajectories` → `/apps/trajectories`; detail = TrajectoryDetailView)

### Entry / Nav
- [ ] `/apps/trajectories` fresh reload → `trajectories-view` list. [GAP — no dedicated ui-smoke; trajectory-logger appears only in plugin coverage list]
- [ ] Selecting a trajectory (`trajectory-<id>`) opens TrajectoryDetailView; `onSelectTrajectory` updates selection. [GAP]
- [ ] Deep-link / back preserves selected trajectory id + search. [GAP]

### Primary interactions
- [ ] Search (composer `onQuery`→`searchQuery`, re-queries `loadTrajectories`, resets selection on change). [GAP]
- [ ] Pagination (`page` state, cacheKey `trajectories:<page>:<query>`): next/prev advances, cache seeds instant paint. [GAP]
- [ ] Export menu (`trajectories-export-open`, `agentGroup="trajectories-export"`): opens options; `handleExport` → `client.exportTrajectories` returns a blob; `exporting` disables during. [GAP — export path untested]
- [ ] Background poll for new turns (no manual refresh button) — assert new rows appear without user action. [GAP]

### TrajectoryDetailView
- [ ] Stat chips (`hits`/`misses`/`hit-rate`/`tokens`) render computed values (server-owned, not client-computed). [GAP]
- [ ] Stage filters (`input`/`plan`/`should_respond`/`actions`/`evaluators`): filter timeline to that stage. [GAP]
- [ ] `clear-stage-filter` resets to all stages. [GAP]

### State matrix
- [ ] Empty (no trajectories) vs filtered-empty (`hasActiveFilters`) distinct states. [GAP]
- [ ] Loading skeleton; failed fetch error; export failure toast (`FailedToExport`). [GAP]
- [ ] Long trajectory (many turns/large token payloads) scroll + overflow. [GAP]

### Repeated / rapid-fire
- [ ] Mash Export: single in-flight (`exporting` guard), one blob, no duplicate downloads. [GAP]
- [ ] Rapid trajectory row clicks: detail matches last click, no stale detail. [GAP]
- [ ] Spam stage filters: final stage only. [GAP]

### Back-and-forth / recovery
- [ ] Open detail → back to list: selection cleared/preserved per design; scroll restored. [GAP]
- [ ] Search change mid-selection resets `selectedTrajectoryId` (assert `previousSearchQueryRef` logic). [GAP]
- [ ] Poll continues after view switch return without duplicating rows. [GAP]

### Fuzz / adversarial
- [ ] Search injection/emoji/huge → no crash; export while searching uses correct filter. [GAP]
- [ ] `agentSafeId(trajectory.id)` sanitizes weird ids for agent element registration. [GAP]

### Input modalities
- [ ] Keyboard: Tab to rows, Enter opens detail, Escape back; export menu keyboard-navigable. [GAP]
- [ ] Touch: tap row, swipe list on mobile. [GAP]

### A11y / geometry
- [ ] Export menu focus-trapped; stat chips have accessible labels; axe pass. [GAP]
- [ ] Accent orange only; hover rules. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Export in flight while poll refetches list: export uses snapshot filter, not clobbered. [GAP]
- [ ] Page change while detail loading: detail cancels/ignores stale response. [GAP]

---

## TranscriptsView  (route `transcripts` → `/apps/transcripts`; App renders TranscriptsPageView)

### Entry / Nav
- [ ] `/apps/transcripts` fresh reload → `transcripts-view` split (list left, TranscriptPlayer right). [COVERED: TranscriptsView.test.tsx (lists + selects)]
- [ ] Selecting a recording (`transcript-<id>`, `onSelect`) shows player. [COVERED: TranscriptsView.test.tsx]

### Primary interactions
- [ ] Recording row click sets selection, right panel = TranscriptPlayer (word-synced). [COVERED: TranscriptsView.test.tsx]
- [ ] TranscriptPlayer: play/pause, seek, word highlight sync to audio time (useAudioElement). [COVERED: TranscriptPlayer.test.tsx + transcript-realaudio.spec.ts (real audio)]
- [ ] TranscriptBody word/segment rendering + active-word class. [COVERED: TranscriptBody.test.tsx]

### State matrix
- [ ] Empty (no recordings): `transcripts-empty` hint. [COVERED: TranscriptsView.test.tsx]
- [ ] No selection: `transcripts-detail-empty`. [GAP — assert distinct from list-empty]
- [ ] Load error (`role=alert`): surfaced. [GAP]
- [ ] Long transcript (thousands of words) scroll + sync perf. [GAP]

### Repeated / rapid-fire
- [ ] Mash play/pause: audio state consistent, no double-play. [GAP]
- [ ] Rapid recording selection: player reloads correct audio, prior audio stopped (no overlap playback). [GAP]

### Back-and-forth / recovery
- [ ] Playing → switch view → return: audio paused/position handled (no ghost background audio). [GAP]
- [ ] Reload mid-playback: selection reset cleanly. [GAP]

### Fuzz / adversarial
- [ ] Missing/corrupt audio URL → player shows error, no infinite spinner. [GAP]
- [ ] `agentSafeId(summary.id)` sanitizes ids. [GAP]

### Input modalities
- [ ] Space toggles play when player focused; arrow keys seek. [GAP]
- [ ] Touch: tap word to seek, swipe transcript. [GAP]

### A11y / geometry
- [ ] Player controls labeled; active word visible focus; reduced-motion disables auto-scroll follow. [GAP]
- [ ] Accent orange only. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Selecting new recording while previous audio still loading: cancels prior load. [GAP]

---

## LogsView  (route `logs` → `/apps/logs`)

### Entry / Nav
- [ ] `/apps/logs` fresh reload → `logs-view`, live tail begins (visible-only via `useIntervalWhenDocumentVisible`). [GAP — no dedicated spec]
- [ ] Chat "show logs" routes here; composer = log search. [GAP]

### Primary interactions
- [ ] Level filter Select (`logs-filter-level`, "All Levels"): narrows to level, `SelectValue` round-trips. [GAP]
- [ ] Source filter Select (`logs-filter-source`, "All Sources"). [GAP]
- [ ] Tag filter Select (`logs-filter-tag`, "All Tags"). [GAP]
- [ ] Search (composer `onQuery`→`setSearchQuery`) filters `log-entry` rows. [GAP]
- [ ] Clear Filters button (`logs-clear`, `handleClearFilters`) resets all three selects + search. [GAP]
- [ ] Reload button (`loadLogs`) re-fetches. [GAP]

### State matrix
- [ ] Empty (no logs): empty hint with Clear-Filters action. [GAP]
- [ ] Loading; failed fetch error. [GAP]
- [ ] Live-tail appends new entries; document-hidden pauses tail (no growth while backgrounded). [GAP — pause-on-hidden invariant untested]
- [ ] Filtered-empty (filters exclude all) distinct from no-logs. [GAP]
- [ ] Very long single log line + 10k entries → virtualize/scroll, no freeze. [GAP]

### Repeated / rapid-fire
- [ ] Spam level/source/tag selects: final combination applied, one filtered set. [GAP]
- [ ] Mash Reload: single in-flight fetch. [GAP]
- [ ] Clear Filters twice: idempotent (already-clear stays clear). [GAP]

### Back-and-forth / recovery
- [ ] Set filters → leave → return: filters preserved or reset (documented); tail resumes. [GAP]
- [ ] Scroll up to read old logs while tail runs → new entries don't yank scroll to bottom (autoscroll only at bottom). [GAP]

### Fuzz / adversarial
- [ ] Log line with ANSI/emoji/RTL/injection HTML → rendered as text, not interpreted; no XSS. [GAP]
- [ ] Search with regex-ish/huge string → no crash. [GAP]

### Input modalities
- [ ] Select dropdowns keyboard-openable (Enter/Space/arrows); Escape closes. [GAP]
- [ ] Touch: tap select, scroll log list. [GAP]

### A11y / geometry
- [ ] Selects labeled; `log-entry` level color-coded with adequate contrast (no blue); axe pass. [GAP]
- [ ] Accent orange only. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Reload while tail poll active: no duplicate entries, no double-render. [GAP]
- [ ] Filter change while fetch pending: last filter wins. [GAP]

---

## RelationshipsView → RelationshipsWorkspaceView  (route `relationships` → `/apps/relationships`)

### Entry / Nav
- [ ] `/apps/relationships` fresh reload → `relationships-view` (graph panel + sidebar + person panels + candidate-merges + activity feed). [GAP — no dedicated spec]
- [ ] Chat "who do I know" routes here; composer = relationship search. [GAP]

### Primary interactions
- [ ] Search (composer `onQuery`→`setSearch`, `useDeferredValue`): re-queries graph via `buildRelationshipsGraphQuery`. [GAP]
- [ ] Platform filter select (`relationships-platform`, options `["all", ...platforms]`, `getValue`/`onChange`): narrows graph by platform; round-trip select value. [GAP]
- [ ] Candidate-merges panel: approve/reject a merge candidate → goes through merge engine (not identity-bypass). [GAP]
- [ ] Person panels: select a person → detail; sidebar navigation. [GAP]
- [ ] Graph panel: node click selects entity, edges show relationships. [GAP]

### State matrix
- [ ] Empty (no relationships/graph nodes). [GAP]
- [ ] Loading graph skeleton; failed graph fetch error. [GAP]
- [ ] Populated with clusters; zero candidate-merges vs many. [GAP]
- [ ] Long person names/many edges → graph layout + overflow. [GAP]

### Repeated / rapid-fire
- [ ] Spam platform select: final platform's graph only, one query. [GAP]
- [ ] Mash approve on a merge candidate: single merge, candidate removed, no double-merge. [GAP]
- [ ] Rapid search typing: deferred value debounces, final query wins. [GAP]

### Back-and-forth / recovery
- [ ] Select person → back → return: selection + platform + search restored. [GAP]
- [ ] Leave mid-merge → return: candidate list reflects committed merge. [GAP]

### Fuzz / adversarial
- [ ] Search emoji/RTL/injection/huge → no crash; deferred value stays responsive. [GAP]
- [ ] Person with unicode/very long name renders in cluster + panel without breaking layout. [GAP]

### Input modalities
- [ ] Platform select keyboard-accessible; `sr-only` label wired to select id. [GAP]
- [ ] Touch: tap graph node, pinch-zoom graph if wired, scroll activity feed. [GAP]

### A11y / geometry
- [ ] Select has associated `<label htmlFor>`; graph nodes have accessible names; axe pass. [GAP]
- [ ] Accent orange only in graph/merge CTAs. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Merge-approve while graph refetch pending: merged state not overwritten by stale graph. [GAP]
- [ ] Platform change + search change simultaneously: single combined query, no split state. [GAP]

---

## SkillsView  (route `skills` → `/apps/skills`; also settings deep-link)

### Entry / Nav
- [ ] `/apps/skills` fresh reload → `skills-shell`; `loadSkills` on mount. [COVERED: SkillsView.test.tsx]
- [ ] Chat "what skills do you have" routes here; composer = skill search. [GAP]

### Primary interactions
- [ ] Filter tabs (`filter-<tabKey>`): switch installed/marketplace/etc; list narrows. [GAP]
- [ ] Skill row (`skill-<id>`) select → `skills-detail` panel (`skills-detail-name`). [GAP]
- [ ] Selected-skill enable toggle (`toggle-selected-skill`): calls `handleSkillToggle(id, newEnabled)`. [COVERED: SkillsView.test.tsx]
- [ ] New Skill (`new-skill`) opens create form: name (`create-skill-name`), description (`create-skill-description`), submit (`create-skill-submit`). [GAP — create flow untested]
- [ ] Edit skill source (`edit-skill-source`) textarea round-trips + saves. [GAP]
- [ ] Install skill (`install-skill`) from marketplace → install progress. [GAP]
- [ ] Background poll `refreshSkills` (no manual refresh button). [COVERED: SkillsView.test.tsx (poll, no manual control)]

### State matrix
- [ ] Empty (no skills): `skills-empty-state`. [COVERED: SkillsView.test.tsx]
- [ ] Filter-empty (search excludes all): `skills-filter-empty`. [COVERED: SkillsView.test.tsx]
- [ ] Loading; install failure; create validation error (empty name). [GAP]
- [ ] Long skill source / many skills scroll. [GAP]

### Repeated / rapid-fire
- [ ] Mash enable toggle: single `handleSkillToggle` per change, no flapping duplicate calls. [GAP]
- [ ] Submit create twice: single create, no duplicate skill row. [GAP]
- [ ] Spam Install: single install, progress not duplicated. [GAP]

### Back-and-forth / recovery
- [ ] Fill create form → cancel/leave → return: draft reset or preserved (documented). [GAP]
- [ ] Select skill → switch filter tab → back: selection handling defined. [GAP]
- [ ] Edit source → navigate away mid-save → return: save committed or draft restored. [GAP]

### Fuzz / adversarial
- [ ] Create name/description with emoji/RTL/injection/huge/whitespace-only → validation rejects empty, sanitizes id (`skill-<id>`). [GAP]
- [ ] Edit source with huge script / malformed → no editor freeze; server validates. [GAP]

### Input modalities
- [ ] Tab through filter tabs → list → detail → toggle → create fields → submit; Enter submits create. [GAP]
- [ ] Touch: tap skill row, tap toggle ≥44px, scroll marketplace. [GAP]

### A11y / geometry
- [ ] Create form fields labeled; toggle has switch role; axe pass. [GAP]
- [ ] Accent orange only; toggle on = orange. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Enable toggle while `refreshSkills` poll lands: optimistic state not reverted by stale poll. [GAP]
- [ ] Install in flight + toggle another skill: independent, no cross-block. [GAP]

---

## PluginsView  (route `plugins` → `/apps/plugins`; App renders PluginsPageView; also settings `connectors`/`capabilities`/`apps`)

### Entry / Nav
- [ ] `/apps/plugins` fresh reload → `plugins-view-page`/`plugins-shell`; `ensurePluginsLoaded` on mount, once even under identity churn. [COVERED: PluginsView.test.tsx (loads once)]
- [ ] Settings deep-links (connectors/capabilities/apps sections) route into plugin subgroups. [GAP]
- [ ] Chat "manage plugins" routes here; composer = plugin search (`onQuery`→`handleSearchQuery`). [GAP]

### Primary interactions
- [ ] Subgroup chips (`plugins-subgroup-chips`, `setSubgroupFilter(tag.id)`): filter catalog by tag. [GAP]
- [ ] Plugin card enable toggle (`plugin-card-<id>-toggle`, `data-plugin-toggle`): `handleTogglePlugin`→`handlePluginToggle(id, inverted)`; health dot (ok/attention/error/off); disabled while `toggleDisabled`. [COVERED: PluginsView.test.tsx (dispatches inverted state)]
- [ ] Card click (when `hasParams`) opens detail/config (PluginConfigForm); toggle click `stopPropagation` (doesn't open detail). [GAP]
- [ ] Config form (`PluginConfigForm`): fields round-trip, save persists, validation. [GAP]
- [ ] Install (`onInstall`) / Uninstall (`onUninstall`) with npm name. [GAP]
- [ ] Drag-reorder (`draggable` when `allowCustomOrder`; `handleDragStart`/`handleDragOver`/`handleDrop`/`handleDragEnd`): reorders plugin list; order persists. [GAP — reorder untested]
- [ ] Reset order button (`reset-plugin-order`, `handleResetOrder`): restores default order. [GAP]
- [ ] Connector section toggle (`handleConnectorSectionToggle`) in connectors subview. [GAP]
- [ ] Install-progress WebSocket subscription on mount. [COVERED: PluginsView.test.tsx]

### State matrix
- [ ] Empty catalog; loading; toggle-in-flight banner (`hasPluginToggleInFlight` → `togglingPlugins.size>0`). [COVERED (load): PluginsView.test.tsx; GAP: in-flight banner]
- [ ] Plugin metadata with raw emoji icon string must NOT render as literal emoji text. [COVERED: PluginsView.test.tsx]
- [ ] Install failure; config save error; disabled/not-installed (`notInstalledLabel`) state. [GAP]
- [ ] Many plugins (100+) list scroll; long plugin names/descriptions overflow. [GAP]

### Repeated / rapid-fire
- [ ] Mash enable toggle: `togglingPlugins` set guards, single toggle per state change, button disabled while in-flight. [GAP]
- [ ] Rapid reorder drags: final order consistent, no duplicate/lost rows (invariant: set of plugin ids unchanged). [GAP]
- [ ] Spam Install same plugin: single install. [GAP]
- [ ] Reset order twice: idempotent. [GAP]

### Back-and-forth / recovery
- [ ] Reorder → leave view → return: custom order restored from persistence. [GAP]
- [ ] Toggle plugin → switch A→B→A: in-flight state and result reflected, no stale toggle. [GAP]
- [ ] Open config → navigate away mid-edit → return: draft handling defined. [GAP]

### Fuzz / adversarial
- [ ] Search emoji/RTL/injection/huge → no crash. [GAP]
- [ ] Drag a card outside list / drop on itself → no-op, order unchanged. [GAP]
- [ ] Plugin with malformed metadata (missing name/icon) → card renders safely, `notInstalledLabel` fallback. [COVERED (icon): PluginsView.test.tsx; GAP: missing name]

### Input modalities
- [ ] Keyboard reorder alternative (drag needs a11y equivalent) — assert keyboard move exists or documented gap. [GAP]
- [ ] Tab to toggle, Enter/Space toggles; Escape closes config modal (focus-trapped). [GAP]
- [ ] Touch: long-press drag reorder on mobile; tap toggle ≥44px. [GAP]
- [ ] Right-click on card → no broken context menu. [GAP]

### A11y / geometry
- [ ] Toggle `role=toggle` with health title; config modal focus-trapped; axe pass. [GAP]
- [ ] Health dot colors accessible; accent orange only, hover orange→darker-orange. [COVERED (visual): plugin-views-visual.spec.ts]
- [ ] Broad plugin-view lifecycle: loads/unmounts/reopens/reloads cleanly. [COVERED: plugin-views-lifecycle.spec.ts]
- [ ] Every control exercised without crash. [COVERED: plugin-views-interaction.spec.ts]

### Concurrency / races
- [ ] Toggle A while B toggling: both in `togglingPlugins`, independent resolution. [GAP]
- [ ] Reorder-drop while a toggle is in-flight: order + enabled state both correct. [GAP]
- [ ] Install-progress WS event arrives during reorder: no state clobber. [GAP]

---

## TasksPageView  (route `tasks` → `/apps/tasks`; hosts CodingAgentTasksPanel; ScheduledTaskEditor)

### Entry / Nav
- [ ] `/apps/tasks` fresh reload → `tasks-view` hosting `CodingAgentTasksPanel fullPage`. [COVERED (adjacent): task-coordinator-gui-interactions.spec.ts, task-widget-in-chat.spec.ts]
- [ ] Task widget tap in chat opens tasks context. [COVERED: task-widget-in-chat.spec.ts]
- [ ] Back from a task detail returns to feed.  [GAP]

### Primary interactions (CodingAgentTasksPanel + ScheduledTaskEditor)
- [ ] Panel owns header/filters/empty state (wrapper adds none). [GAP — assert no duplicate heading]
- [ ] ScheduledTaskEditor verbs via `client.applyScheduledTask`: Run now/Acknowledge (`apply("acknowledge")`), Snooze 1h (`apply("snooze", {minutes})`), Complete (`apply("complete")`), Cancel (`onCancel`). [COVERED (editor form): ScheduledTaskEditor.test.tsx]
- [ ] Enabled/disabled tone pill reflects `item.enabled`; schedule label from `scheduledTaskScheduleLabel(trigger)`; "No schedule" fallback. [GAP]
- [ ] Missing scheduledTask → `scheduledtask.missing` + Cancel. [GAP]

### State matrix
- [ ] Empty task feed; loading; apply-error (`scheduledtask.applyError`). [COVERED (apply error): ScheduledTaskEditor.test.tsx]
- [ ] Task with no schedule vs scheduled; many tasks scroll. [GAP]

### Repeated / rapid-fire
- [ ] Mash Run now / Complete: single verb dispatch, no double `applyScheduledTask`. [GAP]
- [ ] Spam Snooze: single snooze applied. [GAP]

### Back-and-forth / recovery
- [ ] Open editor → leave → return: task state reflects applied verb. [GAP]
- [ ] Reload mid-apply: verb committed server-side, UI reconciles. [GAP]

### Fuzz / adversarial
- [ ] Task prompt with huge/emoji/RTL text renders in "What it does" without breaking. [GAP]

### Input modalities
- [ ] Keyboard: Tab to verb buttons, Enter applies, Escape cancels. [GAP]
- [ ] Touch: tap verb buttons ≥44px. [GAP]

### A11y / geometry
- [ ] Verb buttons labeled; axe pass; accent orange only. [COVERED (visual): task-coordinator-gui-interactions.spec.ts]

### Concurrency / races
- [ ] Two verbs on same task overlapping (Snooze then Complete): last-write consistent, no orphan state. [GAP]

---

## RuntimeView  (route `runtime` → `/apps/runtime`; also settings `runtime` section)

### Entry / Nav
- [ ] `/apps/runtime` fresh reload → `runtime-view`; sections seeded expanded (`buildInitialExpanded`). [GAP — no dedicated spec; runtime-configurability.spec.ts covers ONBOARDING runtime selector, NOT this view]
- [ ] Settings `runtime` section deep-link surfaces runtime config. [GAP]
- [ ] Chat "show runtime state" routes here. [GAP]

### Primary interactions
- [ ] Section rows (`runtime-section-<key>`): expand/collapse a runtime section tree. [GAP]
- [ ] Node toggle (`onToggle(path)`, ChevronRight/Down): expand/collapse nested object, `expanded` Set round-trip. [GAP]
- [ ] Expand-all top (`runtime-expand-top` / `runtime-tree-expand-top`): expand full tree. [GAP]
- [ ] Collapse-all (`runtime-tree-collapse`): collapse to roots. [GAP]
- [ ] Copy value affordance (if wired) copies node JSON to clipboard. [GAP]

### State matrix
- [ ] Loading; failed fetch; populated deep tree; empty section. [GAP]
- [ ] Very large runtime object (deep nesting) → expand perf, no stack overflow (`isExpandable`/`nodeEntries` recursion bounded). [GAP]
- [ ] Sensitive values (tokens/keys) redacted, not shown raw. [GAP]

### Repeated / rapid-fire
- [ ] Mash expand/collapse same node: toggles cleanly, `expanded` Set stays consistent (no duplicate paths). [GAP]
- [ ] Spam Expand-all then Collapse-all: final state matches last action. [GAP]

### Back-and-forth / recovery
- [ ] Expand deep tree → leave → return: expansion state reset to initial or preserved (documented). [GAP]
- [ ] Poll/refresh of runtime state doesn't collapse user-expanded nodes. [GAP]

### Fuzz / adversarial
- [ ] Runtime object with circular ref / huge string / null values → `isExpandable` handles, no infinite render. [GAP]
- [ ] Path with special chars registers as valid agent element id. [GAP]

### Input modalities
- [ ] Keyboard: Tab to section/node toggles, Enter/Space expand; arrow-key tree nav if wired. [GAP]
- [ ] Touch: tap chevrons ≥44px, scroll deep tree. [GAP]

### A11y / geometry
- [ ] Tree nodes have `aria-expanded`; toggle buttons labeled (`collapse`/`expand` title); axe pass. [GAP]
- [ ] Accent orange only. [COVERED (visual): builtin-views-visual.spec.ts]

### Concurrency / races
- [ ] Runtime refetch while user expanding: expansion Set not wiped by new data. [GAP]

---

## Coverage summary

| View | Existing test path(s) | Biggest gap |
|---|---|---|
| FilesView | ui/…/FilesView.test.tsx; app/…/ui-smoke/files-view.spec.ts, files-view-crud.spec.ts, files-view-share-journey.spec.ts | Facet/search filter logic + download-URL assertion + delete-rollback-on-failure untested |
| DatabaseView | ui/…/DatabaseView.test.tsx (6 status/rows/error cases); database-utils.test.ts | Query-mode: SQL run path, editor-mode switch, pagination/sort/CellPopover all GAP |
| MemoryViewerView | (none dedicated; chat-view-memory-stability.spec.ts covers chat side) | Entire view: feed↔browse, type/person filters, pagination, 500-cap invariant — all GAP |
| TrajectoriesView / TrajectoryDetailView | (none dedicated; only listed in plugin coverage as trajectory-logger) | Export path, stage filters, stat chips, selection/search reset — all GAP |
| TranscriptsView | ui/…/TranscriptsView.test.tsx, TranscriptPlayer.test.tsx, TranscriptBody.test.tsx; app/…/transcript-realaudio.spec.ts | Rapid-selection audio-overlap, load-error, background-audio-on-nav all GAP |
| LogsView | (none dedicated) | Whole view untested: level/source/tag filters, live-tail pause-on-hidden, autoscroll-at-bottom — all GAP |
| RelationshipsView (Workspace) | (none dedicated) | Whole view untested: platform filter, candidate-merge approve/reject (merge-engine), graph node select — all GAP |
| SkillsView | ui/…/SkillsView.test.tsx (5: load/empty/toggle/poll/filter-empty) | Create-skill flow, edit-source, install, filter tabs untested |
| PluginsView / PluginCard | ui/…/PluginsView.test.tsx (6); app/…/plugin-views-{lifecycle,interaction,visual}.spec.ts, plugin-view-agent-bridge-inventory.spec.ts | Drag-reorder + reset-order + config-form save + in-flight-banner untested (highest-value GAP) |
| TasksPageView / ScheduledTaskEditor | ui/…/ScheduledTaskEditor.test.tsx; app/…/task-coordinator-gui-interactions.spec.ts, task-widget-in-chat.spec.ts | Verb idempotency (double Run/Complete) + overlapping-verb race GAP |
| RuntimeView | (none — runtime-configurability.spec.ts is the onboarding selector, not this view) | Entire tree view untested: expand/collapse, expand-all, deep/circular fuzz, secret redaction — all GAP |

**Single biggest gap in group:** three data views ship with effectively zero behavioral coverage — **LogsView, RelationshipsWorkspaceView, and RuntimeView have no dedicated unit or e2e spec at all** (their only coverage is the generic `builtin-views-visual`/`all-views` screenshot walk, which asserts "renders without crash," not any filter/merge/expand semantics). RelationshipsWorkspaceView is the most dangerous of the three because its candidate-merge approve/reject mutates the identity graph through the merge engine with no test guarding correctness or double-merge idempotency.
