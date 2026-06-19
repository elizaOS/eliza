# Duplicate component candidates in @elizaos/ui

Scanned **981** files, **565** component-like exports.

Report JSON: `scripts/duplicate-components-report.json`


## 1. Exact-name duplicates (2)

Components exported with the *same name* from multiple files.


### `ThemeToggle` × 2
- src\cloud-ui\components\theme\theme-toggle.tsx
- src\components\shared\ThemeToggle.tsx

### `ChatPanelLayout` × 2
- src\components\pages\ChatPanelLayout.tsx
- src\layouts\chat-panel-layout\chat-panel-layout.tsx


## 2. Partial-name clusters (84)

Components whose first token (lowercased) matches another. Useful for spotting families that share a name root (e.g. `Chat*`, `Setup*`).


_(Showing top 40 by size; pass --verbose for all.)_


### `sidebar*` × 26
- `SidebarSearchBar` — src\components\composites\search\searchbar.tsx
- `SidebarBody` — src\components\composites\sidebar\sidebar-body.tsx
- `SidebarCollapsedRail` — src\components\composites\sidebar\sidebar-collapsed-rail.tsx
- `SidebarCollapsedActionButton` — src\components\composites\sidebar\sidebar-collapsed-rail.tsx
- `SidebarSectionLabel` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarSectionHeader` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarEmptyState` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarNotice` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarToolbar` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarToolbarPrimary` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarToolbarActions` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemIcon` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemBody` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemTitle` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemDescription` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarRailMedia` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemAction` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItem` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarItemButton` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarRailItem` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarContent` — src\components\composites\sidebar\sidebar-content.tsx
- `SidebarHeaderStack` — src\components\composites\sidebar\sidebar-header-stack.tsx
- `SidebarHeader` — src\components\composites\sidebar\sidebar-header.tsx
- `SidebarPanel` — src\components\composites\sidebar\sidebar-panel.tsx
- `Sidebar` — src\components\composites\sidebar\sidebar-root.tsx
- `SidebarScrollRegion` — src\components\composites\sidebar\sidebar-scroll-region.tsx

### `dashboard*` × 24
- `DashboardSection` — src\cloud-ui\components\brand\dashboard-section.tsx
- `DashboardStatCard` — src\cloud-ui\components\brand\dashboard-stat-card.tsx
- `DashboardActionCards` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `DashboardActionCardsSkeleton` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `DashboardPageWrapper` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `DashboardRouteError` — src\cloud-ui\components\dashboard\dashboard-route-error.tsx
- `DashboardLoadingState` — src\cloud-ui\components\dashboard\route-placeholders.tsx
- `DashboardErrorState` — src\cloud-ui\components\dashboard\route-placeholders.tsx
- `DashboardDataList` — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- `DashboardDataListMobile` — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- `DashboardDataListDesktop` — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- `DashboardDataListCard` — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- `DashboardDataListFilteredCount` — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- `DashboardTableSkeleton` — src\cloud-ui\components\data-list\dashboard-table-skeleton.tsx
- `DashboardHeader` — src\cloud-ui\components\layout\dashboard-header.tsx
- `DashboardPageContainer` — src\cloud-ui\components\layout\dashboard-page.tsx
- `DashboardPageStack` — src\cloud-ui\components\layout\dashboard-page.tsx
- `DashboardToolbar` — src\cloud-ui\components\layout\dashboard-page.tsx
- `DashboardStatGrid` — src\cloud-ui\components\layout\dashboard-page.tsx
- `DashboardRoutePage` — src\cloud-ui\components\layout\dashboard-route-page.tsx
- `DashboardShellLayout` — src\cloud-ui\components\layout\dashboard-shell.tsx
- `DashboardSidebarNavigationItem` — src\cloud-ui\components\layout\dashboard-sidebar-item.tsx
- `DashboardSidebarNavigationSection` — src\cloud-ui\components\layout\dashboard-sidebar-section.tsx
- `DashboardSidebar` — src\cloud-ui\components\layout\dashboard-sidebar.tsx

### `chat*` × 20
- `ChatAttachmentStrip` — src\components\composites\chat\chat-attachment-strip.tsx
- `ChatBubble` — src\components\composites\chat\chat-bubble.tsx
- `ChatComposerShell` — src\components\composites\chat\chat-composer-shell.tsx
- `ChatComposer` — src\components\composites\chat\chat-composer.tsx
- `ChatConversationItem` — src\components\composites\chat\chat-conversation-item.tsx
- `ChatConversationRenameDialog` — src\components\composites\chat\chat-conversation-rename-dialog.tsx
- `ChatEmptyState` — src\components\composites\chat\chat-empty-state.tsx
- `ChatMessageActions` — src\components\composites\chat\chat-message-actions.tsx
- `ChatMessage` — src\components\composites\chat\chat-message.tsx
- `ChatSourceIcon` — src\components\composites\chat\chat-source.tsx
- `ChatVoiceSpeakerBadge` — src\components\composites\chat\chat-source.tsx
- `ChatThreadLayout` — src\components\composites\chat\chat-thread-layout.tsx
- `ChatTranscript` — src\components\composites\chat\chat-transcript.tsx
- `ChatVoiceStatusBar` — src\components\composites\chat\ChatVoiceStatusBar.tsx
- `ChatPanelLayout` — src\components\pages\ChatPanelLayout.tsx
- `ChatView` — src\components\pages\ChatView.tsx
- `ChatSurface` — src\components\shell\ChatSurface.tsx
- `ChatPanelLayout` — src\layouts\chat-panel-layout\chat-panel-layout.tsx
- `ChatComposerCtx` — src\state\ChatComposerContext.hooks.ts
- `ChatInputRefCtx` — src\state\ChatComposerContext.hooks.ts

### `page*` × 15
- `PageHeaderContext` — src\cloud-ui\components\layout\page-header-context.hooks.ts
- `PageHeaderProvider` — src\cloud-ui\components\layout\page-header-context.tsx
- `PageTransition` — src\cloud-ui\components\layout\page-transition.tsx
- `PagePanelCollapsibleSection` — src\components\composites\page-panel\page-panel-collapsible-section.tsx
- `PageEmptyState` — src\components\composites\page-panel\page-panel-empty.tsx
- `PagePanelFeatureEmpty` — src\components\composites\page-panel\page-panel-feature-empty.tsx
- `PagePanelFrame` — src\components\composites\page-panel\page-panel-frame.tsx
- `PagePanelContentArea` — src\components\composites\page-panel\page-panel-frame.tsx
- `PageActionRail` — src\components\composites\page-panel\page-panel-header.tsx
- `PageLoadingState` — src\components\composites\page-panel\page-panel-loading.tsx
- `PagePanelRoot` — src\components\composites\page-panel\page-panel-root.tsx
- `PagePanelToolbar` — src\components\composites\page-panel\page-panel-toolbar.tsx
- `PageScopedChatPane` — src\components\pages\PageScopedChatPane.tsx
- `PageLayoutHeader` — src\layouts\page-layout\page-layout-header.tsx
- `PageLayoutMobileDrawer` — src\layouts\page-layout\page-layout-mobile-drawer.tsx

### `relationships*` × 14
- `RelationshipsActivityFeed` — src\components\pages\relationships\RelationshipsActivityFeed.tsx
- `RelationshipsCandidateMergesPanel` — src\components\pages\relationships\RelationshipsCandidateMergesPanel.tsx
- `RelationshipsPersonSummaryPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsFactsPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsConnectionsPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsConversationsPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsRelevantMemoriesPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsUserPreferencesPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsDocumentsPanel` — src\components\pages\relationships\RelationshipsPersonPanels.tsx
- `RelationshipsSidebar` — src\components\pages\relationships\RelationshipsSidebar.tsx
- `RelationshipsWorkspaceView` — src\components\pages\relationships\RelationshipsWorkspaceView.tsx
- `RelationshipsGraphPanel` — src\components\pages\RelationshipsGraphPanel.tsx
- `RelationshipsIdentityCluster` — src\components\pages\RelationshipsIdentityCluster.tsx
- `RelationshipsView` — src\components\pages\RelationshipsView.tsx

### `app*` × 13
- `App` — src\App.tsx
- `AppIdentityTile` — src\components\apps\app-identity.tsx
- `AppHero` — src\components\apps\app-identity.tsx
- `AppWindowRenderer` — src\components\apps\AppWindowRenderer.tsx
- `AppDetailsView` — src\components\pages\AppDetailsView.tsx
- `AppPermissionsSection` — src\components\settings\AppPermissionsSection.tsx
- `AppPageSidebar` — src\components\shared\AppPageSidebar.tsx
- `AppWorkspaceChatChromeContext` — src\components\workspace\AppWorkspaceChrome.hooks.ts
- `AppWorkspaceChatCollapseButton` — src\components\workspace\AppWorkspaceChrome.tsx
- `AppWorkspaceChrome` — src\components\workspace\AppWorkspaceChrome.tsx
- `AppBootContext` — src\config\boot-config-react.hooks.ts
- `AppProvider` — src\state\AppContext.tsx
- `AppContext` — src\state\useApp.ts

### `connector*` × 12
- `ConnectorAccountPicker` — src\components\chat\ConnectorAccountPicker.tsx
- `ConnectorAccountAuditList` — src\components\connectors\ConnectorAccountAuditList.tsx
- `ConnectorAccountCard` — src\components\connectors\ConnectorAccountCard.tsx
- `ConnectorAccountList` — src\components\connectors\ConnectorAccountList.tsx
- `ConnectorAccountPrivacySelector` — src\components\connectors\ConnectorAccountPrivacySelector.tsx
- `ConnectorAccountPurposeSelector` — src\components\connectors\ConnectorAccountPurposeSelector.tsx
- `ConnectorAccountSetupScope` — src\components\connectors\ConnectorAccountSetupScope.tsx
- `ConnectorModeSelector` — src\components\connectors\ConnectorModeSelector.tsx
- `ConnectorQrPairingOverlay` — src\components\connectors\ConnectorQrPairingOverlay.tsx
- `ConnectorSetupPanel` — src\components\connectors\ConnectorSetupPanel.tsx
- `ConnectorPluginGroups` — src\components\pages\plugin-view-connectors.tsx
- `ConnectorSidebar` — src\components\pages\plugin-view-sidebar.tsx

### `voice*` × 11
- `VoiceProfilesUnavailableError` — src\api\client-voice-profiles.ts
- `VoiceProfilesClient` — src\api\client-voice-profiles.ts
- `VoiceAudioPlayer` — src\cloud-ui\components\voice\voice-audio-player.tsx
- `VoiceEmptyState` — src\cloud-ui\components\voice\voice-empty-state.tsx
- `VoiceStatusBadge` — src\cloud-ui\components\voice\voice-status-badge.tsx
- `VoiceConfigView` — src\components\settings\VoiceConfigView.tsx
- `VoiceProfileSection` — src\components\settings\VoiceProfileSection.tsx
- `VoiceSection` — src\components\settings\VoiceSection.tsx
- `VoiceSectionMount` — src\components\settings\VoiceSectionMount.tsx
- `VoiceTierBanner` — src\components\settings\VoiceTierBanner.tsx
- `VoicePill` — src\components\voice-pill\VoicePill.tsx

### `apps*` × 10
- `AppsPageWrapper` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `AppsEmptyState` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `AppsSkeleton` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `AppsListView` — src\cloud-ui\components\data-list\apps-list-view.tsx
- `AppsCatalogGrid` — src\components\apps\AppsCatalogGrid.tsx
- `AppsSidebar` — src\components\apps\AppsSidebar.tsx
- `AppsSection` — src\components\chat\AppsSection.tsx
- `AppsPageView` — src\components\pages\AppsPageView.tsx
- `AppsView` — src\components\pages\AppsView.tsx
- `AppsManagementSection` — src\components\settings\AppsManagementSection.tsx

### `character*` × 10
- `CharacterEditor` — src\components\character\CharacterEditor.tsx
- `CharacterIdentityPanel` — src\components\character\CharacterEditorPanels.tsx
- `CharacterStylePanel` — src\components\character\CharacterEditorPanels.tsx
- `CharacterExamplesPanel` — src\components\character\CharacterEditorPanels.tsx
- `CharacterExperienceWorkspace` — src\components\character\CharacterExperienceWorkspace.tsx
- `CharacterHubView` — src\components\character\CharacterHubView.tsx
- `CharacterLearnedSkillsSection` — src\components\character\CharacterLearnedSkillsSection.tsx
- `CharacterOverviewSection` — src\components\character\CharacterOverviewSection.tsx
- `CharacterPersonalityTimeline` — src\components\character\CharacterPersonalityTimeline.tsx
- `CharacterRoster` — src\components\character\CharacterRoster.tsx

### `settings*` × 10
- `SettingsView` — src\components\pages\SettingsView.tsx
- `SettingsField` — src\components\settings\settings-control-primitives.tsx
- `SettingsFieldLabel` — src\components\settings\settings-control-primitives.tsx
- `SettingsFieldDescription` — src\components\settings\settings-control-primitives.tsx
- `SettingsInput` — src\components\ui\settings-controls.tsx
- `SettingsTextarea` — src\components\ui\settings-controls.tsx
- `SettingsSegmentedGroup` — src\components\ui\settings-controls.tsx
- `SettingsMutedText` — src\components\ui\settings-controls.tsx
- `SettingsSelectTrigger` — src\components\ui\settings-controls.tsx
- `SettingsControls` — src\components\ui\settings-controls.tsx

### `cloud*` × 9
- `CloudImage` — src\cloud-ui\runtime\image.tsx
- `CloudSourceModeToggle` — src\components\cloud\CloudSourceControls.tsx
- `CloudConnectionStatus` — src\components\cloud\CloudSourceControls.tsx
- `CloudStatusBadge` — src\components\cloud\CloudStatusBadge.tsx
- `CloudRpcStatus` — src\components\pages\config-page-sections.tsx
- `CloudServicesSection` — src\components\pages\config-page-sections.tsx
- `CloudDashboard` — src\components\pages\ElizaCloudDashboard.tsx
- `CloudInstancePanel` — src\components\settings\CloudInstancePanel.tsx
- `CloudPanel` — src\components\settings\ProviderPanels.tsx

### `trajectory*` × 8
- `TrajectoryCacheStats` — src\components\composites\trajectories\trajectory-cache-stats.tsx
- `TrajectoryCodeBlock` — src\components\composites\trajectories\trajectory-code-block.tsx
- `TrajectoryContextDiffList` — src\components\composites\trajectories\trajectory-context-diff-list.tsx
- `TrajectoryEventTimeline` — src\components\composites\trajectories\trajectory-event-timeline.tsx
- `TrajectoryLlmCallCard` — src\components\composites\trajectories\trajectory-llm-call-card.tsx
- `TrajectoryPipelineGraph` — src\components\composites\trajectories\trajectory-pipeline-graph.tsx
- `TrajectorySidebarItem` — src\components\composites\trajectories\trajectory-sidebar-item.tsx
- `TrajectoryDetailView` — src\components\pages\TrajectoryDetailView.tsx

### `agent*` × 7
- `AgentElementOverlay` — src\agent-surface\AgentElementOverlay.tsx
- `AgentSurfaceContext` — src\agent-surface\AgentSurfaceContext.hooks.ts
- `AgentSurfaceProvider` — src\agent-surface\AgentSurfaceContext.tsx
- `AgentButton` — src\agent-surface\components.tsx
- `AgentInput` — src\agent-surface\components.tsx
- `AgentCard` — src\cloud-ui\components\brand\brand-card.tsx
- `AgentActivityBox` — src\components\chat\AgentActivityBox.tsx

### `eliza*` × 7
- `ElizaClient` — src\api\client-base.ts
- `ElizaAvatar` — src\cloud-ui\components\ai-elements\eliza-avatar.tsx
- `ElizaCloudLockup` — src\cloud-ui\components\brand\eliza-cloud-lockup.tsx
- `ElizaLogo` — src\cloud-ui\components\brand\eliza-logo.tsx
- `ElizaAgentsPageWrapper` — src\cloud-ui\components\dashboard\cloud-dashboard-components.tsx
- `ElizaGenUiActionError` — src\genui\actions.ts
- `ElizaGenUiRenderer` — src\genui\renderer.tsx

### `api*` × 7
- `ApiError` — src\api\client-types-core.ts
- `ApiKeyEmptyState` — src\cloud-ui\components\api-key-empty-state.tsx
- `ApiKeysTable` — src\cloud-ui\components\data-list\api-keys-table.tsx
- `ApiParameterSelect` — src\cloud-ui\components\docs\api-parameter-select.tsx
- `ApiRouteExplorerClient` — src\cloud-ui\components\docs\api-route-explorer-client.tsx
- `ApiKeyConfig` — src\components\settings\ApiKeyConfig.tsx
- `ApiKeyPanel` — src\components\settings\ProviderPanels.tsx

### `telegram*` × 5
- `TelegramIcon` — src\cloud-ui\components\icons.tsx
- `TelegramAccountConnectorPanel` — src\components\connectors\TelegramAccountConnectorPanel.tsx
- `TelegramBotSetupPanel` — src\components\connectors\TelegramBotSetupPanel.tsx
- `TelegramChatModeToggle` — src\components\pages\PluginConfigForm.tsx
- `TelegramPluginConfig` — src\components\pages\PluginConfigForm.tsx

### `desktop*` × 5
- `DesktopGameWindowControls` — src\components\apps\GameView.tsx
- `DesktopTabBar` — src\components\desktop\DesktopTabBar.tsx
- `DesktopWorkspaceDisplay` — src\components\settings\DesktopWorkspaceDisplay.tsx
- `DesktopWorkspaceSection` — src\components\settings\DesktopWorkspaceSection.tsx
- `DesktopTalkModePanel` — src\components\settings\VoiceConfigView.tsx

### `plugin*` × 5
- `PluginSettingsDialog` — src\components\pages\plugin-view-dialogs.tsx
- `PluginGameModal` — src\components\pages\plugin-view-modal.tsx
- `PluginCard` — src\components\pages\PluginCard.tsx
- `PluginConfigForm` — src\components\pages\PluginConfigForm.tsx
- `PluginVisual` — src\components\pages\PluginVisual.tsx

### `shell*` × 5
- `ShellControllerContext` — src\components\shell\ShellControllerContext.hooks.ts
- `ShellControllerProvider` — src\components\shell\ShellControllerContext.tsx
- `ShellHeaderControls` — src\components\shell\ShellHeaderControls.tsx
- `ShellOverlays` — src\components\shell\ShellOverlays.tsx
- `ShellViewAgentSurface` — src\components\views\ShellViewAgentSurface.tsx

### `theme*` × 4
- `ThemeContext` — src\cloud-ui\components\theme\theme-provider.hooks.ts
- `ThemeProvider` — src\cloud-ui\components\theme\theme-provider.tsx
- `ThemeToggle` — src\cloud-ui\components\theme\theme-toggle.tsx
- `ThemeToggle` — src\components\shared\ThemeToggle.tsx

### `render*` × 4
- `RenderTelemetryProfiler` — src\cloud-ui\runtime\render-telemetry.tsx
- `RenderSelectField` — src\components\config-ui\config-field.helpers.tsx
- `RenderFileField` — src\components\config-ui\config-field.helpers.tsx
- `RenderCustomField` — src\components\config-ui\config-field.helpers.tsx

### `config*` × 4
- `ConfigFieldErrors` — src\components\config-ui\config-control-primitives.tsx
- `ConfigField` — src\components\config-ui\config-field.tsx
- `ConfigRenderer` — src\components\config-ui\config-renderer.tsx
- `ConfigPageView` — src\components\pages\ConfigPageView.tsx

### `custom*` × 4
- `CustomActionEditor` — src\components\custom-actions\CustomActionEditor.tsx
- `CustomActionsPanel` — src\components\custom-actions\CustomActionsPanel.tsx
- `CustomActionsView` — src\components\custom-actions\CustomActionsView.tsx
- `CustomModelSearch` — src\components\local-inference\CustomModelSearch.tsx

### `local*` × 4
- `LocalInferencePanel` — src\components\local-inference\LocalInferencePanel.tsx
- `LocalProviderPanel` — src\components\settings\ProviderPanels.tsx
- `LocalInferenceEngine` — src\services\local-inference\engine.ts
- `LocalInferenceService` — src\services\local-inference\service.ts

### `secrets*` × 4
- `SecretsView` — src\components\pages\SecretsView.tsx
- `SecretsManagerSection` — src\components\settings\SecretsManagerSection.tsx
- `SecretsManagerModalRoot` — src\components\settings\SecretsManagerSection.tsx
- `SecretsTab` — src\components\settings\vault-tabs\SecretsTab.tsx

### `status*` × 4
- `StatusPill` — src\components\release-center\shared.tsx
- `StatusBar` — src\components\stream\StatusBar.tsx
- `StatusBadge` — src\components\ui\status-badge.tsx
- `StatusDot` — src\components\ui\status-badge.tsx

### `view*` × 3
- `ViewAgentRegistry` — src\agent-surface\registry.ts
- `ViewCatalog` — src\components\pages\ViewCatalog.tsx
- `ViewIcon` — src\components\views\ViewIcon.tsx

### `prompt*` × 3
- `PromptCard` — src\cloud-ui\components\brand\prompt-card.tsx
- `PromptCardGrid` — src\cloud-ui\components\brand\prompt-card.tsx
- `PromptDialog` — src\components\ui\confirm-dialog.tsx

### `account*` × 3
- `AccountCard` — src\components\accounts\AccountCard.tsx
- `AccountList` — src\components\accounts\AccountList.tsx
- `AccountRequiredCard` — src\components\chat\AccountRequiredCard.tsx

### `game*` × 3
- `GameView` — src\components\apps\GameView.tsx
- `GameViewOverlay` — src\components\apps\GameViewOverlay.tsx
- `GameOperatorShell` — src\components\apps\surfaces\GameOperatorShell.tsx

### `form*` × 3
- `FormRequest` — src\components\chat\widgets\form-request.tsx
- `FormSelect` — src\components\ui\form-select.tsx
- `FormSelectItem` — src\components\ui\form-select.tsx

### `widget*` × 3
- `WidgetSection` — src\components\chat\widgets\shared.tsx
- `WidgetVisibilityEditor` — src\components\chat\WidgetVisibilityPanel.tsx
- `WidgetHost` — src\widgets\WidgetHost.tsx

### `permission*` × 3
- `PermissionCard` — src\components\composites\chat\permission-card.tsx
- `PermissionIcon` — src\components\permissions\PermissionIcon.tsx
- `PermissionRow` — src\components\settings\permission-controls.tsx

### `model*` × 3
- `ModelCard` — src\components\local-inference\ModelCard.tsx
- `ModelHubView` — src\components\local-inference\ModelHubView.tsx
- `ModelUpdatesPanel` — src\components\local-inference\ModelUpdatesPanel.tsx

### `release*` × 3
- `ReleaseCenterView` — src\components\pages\ReleaseCenterView.tsx
- `ReleaseStatusSection` — src\components\release-center\sections.tsx
- `ReleaseNotesSection` — src\components\release-center\sections.tsx

### `advanced*` × 3
- `AdvancedSection` — src\components\settings\AdvancedSection.tsx
- `AdvancedToggle` — src\components\settings\AdvancedToggle.tsx
- `AdvancedSettingsDisclosure` — src\components\settings\settings-control-primitives.tsx

### `provider*` × 3
- `ProviderCard` — src\components\settings\ProviderCard.tsx
- `ProviderRoutingPanel` — src\components\settings\ProviderRoutingPanel.tsx
- `ProviderSwitcher` — src\components\settings\ProviderSwitcher.tsx

### `confirm*` × 3
- `ConfirmDeleteControl` — src\components\shared\confirm-delete-control.tsx
- `ConfirmDelete` — src\components\ui\confirm-delete.tsx
- `ConfirmDialog` — src\components\ui\confirm-dialog.tsx

### `bug*` × 3
- `BugReportModal` — src\components\shell\BugReportModal.tsx
- `BugReportProvider` — src\hooks\BugReportProvider.tsx
- `BugReportContext` — src\hooks\useBugReport.hooks.ts


## 3. Variant suffix siblings (9)

Components named like `Foo` AND `FooLite/FooCompact/FooMobile/...` — likely targets for a single component + variant prop.

- **PromptCard** ↔ **PromptCardGrid** (suffix: `grid`) — src\cloud-ui\components\brand\prompt-card.tsx
- **DashboardDataList** ↔ **DashboardDataListMobile** (suffix: `mobile`) — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- **DashboardDataList** ↔ **DashboardDataListCard** (suffix: `card`) — src\cloud-ui\components\data-list\dashboard-data-list.tsx
- **Sidebar** ↔ **SidebarBody** (suffix: `body`) — src\components\composites\sidebar\sidebar-body.tsx
- **SidebarItem** ↔ **SidebarItemBody** (suffix: `body`) — src\components\composites\sidebar\sidebar-content.tsx
- **Sidebar** ↔ **SidebarHeader** (suffix: `header`) — src\components\composites\sidebar\sidebar-header.tsx
- **Sidebar** ↔ **SidebarPanel** (suffix: `panel`) — src\components\composites\sidebar\sidebar-panel.tsx
- **AdminDialog** ↔ **AdminDialogHeader** (suffix: `header`) — src\components\ui\admin-dialog.tsx
- **AdminSegmentedTab** ↔ **AdminSegmentedTabList** (suffix: `list`) — src\components\ui\admin-dialog.tsx