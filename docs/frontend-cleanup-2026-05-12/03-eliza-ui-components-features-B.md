# Frontend Cleanup Audit: Features & Feature Groups (Part B)

**Date:** 2026-05-12  
**Scope:** `packages/ui/src/components/` — remaining subdirectories (110 files across 22 folders)  
**Status:** Research-only audit  

---

## Executive Summary

The remaining 22 subdirectories span feature areas (connectors, training, policies), pages (character management, conversations), UI infrastructure (config rendering, shared components), and several **suspicious singleton folders** (workspace, steward, primitives, plugins, companion, auth—each containing 1 file).

Key findings:
- **~40 files in the 100–250 LOC range** are well-scoped components.
- **~13 files >500 LOC** in character, config-ui, connectors, and custom-actions—candidates for extraction.
- **Heavy hook usage** in character editor (80 hooks), config-field (47), ui-renderer (37), and conversations sidebar (44).
- **Singleton folders are mostly wrapper/injection layers**, not dead code, but `workspace/` is unused and `primitives/` is a re-export proxy.
- **Cross-folder reuse is rare**; no duplication detected between connectors ↔ plugins, accounts ↔ auth, or character ↔ steward.
- **Most console.error calls are in custom-actions and permissions** (good for error tracking).
- **No significant anti-patterns** (type: any is rare; as any appears 0 times).

---

## Detailed Directory Analysis

### 1. **connectors/** (18 files, 3,740 LOC)

**Scope:** UI for pairing and managing connector accounts (Discord, Telegram, WhatsApp, Signal, iMessage, BlueBubbles, etc.).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `DiscordLocalConnectorPanel.tsx` | 449 | Local Discord bot setup, guild/channel selection | 29 hooks, 46 setState calls — **high state churn**; could extract channel/guild picker |
| `TelegramAccountConnectorPanel.tsx` | 352 | Telegram account linking workflow | 21 hooks, 35 setters; mirror of Discord pattern |
| `ConnectorModeSelector.tsx` | 352 | Radio-button UI for selecting connector mode (bot/local/managed) | 7 hooks; pure UI, well-scoped |
| `ConnectorAccountCard.tsx` | 308 | Card displaying a single account with status and actions | 7 hooks; imports `EditableAccountLabel` from `accounts/` |
| `TelegramBotSetupPanel.tsx` | 184 | Separate panel for Telegram bot config (webhook, polling) | 7 hooks; candidate for merge into `TelegramAccountConnectorPanel` |
| `ConnectorQrPairingOverlay.tsx` | 212 | Generic QR overlay for pairing workflows | 3 hooks; reusable |
| `ConnectorAccountList.tsx` | 199 | List of accounts, toggles add/edit panels | 3 hooks; depends on `useConnectorAccounts` hook |
| `ConnectorAccountAuditList.tsx` | 158 | Audit log table (read-only) | 7 hooks |
| `ConnectorSetupPanel.tsx` | 159 | Registry dispatcher for connector setup (maps connector type → component) | Injection pattern; references `getBootConfig()` |
| `ConnectorAccountPrivacySelector.tsx` | 236 | Dropdown + description for account privacy setting | 6 hooks |
| `ConnectorAccountPurposeSelector.tsx` | 194 | Dropdown for account purpose/role | 5 hooks |
| `ConnectorAccountSetupScope.tsx` | 107 | Checkbox group for scope selection during account setup | 0 hooks; pure form UI |
| `IMessageStatusPanel.tsx` | 128 | iMessage pairing status display | 6 hooks |
| `BlueBubblesStatusPanel.tsx` | 115 | BlueBubbles pairing status | 6 hooks |
| `SignalQrOverlay.tsx` | 63 | Signal-specific QR pairing overlay | 0 hooks; relies on `useSignalPairing()` |
| `WhatsAppQrOverlay.tsx` | 71 | WhatsApp QR pairing overlay | 0 hooks |
| `connector-account-options.ts` | 310 | Helper: resolves account display options (privacy, purpose labels) | Pure utility; well-isolated |
| `connector-account-options.test.ts` | 143 | Tests for above | ✓ Good coverage |

**Key Concerns:**
1. **State churn in Discord/Telegram panels**: Both use 20+ hooks and 30+ setState calls. Extract guild/channel pickers into pure components.
2. **Pairing overlays duplicate**: Signal, WhatsApp, generic QR—could unify into one `ConnectorQrOverlay` with type hints.
3. **Cross-folder import**: `ConnectorAccountCard` imports `EditableAccountLabel` from `accounts/`. No circular dependency, but could co-locate account UI primitives.

**Recommendation:**
- Extract `<GuildPicker />` and `<ChannelPicker />` from Discord panel (reduces Discord panel LOC by ~100).
- Unify Signal and WhatsApp QR overlays into parameterized `ConnectorQrOverlay`.
- Consider moving `EditableAccountLabel` to a shared `accounts-shared/` or `connector-accounts/` namespace.

---

### 2. **local-inference/** (15 files, 2,162 LOC)

**Scope:** UI for local LLM inference (model downloads, routing, hardware detection, slot assignments).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `LocalInferencePanel.tsx` | 475 | Main dashboard; tabs for models, routing, providers | 24 hooks, 22 setters — **moderate state complexity**; orchestrator component |
| `ModelHubView.tsx` | 263 | Search and browse HuggingFace models | 2 hooks |
| `RoutingMatrix.tsx` | 214 | Table of routing rules (task → model/provider) | 9 hooks; could be extracted to a separate `routing/` folder |
| `HuggingFaceSearch.tsx` | 164 | Search input + results for HF model discovery | 8 hooks; tightly scoped |
| `SlotAssignments.tsx` | 121 | Slot configuration (legacy "active model" fallback noted in comments) | 3 hooks; legacy comment on line 41 suggests this can be simplified when "legacy" slot is deprecated |
| `HardwareBadge.tsx` | 54 | Small badge showing hardware source (os-fallback, user-detected) | 0 hooks |
| `ModelCard.tsx` | 171 | Card displaying model metadata and download button | 5 hooks |
| `DevicesPanel.tsx` | 99 | List of detected/configured devices | 3 hooks |
| `ProvidersList.tsx` | 128 | List of available inference providers | 5 hooks |
| `ActiveModelBar.tsx` | 62 | Status bar showing currently active model | 0 hooks |
| `DeviceBridgeStatus.tsx` | 60 | Bridge connection status indicator | 3 hooks |
| `DownloadQueue.tsx` | 80 | List of in-progress and queued downloads | 3 hooks; uses `useTrainingApi` |
| `FirstRunOffer.tsx` | 97 | Onboarding prompt for first-time local inference users | 8 hooks; has `: any` type in `anyActiveDownload` (line 48) |
| `DownloadProgress.tsx` | 38 | Simple progress bar component | 0 hooks |
| `hub-utils.ts` | 136 | Helper functions for HuggingFace API calls | Pure utility |

**Key Concerns:**
1. **Type safety issue**: `FirstRunOffer.tsx` line 48 has `: any` type.
2. **Legacy code**: `SlotAssignments.tsx` references "legacy active model" that can be cleaned up.
3. **RoutingMatrix is 214 LOC**: Could move to a dedicated `routing/` subfolder if this feature grows.

**Recommendation:**
- Fix type in `FirstRunOffer.tsx` line 48 (replace `: any` with correct type).
- Plan removal of legacy slot handling in `SlotAssignments.tsx` (document deprecation timeline).
- Consider moving routing-related logic into a dedicated `routing/` folder if it grows beyond 300 LOC.

---

### 3. **character/** (15 files, 6,199 LOC)

**Scope:** Character editing, roster, hub, and personality configuration.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `CharacterEditor.tsx` | 1,492 | **Main editor form** (name, voice, personality, examples, learned skills) | **80 hooks, 54 setters** — **CRITICAL: massive state machine**, should extract sub-editors |
| `CharacterHubView.tsx` | 1,273 | Hub/gallery view; search, create, import, export, play, delete | **51 hooks, 38 setters**; localStorage cache logic (lines 183–191) |
| `CharacterExperienceWorkspace.tsx` | 1,360 | Interactive canvas for personality and relationship editing | **20 hooks, 11 setters** |
| `CharacterEditorPanels.tsx` | 719 | Three sub-panels: identity, style, examples (used within CharacterEditor) | 3 hooks; well-scoped |
| `CharacterRoster.tsx` | 242 | Gallery grid of character cards; drag-drop reordering | 3 hooks; uses custom pack roster entries |
| `CharacterLearnedSkillsSection.tsx` | 264 | List and UI for skills learned during training | 9 hooks |
| `CharacterOverviewSection.tsx` | 159 | Summary view of character | 0 hooks |
| `CharacterPersonalityTimeline.tsx` | 116 | Timeline UI for personality evolution | 2 hooks |
| `CharacterRelationshipsSection.tsx` | 11 | **Stub file** — likely dead code or WIP | 0 hooks |
| `MusicLibraryCharacterWidget.tsx` | 67 | Music library integration | 0 hooks |
| `character-editor-helpers.ts` | 84 | Helpers for building character drafts from presets, determining defaults | Pure utility; well-isolated |
| `character-hub-helpers.ts` | 188 | Helpers for search, filtering, sorting characters | Pure utility |
| `character-hub-types.ts` | 68 | Type definitions for hub state | Types only |
| `character-greeting.ts` | 30 | Helper for greeting animation | Utility |
| `character-voice-config.ts` | 126 | Voice synthesis configuration builder | Utility |

**Key Concerns:**
1. **CharacterEditor is 1,492 LOC with 80 hooks**: This is a red flag. The component should be split into:
   - `<CharacterIdentity />` (name, bio, greeting)
   - `<CharacterPersonality />` (personality traits, timeline)
   - `<CharacterVoice />` (voice config, sample playback)
   - `<CharacterExamples />` (message examples)
   - `<CharacterSkills />` (learned skills)
   Estimated extraction: 600+ LOC per sub-editor, reducing main file to ~300 LOC orchestrator.

2. **CharacterHubView (1,273 LOC, 51 hooks)**: Could extract:
   - `<CharacterSearchBar />` (search UI)
   - `<CharacterCreateButton />` (new character flow)
   - `<CharacterImportDialog />` (import logic)
   - Keep hub as 400–500 LOC orchestrator.

3. **CharacterRelationshipsSection is 11 LOC stub**: Likely incomplete feature; either finish or remove.

4. **No duplication with steward/**: `steward/injected.tsx` (24 LOC) is just a boot-config wrapper, not a competitor.

**Recommendation:**
- **HIGH PRIORITY**: Refactor `CharacterEditor` into 5 sub-editors.
- **HIGH PRIORITY**: Refactor `CharacterHubView` into smaller components (search, create, import dialogs).
- Remove or complete `CharacterRelationshipsSection.tsx`.
- Move voice config logic to a dedicated sub-editor (`CharacterVoiceEditor.tsx`).

---

### 4. **policy-controls/** (10 files, 780 LOC)

**Scope:** UI for transaction policies (spending limits, rate limits, approved addresses, time windows, auto-approve).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `ApprovedAddressesSection.tsx` | 193 | List + add/remove UI for approved Ethereum/Solana addresses | 7 hooks; well-scoped |
| `TimeWindowSection.tsx` | 124 | Time-of-day restrictions UI | 6 hooks |
| `RateLimitSection.tsx` | 73 | Rate-limit (requests/time) configuration | 0 hooks |
| `SpendingLimitSection.tsx` | 66 | Spending cap configuration | 0 hooks |
| `AutoApproveSection.tsx` | 53 | Toggle + confirmation for auto-approval | 0 hooks |
| `PolicyToggle.tsx` | 74 | Toggle to enable/disable a policy | 2 hooks |
| `types.ts` | 73 | Type definitions and policy config resolver (`mergePolicy`) | Pure utility |
| `constants.ts` | 55 | Magic values (placeholder limits, etc.) | Constants only |
| `helpers.ts` | 50 | Utility functions (label formatters, etc.) | Pure utility |
| `index.ts` | 19 | Re-export barrel | Re-export only |

**Key Concerns:**
None. This folder is well-organized, modular, and appropriately scoped.

**Recommendation:**
No changes needed. Good example of a well-structured feature folder.

---

### 5. **training/** (7 files, 1,714 LOC)

**Scope:** Fine-tuning and inference endpoint management.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `TrainingDashboard.tsx` | 428 | Main view; tabs for jobs, budgets, endpoints | 14 hooks, 10 setters; orchestrator component |
| `JobDetailPanel.tsx` | 325 | Detailed view of a training job (progress, logs, actions) | 17 hooks, 6 setters; can extract log viewer and action buttons |
| `InferenceEndpointPanel.tsx` | 245 | Endpoint configuration and deployment UI | 9 hooks; well-scoped |
| `BudgetPanel.tsx` | 153 | Budget management for training spend | 6 hooks; well-scoped |
| `types.ts` | 89 | Type definitions | Types only |
| `hooks/useTrainingApi.ts` | 465 | API hook (fetch jobs, budgets, endpoints; manage lifecycle) | 48 hooks; **MASSIVE**—extract into smaller hooks (`useTrainingJobs`, `useBudget`, `useEndpoints`) |
| `injected.tsx` | 9 | Boot-config wrapper for FineTuningView | Injection layer |

**Key Concerns:**
1. **useTrainingApi (465 LOC, 48 hooks)**: This is a god hook. It should be split into:
   - `useTrainingJobs()` — list, fetch, cancel
   - `useTrainingBudget()` — fetch, update
   - `useInferenceEndpoints()` — list, deploy, delete
   - `useTrainingApiBase()` — shared API client setup

2. **JobDetailPanel**: Extract log viewer into `<JobLogViewer />`.

**Recommendation:**
- **HIGH PRIORITY**: Decompose `useTrainingApi` into 3–4 smaller, single-purpose hooks.
- Extract job action buttons into a separate component.

---

### 6. **shared/** (5 files, 654 LOC)

**Scope:** Reusable UI components and utilities for sidebars, theme, language, and delete confirmation.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `AppPageSidebar.tsx` | 271 | Sidebar navigation + collapsible sections; localStorage sync | 6 hooks; well-scoped |
| `LanguageDropdown.tsx` | 133 | Language picker | 2 hooks; uses translation context |
| `CollapsibleSidebarSection.tsx` | 98 | Reusable collapse/expand section | 2 hooks |
| `ThemeToggle.tsx` | 60 | Dark/light mode toggle | 2 hooks; well-scoped |
| `confirm-delete-control.tsx` | 92 | Delete confirmation dialog wrapper | 2 hooks; well-scoped |

**Key Concerns:**
None. Small, focused components.

**Recommendation:**
No changes needed.

---

### 7. **conversations/** (5 files, 1,857 LOC)

**Scope:** Chat sidebar, conversation list, and metadata.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `ConversationsSidebar.tsx` | 997 | **Main sidebar** (list, search, rename, delete, archive, context menu) | **44 hooks, 53 setState calls** — **CRITICAL: orchestrator with too many concerns**; extract search, context menu, item renderer |
| `ConversationRenameDialog.tsx` | 77 | Modal for renaming a conversation | 5 hooks; simple |
| `conversation-sidebar-model.ts` | 520 | State machine (filtering, sorting, pagination, cache) | Pure logic; well-isolated |
| `conversation-utils.ts` | 157 | Helper functions (format labels, resolve icons, etc.) | Pure utility |
| `brand-icons.tsx` | 106 | SVG icon set for conversation/connector brands | Component+data; well-scoped |

**Key Concerns:**
1. **ConversationsSidebar (997 LOC, 44 hooks)**: Should be split into:
   - `<ConversationSearchBox />` (search UI + logic)
   - `<ConversationListItem />` (single conversation card + context menu)
   - `<ConversationsList />` (virtualized list renderer)
   - Keep sidebar as 250–300 LOC orchestrator

**Recommendation:**
- **HIGH PRIORITY**: Extract search, list item, and context menu into separate components.

---

### 8. **config-ui/** (5 files, 4,569 LOC)

**Scope:** Dynamic form rendering from a JSON schema (plugin config, settings, etc.). **Largest in this batch.**

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `config-field.tsx` | 1,997 | **Field renderer factory** (23 input types: text, password, select, textarea, json, file, etc.) | **47 hooks, 39 setters** — **MASSIVE**; each field type should be its own file/component |
| `ui-renderer.tsx` | 1,775 | Dynamic form builder from schema; visibility rules, validation | **37 hooks, 36 setters**; orchestrator; good structure but could extract field rendering |
| `config-renderer.tsx` | 723 | Wrapper; dispatches to field or UI renderer based on schema | 29 hooks; dispatch logic is sound |
| `config-control-primitives.tsx` | 63 | CSS class helpers for inputs | Pure utility |
| `index.ts` | 11 | Re-export barrel | Re-export only |

**Key Concerns:**
1. **config-field.tsx is 1,997 LOC**: This is a monolithic field renderer factory. It should be refactored into:
   ```
   config-ui/
   ├── fields/
   │   ├── TextField.tsx (single-line text input)
   │   ├── PasswordField.tsx
   │   ├── NumberField.tsx
   │   ├── BooleanField.tsx
   │   ├── SelectField.tsx
   │   ├── TextareaField.tsx
   │   ├── EmailField.tsx
   │   ├── UrlField.tsx
   │   ├── ColorField.tsx
   │   ├── DateField.tsx
   │   ├── DatetimeField.tsx
   │   ├── JsonField.tsx
   │   ├── CodeField.tsx
   │   ├── FileField.tsx
   │   ├── ArrayField.tsx
   │   ├── KeyValueField.tsx
   │   ├── RadioField.tsx
   │   ├── CheckboxGroupField.tsx
   │   ├── MultiselectField.tsx
   │   ├── TableField.tsx
   │   ├── GroupField.tsx
   │   ├── MarkdownField.tsx
   │   ├── CustomField.tsx
   │   └── index.ts (re-export registry)
   ├── config-field.tsx (thin dispatcher that imports from fields/)
   ```
   Estimated per-field LOC: 60–100. Total extracted: 1,500+ LOC into 23 well-isolated files.

2. **ui-renderer has complex visibility logic**: Extract visibility evaluator into a dedicated `<ConditionalField />` wrapper.

**Recommendation:**
- **HIGHEST PRIORITY**: Split `config-field.tsx` into 23 separate field components in a `fields/` subdirectory.
- Extract visibility evaluation into a reusable `evaluateFieldVisibility()` utility.
- This refactoring could reduce config-field from 1,997 LOC to a 100–200 LOC dispatcher.

---

### 9. **accounts/** (5 files, 1,502 LOC)

**Scope:** Account cards, account selection, and rotation strategy.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `AddAccountDialog.tsx` | 691 | Modal for linking/adding a new account | 26 hooks, 32 setters; orchestrator; extract account form into sub-component |
| `AccountCard.tsx` | 425 | Card UI for a single account (name, status, actions) | 7 hooks, 9 setters; well-scoped |
| `AccountList.tsx` | 169 | List of accounts with filtering/search | 5 hooks; well-scoped |
| `RotationStrategyPicker.tsx` | 114 | Dropdown + explanation for account rotation strategy | 0 hooks; form control |
| `EditableAccountLabel.tsx` | 103 | Editable inline label for account name | 7 hooks; reused by connectors (cross-folder import) |

**Key Concerns:**
1. **AddAccountDialog (691 LOC, 26 hooks)**: Extract account form into `<AccountForm />` component; reduce dialog to 250 LOC.
2. **EditableAccountLabel is imported by connectors**: No issue, but indicates good separation of UI primitives.

**Recommendation:**
- Extract account form logic into `<AccountForm />` component.
- Add optional `<AccountFormDialog />` wrapper.

---

### 10. **custom-actions/** (4 files, 1,989 LOC)

**Scope:** Custom action (HTTP request) editor and management.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `CustomActionEditor.tsx` | 904 | Form builder for custom HTTP actions | **25 hooks, 102 setters** — **EXTREMELY HIGH state churn**; extract param/header/simile editors |
| `CustomActionsView.tsx` | 404 | Main view (list, create, edit, delete, import) | 21 hooks, 14 setters; orchestrator; extract list renderer and dialogs |
| `CustomActionsPanel.tsx` | 348 | Panel variant (simplified view) | 17 hooks, 10 setters; `console.error` calls (good for error tracking) |
| `custom-action-form.tsx` | 333 | Helpers: param parser, validation, normalization | **0 hooks; pure logic** — well-isolated; **console.error free**; good error handling |

**Key Concerns:**
1. **CustomActionEditor (904 LOC, 102 setters)**: This is extreme state churn. Should be split:
   - `<ActionGeneralPanel />` (name, description)
   - `<ActionMethodPanel />` (HTTP method, URL)
   - `<ActionHeadersEditor />` (header k/v pairs)
   - `<ActionParametersEditor />` (parameter form builder)
   - `<ActionSimileEditor />` (simile/alias list)
   Keep editor as 300 LOC orchestrator.

2. **CustomActionsView (404 LOC)**: Extract list item renderer and action dialogs.

3. **console.error calls in Panel and View**: Good for error tracking; keep as-is.

**Recommendation:**
- **HIGHEST PRIORITY**: Refactor `CustomActionEditor` into 5 sub-panels (estimated 150–200 LOC each).
- Extract list item and dialogs from `CustomActionsView`.

---

### 11. **cloud/** (4 files, 687 LOC)

**Scope:** Cloud features (Stripe checkout, Flamina guide, cloud status).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `FlaminaGuide.tsx` | 242 | Onboarding guide card for Flamina (cloud inference service) | 6 hooks |
| `CloudStatusBadge.tsx` | 195 | Status badge (credits, usage, warnings) | 6 hooks |
| `StripeEmbeddedCheckout.tsx` | 155 | Stripe payment form | 6 hooks |
| `CloudSourceControls.tsx` | 95 | Toggle for cloud source mode | 0 hooks |

**Key Concerns:**
None. Small, focused components.

**Recommendation:**
No changes needed.

---

### 12. **release-center/** (3 files, 850 LOC)

**Scope:** Release notes, build status, and runtime info display.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `sections.tsx` | 695 | Sections: release status, build info, session controls, WGPU surface config | 9 hooks; orchestrator; extract each section into its own component |
| `shared.tsx` | 72 | Helpers: error summarizer, URL normalizer, status pills, definition rows | Pure utility; well-isolated |
| `types.ts` | 83 | Type definitions | Types only |

**Key Concerns:**
1. **sections.tsx has 5 inline sections**: Extract into `ReleaseStatusSection.tsx`, `BuildInfoSection.tsx`, etc.

**Recommendation:**
- Extract sections into separate files (5 files × 100–150 LOC each).

---

### 13. **onboarding/** (3 files, 470 LOC)

**Scope:** Onboarding UI: bootstrap step, form primitives, Chrome step styling.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `BootstrapStep.tsx` | 313 | Bootstrap/setup step UI | 13 hooks, 8 setters; orchestrator; can extract sub-steps |
| `onboarding-form-primitives.tsx` | 116 | Form field CSS classes and wrapper component | 0 hooks; pure UI |
| `onboarding-step-chrome.tsx` | 41 | Step styling and chrome components | 0 hooks; pure UI |

**Key Concerns:**
None. Well-scoped for onboarding.

**Recommendation:**
No changes needed.

---

### 14. **tool-events/** (2 files, 218 LOC)

**Scope:** Tool call event log display (for cloud or stream debugging).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `ToolCallEventLog.tsx` | 162 | Event log table with state getters and naming helpers | 0 hooks; **pure presentational component** — excellent |
| `ToolCallEventLog.test.tsx` | 56 | Tests | ✓ Good coverage |

**Key Concerns:**
None. Good example of pure component with test coverage.

**Recommendation:**
No changes needed.

---

### 15. **stream/** (2 files, 177 LOC)

**Scope:** Status bar and helpers for streaming/real-time updates.

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `StatusBar.tsx` | 157 | Status bar component (mode, activity, metrics) | 3 hooks; well-scoped |
| `helpers.ts` | 20 | Utility functions | Pure utility |

**Key Concerns:**
None.

**Recommendation:**
No changes needed.

---

### 16. **permissions/** (2 files, 479 LOC)

**Scope:** Streaming permissions (browser and mobile).

| File | LOC | Purpose | Concerns |
|------|-----|---------|----------|
| `StreamingPermissions.tsx` | 434 | Browser + mobile permission request UI | 14 hooks, 14 setters; **console.error calls for permission failures** (good) |
| `PermissionIcon.tsx` | 45 | Icon component for permission status | 0 hooks; well-scoped |

**Key Concerns:**
None. Good error logging.

**Recommendation:**
No changes needed.

---

## Singleton Folders (1 File Each)

### **workspace/** (1 file, 561 LOC)

**File:** `AppWorkspaceChrome.tsx`

**Purpose:** Main app chrome and layout (sidebar, chat pane, workspace controls). Imported by `App.tsx`, `browser.ts`, `DetachedShellRoot.tsx`, and `BrowserWorkspaceView.tsx`.

**Status:** ✓ Used; not dead code.

**Recommendation:** Keep as-is. No changes needed.

---

### **steward/** (1 file, 24 LOC)

**File:** `injected.tsx`

**Purpose:** Boot-config injection layer. Exports three wrapped components: `StewardLogo`, `ApprovalQueue`, `TransactionHistory`. All delegate to boot config.

**Usage:** Imported by `api/client-wallet.ts`, `api/client.ts`, `pages/browser-workspace-wallet.ts`, `settings/PolicyControlsView.tsx`.

**Status:** ✓ Used; not dead code.

**Recommendation:** Keep as-is. This is a legitimate injection/plugin pattern.

---

### **primitives/** (1 file, 23 LOC)

**File:** `index.ts`

**Purpose:** Re-export barrel for UI primitives (`button`, `card`, `dialog`, etc.) from `../ui/`. Used by 14 files.

**Status:** ✓ Used; not dead code.

**Recommendation:** Keep as-is. This is a legitimate facade/proxy pattern for managing exports.

---

### **plugins/** (1 file, 478 LOC)

**File:** `showcase-data.ts`

**Purpose:** Synthetic showcase plugin (PluginInfo) that demonstrates all 23 field renderers. Used by VoiceConfigView, plugin-list-utils, mobile-permissions-client, and others.

**Status:** ✓ Used; intentional test/demo data.

**Recommendation:** Keep as-is. Good reference for testing field renderers.

---

### **companion/** (1 file, 48 LOC)

**File:** `injected.tsx`

**Purpose:** Boot-config injection layer for companion features (avatar, inference notices, scene status). Exports 4 functions/components.

**Usage:** Imported by `pages/chat-view-hooks.tsx`, `shell/ShellOverlays.tsx`.

**Status:** ✓ Used; not dead code.

**Recommendation:** Keep as-is. Same injection pattern as steward.

---

### **auth/** (1 file, 267 LOC)

**File:** `LoginView.tsx`

**Purpose:** Authentication UI (form and flow). Imported by 22 files (most widely imported component in this batch).

**Usage:** Direct component usage and re-exports via `components/index.ts`, `browser.ts`, and throughout the app.

**Status:** ✓ Used; critical component.

**Recommendation:** Keep as-is. Well-scoped and widely used.

---

## Cross-Cutting Findings

### **Dead Code (Low Risk)**
- **CharacterRelationshipsSection.tsx (11 LOC)**: Likely WIP or incomplete. Either finish or remove.

### **Unused Folders (None)**
All folders are either directly used or are injection/wrapper layers. No completely dead folders detected.

### **Type Safety Issues (Minor)**
- `FirstRunOffer.tsx` line 48: `: any` type should be replaced with proper type.

### **Console Usage (Good Hygiene)**
- `custom-actions/CustomActionsPanel.tsx`: 3 console.error calls (good for debugging).
- `custom-actions/CustomActionsView.tsx`: 4 console.error calls (good).
- `permissions/StreamingPermissions.tsx`: 3 console.error calls (good).
- `config-ui/config-renderer.tsx`: 1 console.warn (fine).
- `character/CharacterEditor.tsx`: 1 console.warn (fine).

No excessive logging; error calls are appropriate.

### **No Anti-Patterns Detected**
- `as any` appears **0 times** (excellent type safety).
- `: any` appears **once** (FirstRunOffer.tsx) — minor issue.
- Cross-folder imports are minimal and non-circular.

---

## Refactoring Priority Matrix

| Priority | Effort | Impact | Target |
|----------|--------|--------|--------|
| **CRITICAL** | High | High | `config-ui/config-field.tsx` (split into 23 field files) |
| **CRITICAL** | High | High | `character/CharacterEditor.tsx` (extract 5 sub-editors) |
| **HIGH** | High | High | `character/CharacterHubView.tsx` (extract search, create, import) |
| **HIGH** | High | Medium | `custom-actions/CustomActionEditor.tsx` (extract 5 sub-panels) |
| **HIGH** | Medium | Medium | `conversations/ConversationsSidebar.tsx` (extract search, item, menu) |
| **HIGH** | Medium | Medium | `training/hooks/useTrainingApi.ts` (split into 3–4 hooks) |
| **MEDIUM** | Low | Low | `connectors/DiscordLocalConnectorPanel.tsx` (extract pickers) |
| **MEDIUM** | Low | Low | `release-center/sections.tsx` (extract sections) |
| **MEDIUM** | Low | Low | `character/CharacterRelationshipsSection.tsx` (finish or remove) |

---

## Summary

**Strengths:**
- Policy controls folder is well-organized and modular.
- Config-UI structure is sound, but config-field.tsx needs decomposition.
- Tool-events and stream folders are well-scoped.
- No dead code folders; all are actively used.
- Error logging is appropriate and informative.

**Weaknesses:**
- Character folder has 3 components >1,200 LOC each (80, 51, 20 hooks respectively).
- Conversations sidebar is 997 LOC with 44 hooks and 53 setState calls.
- Custom actions editor has extreme state churn (102 setters).
- Config-field.tsx is a 1,997 LOC monolith combining 23 field types.
- Training API hook is 465 LOC with 48 hooks (god hook).

**Estimated Refactoring Impact:**
- Splitting config-field.tsx alone frees ~1,200 LOC of orchestrator code and enables better testing.
- Refactoring character editors could reduce overall bundle size by ~500 LOC and improve maintainability.
- Breaking apart custom-actions editor reduces state complexity and improves testability.

**Timeline Estimate:**
- Config-field refactoring: 2–3 days (high mechanical complexity; good test suite needed).
- Character editor refactoring: 2–3 days.
- Conversations sidebar: 1 day.
- Custom actions editor: 1–2 days.
- **Total: ~1 week** for all CRITICAL and HIGH priority items.

