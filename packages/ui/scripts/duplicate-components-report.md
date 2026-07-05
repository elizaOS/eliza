# Duplicate component candidates in @elizaos/ui

Scanned **1487** files, **839** component-like exports.

Report JSON: `scripts/duplicate-components-report.json`


## 1. Exact-name duplicates (8)

Components exported with the *same name* from multiple files.


### `ApiError` × 2
- src/api/client-types-core.ts
- src/cloud/lib/api-client.ts

### `AgentCard` × 2
- src/cloud/instances/components/agent-card.tsx
- src/cloud-ui/components/brand/brand-card.tsx

### `StatusBadge` × 2
- src/cloud/mcps/McpDetailDrawer.tsx
- src/components/ui/status-badge.tsx

### `ThemeToggle` × 2
- src/cloud-ui/components/theme/theme-toggle.tsx
- src/components/shared/ThemeToggle.tsx

### `TopicChipsBar` × 2
- src/components/chat/widgets/topic-chips-bar.tsx
- src/components/shell/TopicChipsBar.tsx

### `FineTuningView` × 2
- src/components/training/injected.tsx
- src/types/host-external-modules.ts

### `Stack` × 2
- src/components/ui/stack.tsx
- src/spatial/primitives.tsx

### `Text` × 2
- src/components/ui/typography.tsx
- src/spatial/primitives.tsx


## 2. Partial-name clusters (127)

Components whose first token (lowercased) matches another. Useful for spotting families that share a name root (e.g. `Chat*`, `Setup*`).


_(Showing top 40 by size; pass --verbose for all.)_


### `sidebar*` × 26
- `SidebarSearchBar` — src/components/composites/search/searchbar.tsx
- `SidebarBody` — src/components/composites/sidebar/sidebar-body.tsx
- `SidebarCollapsedRail` — src/components/composites/sidebar/sidebar-collapsed-rail.tsx
- `SidebarCollapsedActionButton` — src/components/composites/sidebar/sidebar-collapsed-rail.tsx
- `SidebarSectionLabel` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarSectionHeader` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarEmptyState` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarNotice` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarToolbar` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarToolbarPrimary` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarToolbarActions` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemIcon` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemBody` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemTitle` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemDescription` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarRailMedia` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemAction` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItem` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarItemButton` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarRailItem` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarContent` — src/components/composites/sidebar/sidebar-content.tsx
- `SidebarHeaderStack` — src/components/composites/sidebar/sidebar-header-stack.tsx
- `SidebarHeader` — src/components/composites/sidebar/sidebar-header.tsx
- `SidebarPanel` — src/components/composites/sidebar/sidebar-panel.tsx
- `Sidebar` — src/components/composites/sidebar/sidebar-root.tsx
- `SidebarScrollRegion` — src/components/composites/sidebar/sidebar-scroll-region.tsx

### `cloud*` × 25
- `CloudConnectorsSection` — src/cloud/connectors/CloudConnectorsSection.tsx
- `CloudConnectorsSettingsBody` — src/cloud/connectors/CloudConnectorsUpsell.tsx
- `CloudConnectorsSettingsSection` — src/cloud/connectors/index.ts
- `CloudSettingsSectionShell` — src/cloud/settings/CloudSettingsSectionShell.tsx
- `CloudAccountSection` — src/cloud/settings/sections.tsx
- `CloudBillingSection` — src/cloud/settings/sections.tsx
- `CloudApiKeysSection` — src/cloud/settings/sections.tsx
- `CloudApplicationsSection` — src/cloud/settings/sections.tsx
- `CloudMonetizationSection` — src/cloud/settings/sections.tsx
- `CloudOrganizationSection` — src/cloud/settings/sections.tsx
- `CloudSecuritySection` — src/cloud/settings/sections.tsx
- `CloudPluginGrantsSection` — src/cloud/settings/sections.tsx
- `CloudI18nProvider` — src/cloud/shell/CloudI18nProvider.tsx
- `CloudRouterShell` — src/cloud/shell/CloudRouterShell.tsx
- `CloudImage` — src/cloud-ui/runtime/image.tsx
- `CloudSourceModeToggle` — src/components/cloud/CloudSourceControls.tsx
- `CloudConnectionStatus` — src/components/cloud/CloudSourceControls.tsx
- `CloudStatusBadge` — src/components/cloud/CloudStatusBadge.tsx
- `CloudDashboard` — src/components/pages/ElizaCloudDashboard.tsx
- `CloudRpcStatus` — src/components/pages/config-page-sections.tsx
- `CloudServicesSection` — src/components/pages/config-page-sections.tsx
- `CloudAgentsSection` — src/components/settings/CloudAgentsSection.tsx
- `CloudOverviewSection` — src/components/settings/CloudOverviewSection.tsx
- `CloudPanel` — src/components/settings/ProviderPanels.tsx
- `CloudHandoffBanner` — src/components/shell/CloudHandoffBanner.tsx

### `app*` × 24
- `App` — src/App.tsx
- `AppBackground` — src/backgrounds/AppBackground.tsx
- `AppAnalytics` — src/cloud/applications/components/app-analytics.tsx
- `AppDetailsTabs` — src/cloud/applications/components/app-details-tabs.tsx
- `AppDomains` — src/cloud/applications/components/app-domains.tsx
- `AppEarningsDashboard` — src/cloud/applications/components/app-earnings-dashboard.tsx
- `AppFrontendHosting` — src/cloud/applications/components/app-frontend-hosting.tsx
- `AppMonetizationSettings` — src/cloud/applications/components/app-monetization-settings.tsx
- `AppOverview` — src/cloud/applications/components/app-overview.tsx
- `AppPromote` — src/cloud/applications/components/app-promote.tsx
- `AppSettings` — src/cloud/applications/components/app-settings.tsx
- `AppUsers` — src/cloud/applications/components/app-users.tsx
- `AppAuthAuthorizePage` — src/cloud/public-pages/pages/app-auth/app-authorize-page.tsx
- `AppChargePaymentPage` — src/cloud/public-pages/pages/payment/app-charge-page.tsx
- `AppCatchAllRoute` — src/cloud/shell/CloudRouterShell.tsx
- `AppWindowRenderer` — src/components/apps/AppWindowRenderer.tsx
- `AppIdentityTile` — src/components/apps/app-identity.tsx
- `AppHero` — src/components/apps/app-identity.tsx
- `AppPermissionsSection` — src/components/settings/AppPermissionsSection.tsx
- `AppPageSidebar` — src/components/shared/AppPageSidebar.tsx
- `AppWorkspaceChrome` — src/components/workspace/AppWorkspaceChrome.tsx
- `AppBootContext` — src/config/boot-config-react.hooks.ts
- `AppProvider` — src/state/AppContext.tsx
- `AppContext` — src/state/useApp.ts

### `dashboard*` × 24
- `DashboardHomePage` — src/cloud/home/DashboardHomePage.tsx
- `DashboardSection` — src/cloud-ui/components/brand/dashboard-section.tsx
- `DashboardStatCard` — src/cloud-ui/components/brand/dashboard-stat-card.tsx
- `DashboardActionCards` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardActionCardsSkeleton` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardRouteError` — src/cloud-ui/components/dashboard/dashboard-route-error.tsx
- `DashboardLoadingState` — src/cloud-ui/components/dashboard/route-placeholders.tsx
- `DashboardErrorState` — src/cloud-ui/components/dashboard/route-placeholders.tsx
- `DashboardDataList` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListMobile` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListDesktop` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListCard` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListFilteredCount` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardTableSkeleton` — src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx
- `DashboardHeader` — src/cloud-ui/components/layout/dashboard-header.tsx
- `DashboardPageContainer` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardPageStack` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardToolbar` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardStatGrid` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardRoutePage` — src/cloud-ui/components/layout/dashboard-route-page.tsx
- `DashboardSidebarNavigationItem` — src/cloud-ui/components/layout/dashboard-sidebar-item.tsx
- `DashboardSidebarNavigationSection` — src/cloud-ui/components/layout/dashboard-sidebar-section.tsx
- `DashboardSidebar` — src/cloud-ui/components/layout/dashboard-sidebar.tsx

### `chat*` × 21
- `ChatVoiceStatusBar` — src/components/composites/chat/ChatVoiceStatusBar.tsx
- `ChatAttachmentStrip` — src/components/composites/chat/chat-attachment-strip.tsx
- `ChatBubble` — src/components/composites/chat/chat-bubble.tsx
- `ChatComposerShell` — src/components/composites/chat/chat-composer-shell.tsx
- `ChatComposer` — src/components/composites/chat/chat-composer.tsx
- `ChatConversationItem` — src/components/composites/chat/chat-conversation-item.tsx
- `ChatConversationRenameDialog` — src/components/composites/chat/chat-conversation-rename-dialog.tsx
- `ChatEmptyState` — src/components/composites/chat/chat-empty-state.tsx
- `ChatMessageActions` — src/components/composites/chat/chat-message-actions.tsx
- `ChatMessage` — src/components/composites/chat/chat-message.tsx
- `ChatSourceIcon` — src/components/composites/chat/chat-source.tsx
- `ChatVoiceSpeakerBadge` — src/components/composites/chat/chat-source.tsx
- `ChatThreadLayout` — src/components/composites/chat/chat-thread-layout.tsx
- `ChatTranscript` — src/components/composites/chat/chat-transcript.tsx
- `ChatSearchHint` — src/components/composites/chat-search-hint.tsx
- `ChatView` — src/components/pages/ChatView.tsx
- `ChatHotkeySettingsGroup` — src/components/settings/ChatHotkeySettingsGroup.tsx
- `ChatSurface` — src/components/shell/ChatSurface.tsx
- `ChatComposerCtx` — src/state/ChatComposerContext.hooks.ts
- `ChatInputRefCtx` — src/state/ChatComposerContext.hooks.ts
- `ChatTurnStatusCtx` — src/state/ChatTurnStatusContext.hooks.ts

### `settings*` × 20
- `SettingsView` — src/components/pages/SettingsView.tsx
- `SettingsSectionNav` — src/components/settings/SettingsSectionNav.tsx
- `SettingsSwitchRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsSelectRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsSegmentedRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsInputRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsTextareaRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsActionButton` — src/components/settings/settings-agent-rows.tsx
- `SettingsStack` — src/components/settings/settings-layout.tsx
- `SettingsGroup` — src/components/settings/settings-layout.tsx
- `SettingsRow` — src/components/settings/settings-layout.tsx
- `SettingsMutedText` — src/components/ui/settings-controls.tsx
- `SettingsField` — src/components/ui/settings-controls.tsx
- `SettingsFieldLabel` — src/components/ui/settings-controls.tsx
- `SettingsFieldDescription` — src/components/ui/settings-controls.tsx
- `SettingsSelectTrigger` — src/components/ui/settings-controls.tsx
- `SettingsInput` — src/components/ui/settings-controls.tsx
- `SettingsTextarea` — src/components/ui/settings-controls.tsx
- `SettingsSegmentedGroup` — src/components/ui/settings-controls.tsx
- `SettingsControls` — src/components/ui/settings-controls.tsx

### `eliza*` × 17
- `ElizaClient` — src/api/client-base.ts
- `ElizaAgentActions` — src/cloud/instances/components/agent-actions.tsx
- `ElizaAgentBackupsPanel` — src/cloud/instances/components/eliza-agent-backups-panel.tsx
- `ElizaAgentLogsViewer` — src/cloud/instances/components/eliza-agent-logs-viewer.tsx
- `ElizaAgentPricingBanner` — src/cloud/instances/components/eliza-agent-pricing-banner.tsx
- `ElizaAgentTabs` — src/cloud/instances/components/eliza-agent-tabs.tsx
- `ElizaAgentsTable` — src/cloud/instances/components/eliza-agents-table.tsx
- `ElizaConnectButton` — src/cloud/instances/components/eliza-connect-button.tsx
- `ElizaPoliciesSection` — src/cloud/instances/components/eliza-policies-section.tsx
- `ElizaTransactionsSection` — src/cloud/instances/components/eliza-transactions-section.tsx
- `ElizaWalletSection` — src/cloud/instances/components/eliza-wallet-section.tsx
- `ElizaCloudLockup` — src/cloud-ui/components/brand/eliza-cloud-lockup.tsx
- `ElizaLogo` — src/cloud-ui/components/brand/eliza-logo.tsx
- `ElizaAgentsPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `ElizaMark` — src/components/brand/eliza-mark.tsx
- `ElizaGenUiActionError` — src/genui/actions.ts
- `ElizaGenUiRenderer` — src/genui/renderer.tsx

### `view*` × 16
- `ViewAgentRegistry` — src/agent-surface/registry.ts
- `ViewBackButton` — src/components/shared/ViewHeader.tsx
- `ViewHeader` — src/components/shared/ViewHeader.tsx
- `ViewHeaderSidebarTrigger` — src/components/shared/ViewHeaderSidebarTrigger.tsx
- `ViewEmptyState` — src/components/ui/view-empty-state.tsx
- `ViewErrorBoundary` — src/components/views/ViewErrorBoundary.tsx
- `ViewIcon` — src/components/views/ViewIcon.tsx
- `ViewStatusFrame` — src/components/views/ViewStatusStates.tsx
- `ViewLoadingSkeleton` — src/components/views/ViewStatusStates.tsx
- `ViewRecoveryActions` — src/components/views/ViewStatusStates.tsx
- `ViewErrorState` — src/components/views/ViewStatusStates.tsx
- `ViewRestrictedState` — src/components/views/ViewStatusStates.tsx
- `ViewTelemetryProfiler` — src/components/views/ViewTelemetryProfiler.tsx
- `ViewTileImage` — src/components/views/ViewTileImage.tsx
- `ViewLifecycleSlot` — src/state/view-lifecycle-context.tsx
- `ViewLifecycleSlotContext` — src/state/view-lifecycle-context.tsx

### `api*` × 15
- `ApiError` — src/api/client-types-core.ts
- `ApiKeysLink` — src/cloud/account-security/components/api-keys-link.tsx
- `ApiExplorerSurface` — src/cloud/api-explorer/ApiExplorerPage.tsx
- `ApiExplorerRoute` — src/cloud/api-explorer/ApiExplorerPage.tsx
- `ApiTester` — src/cloud/api-explorer/api-tester.tsx
- `ApiKeysPage` — src/cloud/api-keys/ApiKeysPage.tsx
- `ApiKeysSurface` — src/cloud/api-keys/ApiKeysSurface.tsx
- `ApiKeysView` — src/cloud/api-keys/ApiKeysView.tsx
- `ApiError` — src/cloud/lib/api-client.ts
- `ApiKeyEmptyState` — src/cloud-ui/components/api-key-empty-state.tsx
- `ApiKeysTable` — src/cloud-ui/components/data-list/api-keys-table.tsx
- `ApiParameterSelect` — src/cloud-ui/components/docs/api-parameter-select.tsx
- `ApiRouteExplorerClient` — src/cloud-ui/components/docs/api-route-explorer-client.tsx
- `ApiKeyConfig` — src/components/settings/ApiKeyConfig.tsx
- `ApiKeyPanel` — src/components/settings/ProviderPanels.tsx

### `relationships*` × 15
- `RelationshipsAttentionWidget` — src/components/chat/widgets/relationships-attention.tsx
- `RelationshipsGraphPanel` — src/components/pages/RelationshipsGraphPanel.tsx
- `RelationshipsIdentityCluster` — src/components/pages/RelationshipsIdentityCluster.tsx
- `RelationshipsView` — src/components/pages/RelationshipsView.tsx
- `RelationshipsActivityFeed` — src/components/pages/relationships/RelationshipsActivityFeed.tsx
- `RelationshipsCandidateMergesPanel` — src/components/pages/relationships/RelationshipsCandidateMergesPanel.tsx
- `RelationshipsPersonSummaryPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsFactsPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsConnectionsPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsConversationsPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsRelevantMemoriesPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsUserPreferencesPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsDocumentsPanel` — src/components/pages/relationships/RelationshipsPersonPanels.tsx
- `RelationshipsSidebar` — src/components/pages/relationships/RelationshipsSidebar.tsx
- `RelationshipsWorkspaceView` — src/components/pages/relationships/RelationshipsWorkspaceView.tsx

### `character*` × 14
- `CharacterFilters` — src/cloud/instances/components/character-filters.tsx
- `CharacterLibraryGrid` — src/cloud/instances/components/character-library-grid.tsx
- `CharacterEditor` — src/components/character/CharacterEditor.tsx
- `CharacterIdentityPanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterStylePanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterExamplesPanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterExperienceView` — src/components/character/CharacterExperienceView.tsx
- `CharacterExperienceWorkspace` — src/components/character/CharacterExperienceWorkspace.tsx
- `CharacterHubView` — src/components/character/CharacterHubView.tsx
- `CharacterLearnedSkillsSection` — src/components/character/CharacterLearnedSkillsSection.tsx
- `CharacterOverviewSection` — src/components/character/CharacterOverviewSection.tsx
- `CharacterPersonalityTimeline` — src/components/character/CharacterPersonalityTimeline.tsx
- `CharacterRoster` — src/components/character/CharacterRoster.tsx
- `CharacterSkillsView` — src/components/character/CharacterSkillsView.tsx

### `page*` × 14
- `PageHeaderContext` — src/cloud-ui/components/layout/page-header-context.hooks.ts
- `PageHeaderProvider` — src/cloud-ui/components/layout/page-header-context.tsx
- `PageTransition` — src/cloud-ui/components/layout/page-transition.tsx
- `PagePanelCollapsibleSection` — src/components/composites/page-panel/page-panel-collapsible-section.tsx
- `PageEmptyState` — src/components/composites/page-panel/page-panel-empty.tsx
- `PagePanelFeatureEmpty` — src/components/composites/page-panel/page-panel-feature-empty.tsx
- `PagePanelFrame` — src/components/composites/page-panel/page-panel-frame.tsx
- `PagePanelContentArea` — src/components/composites/page-panel/page-panel-frame.tsx
- `PageActionRail` — src/components/composites/page-panel/page-panel-header.tsx
- `PageLoadingState` — src/components/composites/page-panel/page-panel-loading.tsx
- `PagePanelRoot` — src/components/composites/page-panel/page-panel-root.tsx
- `PagePanelToolbar` — src/components/composites/page-panel/page-panel-toolbar.tsx
- `PageLayoutHeader` — src/layouts/page-layout/page-layout-header.tsx
- `PageLayoutMobileDrawer` — src/layouts/page-layout/page-layout-mobile-drawer.tsx

### `agent*` × 13
- `AgentElementOverlay` — src/agent-surface/AgentElementOverlay.tsx
- `AgentSurfaceContext` — src/agent-surface/AgentSurfaceContext.hooks.ts
- `AgentSurfaceProvider` — src/agent-surface/AgentSurfaceContext.tsx
- `AgentButton` — src/agent-surface/components.tsx
- `AgentInput` — src/agent-surface/components.tsx
- `AgentDetailPage` — src/cloud/instances/AgentDetailPage.tsx
- `AgentCard` — src/cloud/instances/components/agent-card.tsx
- `AgentCostBadge` — src/cloud/instances/components/agent-cost-badge.tsx
- `AgentCard` — src/cloud-ui/components/brand/brand-card.tsx
- `AgentActivityBox` — src/components/chat/AgentActivityBox.tsx
- `AgentActivityWidget` — src/components/chat/widgets/agent-activity.tsx
- `AgentProvisioningWidget` — src/components/chat/widgets/agent-provisioning.tsx
- `AgentProfileView` — src/spatial/example.tsx

### `voice*` × 12
- `VoiceProfilesUnavailableError` — src/api/client-voice-profiles.ts
- `VoiceProfilesClient` — src/api/client-voice-profiles.ts
- `VoiceAudioPlayer` — src/cloud-ui/components/voice/voice-audio-player.tsx
- `VoiceEmptyState` — src/cloud-ui/components/voice/voice-empty-state.tsx
- `VoiceStatusBadge` — src/cloud-ui/components/voice/voice-status-badge.tsx
- `VoiceConfigView` — src/components/settings/VoiceConfigView.tsx
- `VoiceProfileSection` — src/components/settings/VoiceProfileSection.tsx
- `VoiceSection` — src/components/settings/VoiceSection.tsx
- `VoiceSectionMount` — src/components/settings/VoiceSectionMount.tsx
- `VoiceTierBanner` — src/components/settings/VoiceTierBanner.tsx
- `VoiceSelfTestShell` — src/voice/voice-selftest/VoiceSelfTestShell.tsx
- `VoiceWorkbenchShell` — src/voice/voice-selftest/VoiceWorkbenchShell.tsx

### `admin*` × 12
- `AdminGate` — src/cloud/admin/AdminGate.tsx
- `AdminDialogContent` — src/components/ui/admin-dialog.tsx
- `AdminDialogHeader` — src/components/ui/admin-dialog.tsx
- `AdminDialogFooterChrome` — src/components/ui/admin-dialog.tsx
- `AdminDialogBodyScroll` — src/components/ui/admin-dialog.tsx
- `AdminMetaBadge` — src/components/ui/admin-dialog.tsx
- `AdminMonoMeta` — src/components/ui/admin-dialog.tsx
- `AdminCodeEditor` — src/components/ui/admin-dialog.tsx
- `AdminSegmentedTabList` — src/components/ui/admin-dialog.tsx
- `AdminSegmentedTab` — src/components/ui/admin-dialog.tsx
- `AdminInput` — src/components/ui/admin-dialog.tsx
- `AdminDialog` — src/components/ui/admin-dialog.tsx

### `connector*` × 12
- `ConnectorAccountPicker` — src/components/chat/ConnectorAccountPicker.tsx
- `ConnectorAccountAuditList` — src/components/connectors/ConnectorAccountAuditList.tsx
- `ConnectorAccountCard` — src/components/connectors/ConnectorAccountCard.tsx
- `ConnectorAccountList` — src/components/connectors/ConnectorAccountList.tsx
- `ConnectorAccountPrivacySelector` — src/components/connectors/ConnectorAccountPrivacySelector.tsx
- `ConnectorAccountPurposeSelector` — src/components/connectors/ConnectorAccountPurposeSelector.tsx
- `ConnectorAccountSetupScope` — src/components/connectors/ConnectorAccountSetupScope.tsx
- `ConnectorModeSelector` — src/components/connectors/ConnectorModeSelector.tsx
- `ConnectorQrPairingOverlay` — src/components/connectors/ConnectorQrPairingOverlay.tsx
- `ConnectorSetupPanel` — src/components/connectors/ConnectorSetupPanel.tsx
- `ConnectorPluginGroups` — src/components/pages/plugin-view-connectors.tsx
- `ConnectorSidebar` — src/components/pages/plugin-view-sidebar.tsx

### `apps*` × 10
- `AppsTable` — src/cloud/applications/components/apps-table.tsx
- `AppsPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsEmptyState` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsSkeleton` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsListView` — src/cloud-ui/components/data-list/apps-list-view.tsx
- `AppsCatalogGrid` — src/components/apps/AppsCatalogGrid.tsx
- `AppsSidebar` — src/components/apps/AppsSidebar.tsx
- `AppsSection` — src/components/chat/AppsSection.tsx
- `AppsPageView` — src/components/pages/AppsPageView.tsx
- `AppsManagementSection` — src/components/settings/AppsManagementSection.tsx

### `account*` × 8
- `AccountPage` — src/cloud/account-security/AccountPage.tsx
- `AccountSurface` — src/cloud/account-security/AccountSurface.tsx
- `AccountDetails` — src/cloud/account-security/components/account-details.tsx
- `AccountPageClient` — src/cloud/account-security/components/account-page-client.tsx
- `AccountCard` — src/components/accounts/AccountCard.tsx
- `AccountList` — src/components/accounts/AccountList.tsx
- `AccountConnectBlock` — src/components/chat/AccountConnectBlock.tsx
- `AccountRequiredCard` — src/components/chat/AccountRequiredCard.tsx

### `trajectory*` × 8
- `TrajectoryCacheStats` — src/components/composites/trajectories/trajectory-cache-stats.tsx
- `TrajectoryCodeBlock` — src/components/composites/trajectories/trajectory-code-block.tsx
- `TrajectoryContextDiffList` — src/components/composites/trajectories/trajectory-context-diff-list.tsx
- `TrajectoryEventTimeline` — src/components/composites/trajectories/trajectory-event-timeline.tsx
- `TrajectoryLlmCallCard` — src/components/composites/trajectories/trajectory-llm-call-card.tsx
- `TrajectoryPipelineGraph` — src/components/composites/trajectories/trajectory-pipeline-graph.tsx
- `TrajectorySidebarItem` — src/components/composites/trajectories/trajectory-sidebar-item.tsx
- `TrajectoryDetailView` — src/components/pages/TrajectoryDetailView.tsx

### `shell*` × 7
- `ShellModalityProvider` — src/components/ShellModalityProvider.tsx
- `ShellRoleProvider` — src/components/ShellRoleProvider.tsx
- `ShellControllerContext` — src/components/shell/ShellControllerContext.hooks.ts
- `ShellControllerProvider` — src/components/shell/ShellControllerContext.tsx
- `ShellHeaderControls` — src/components/shell/ShellHeaderControls.tsx
- `ShellOverlays` — src/components/shell/ShellOverlays.tsx
- `ShellViewAgentSurface` — src/components/views/ShellViewAgentSurface.tsx

### `plugin*` × 6
- `PluginPermissionsPageClient` — src/cloud/account-security/components/plugin-permissions-page-client.tsx
- `PluginCard` — src/components/pages/PluginCard.tsx
- `PluginConfigForm` — src/components/pages/PluginConfigForm.tsx
- `PluginVisual` — src/components/pages/PluginVisual.tsx
- `PluginSettingsDialog` — src/components/pages/plugin-view-dialogs.tsx
- `PluginGameModal` — src/components/pages/plugin-view-modal.tsx

### `model*` × 6
- `ModelBreakdown` — src/cloud/analytics/_components/model-breakdown.tsx
- `ModelDownloadWidget` — src/components/chat/widgets/model-download.tsx
- `ModelCard` — src/components/local-inference/ModelCard.tsx
- `ModelHubView` — src/components/local-inference/ModelHubView.tsx
- `ModelUpdatesPanel` — src/components/local-inference/ModelUpdatesPanel.tsx
- `ModelStatusConductorMount` — src/first-run/use-model-status-conductor.ts

### `permission*` × 6
- `PermissionCard` — src/components/composites/chat/permission-card.tsx
- `PermissionIcon` — src/components/permissions/PermissionIcon.tsx
- `PermissionPrimingModal` — src/components/permissions/PermissionPrimingModal.tsx
- `PermissionPrimingOverlay` — src/components/permissions/PermissionPrimingOverlay.tsx
- `PermissionRecoveryCallout` — src/components/permissions/PermissionRecoveryCallout.tsx
- `PermissionRow` — src/components/settings/permission-controls.tsx

### `background*` × 5
- `BackgroundHost` — src/backgrounds/BackgroundHost.tsx
- `BackgroundView` — src/components/pages/BackgroundView.tsx
- `BackgroundImageError` — src/components/pages/background-image.ts
- `BackgroundSettingsControls` — src/components/settings/BackgroundSettingsControls.tsx
- `BackgroundSettingsSection` — src/components/settings/BackgroundSettingsSection.tsx

### `organization*` × 5
- `OrganizationInfo` — src/cloud/account-security/components/organization-info.tsx
- `OrganizationPage` — src/cloud/organization/OrganizationPage.tsx
- `OrganizationSection` — src/cloud/organization/OrganizationSection.tsx
- `OrganizationGeneralTab` — src/cloud/organization/organization-general-tab.tsx
- `OrganizationTab` — src/cloud/organization/organization-tab.tsx

### `status*` × 5
- `StatusBadge` — src/cloud/mcps/McpDetailDrawer.tsx
- `StatusPill` — src/components/release-center/shared.tsx
- `StatusBar` — src/components/stream/StatusBar.tsx
- `StatusBadge` — src/components/ui/status-badge.tsx
- `StatusDot` — src/components/ui/status-badge.tsx

### `local*` × 5
- `LocalStewardAuthContext` — src/cloud/shell/StewardProviderShared.ts
- `LocalInferencePanel` — src/components/local-inference/LocalInferencePanel.tsx
- `LocalProviderPanel` — src/components/settings/ProviderPanels.tsx
- `LocalInferenceEngine` — src/services/local-inference/engine.ts
- `LocalInferenceService` — src/services/local-inference/service.ts

### `section*` × 5
- `SectionHeader` — src/cloud-ui/components/brand/section-header.tsx
- `SectionLabel` — src/cloud-ui/components/brand/section-header.tsx
- `SectionNavTab` — src/components/shared/SectionNav.tsx
- `SectionTabStrip` — src/components/shared/SectionNav.tsx
- `SectionNav` — src/components/shared/SectionNav.tsx

### `render*` × 5
- `RenderTelemetryProfiler` — src/cloud-ui/runtime/render-telemetry.tsx
- `RenderSelectField` — src/components/config-ui/config-field.helpers.tsx
- `RenderFileField` — src/components/config-ui/config-field.helpers.tsx
- `RenderCustomField` — src/components/config-ui/config-field.helpers.tsx
- `RenderProbe` — src/testing/render-counter.tsx

### `desktop*` × 5
- `DesktopGameWindowControls` — src/components/apps/FullscreenView.tsx
- `DesktopTabBar` — src/components/desktop/DesktopTabBar.tsx
- `DesktopWorkspaceDisplay` — src/components/settings/DesktopWorkspaceDisplay.tsx
- `DesktopWorkspaceSection` — src/components/settings/DesktopWorkspaceSection.tsx
- `DesktopTalkModePanel` — src/components/settings/VoiceConfigView.tsx

### `message*` × 5
- `MessageAttachments` — src/components/chat/MessageAttachments.tsx
- `MessageUiSpecBlock` — src/components/chat/MessageContent.tsx
- `MessagePermissionCard` — src/components/chat/MessageContent.tsx
- `MessageContent` — src/components/chat/MessageContent.tsx
- `MessageSearchPanel` — src/components/chat/message-search/MessageSearchPanel.tsx

### `active*` × 4
- `ActiveSessionsPanel` — src/cloud/account-security/components/active-sessions-panel.tsx
- `ActiveModelBar` — src/components/local-inference/ActiveModelBar.tsx
- `ActiveProviderSummary` — src/components/settings/ProviderSwitcher.tsx
- `ActiveModelCoordinator` — src/services/local-inference/active-model.ts

### `provider*` × 4
- `ProviderBreakdown` — src/cloud/analytics/_components/provider-breakdown.tsx
- `ProviderCard` — src/components/settings/ProviderCard.tsx
- `ProviderRoutingPanel` — src/components/settings/ProviderRoutingPanel.tsx
- `ProviderSwitcher` — src/components/settings/ProviderSwitcher.tsx

### `billing*` × 4
- `BillingPage` — src/cloud/billing/BillingPage.tsx
- `BillingSectionBody` — src/cloud/billing/BillingSection.tsx
- `BillingSuccessPage` — src/cloud/billing/BillingSuccessPage.tsx
- `BillingTab` — src/cloud/billing/components/billing-tab.tsx

### `steward*` × 4
- `StewardWalletProviders` — src/cloud/billing/wallet/steward-wallet-providers.tsx
- `StewardLoginSection` — src/cloud/public-pages/pages/login/steward-login-section.tsx
- `StewardAuthProvider` — src/cloud/shell/StewardProvider.tsx
- `StewardAuthRuntimeProvider` — src/cloud/shell/StewardProviderRuntime.tsx

### `telegram*` × 4
- `TelegramConnection` — src/cloud/connectors/telegram-connection.tsx
- `TelegramIcon` — src/cloud-ui/components/icons.tsx
- `TelegramAccountConnectorPanel` — src/components/connectors/TelegramAccountConnectorPanel.tsx
- `TelegramBotSetupPanel` — src/components/connectors/TelegramBotSetupPanel.tsx

### `my*` × 4
- `MyAgentsPage` — src/cloud/instances/MyAgentsPage.tsx
- `MyAgentsClient` — src/cloud/instances/components/my-agents.tsx
- `MyRuntimesContainer` — src/components/cockpit/MyRuntimesContainer.tsx
- `MyRuntimesSection` — src/components/cockpit/MyRuntimesSection.tsx

### `theme*` × 4
- `ThemeContext` — src/cloud-ui/components/theme/theme-provider.hooks.ts
- `ThemeProvider` — src/cloud-ui/components/theme/theme-provider.tsx
- `ThemeToggle` — src/cloud-ui/components/theme/theme-toggle.tsx
- `ThemeToggle` — src/components/shared/ThemeToggle.tsx

### `home*` × 4
- `HomeWidgetCard` — src/components/chat/widgets/home-widget-card.tsx
- `HomeLauncherSurface` — src/components/shell/HomeLauncherSurface.tsx
- `HomePill` — src/components/shell/HomePill.tsx
- `HomeScreen` — src/components/shell/HomeScreen.tsx

### `topic*` × 4
- `TopicChipsBar` — src/components/chat/widgets/topic-chips-bar.tsx
- `TopicGroupedTranscript` — src/components/chat/widgets/topic-grouped-transcript.tsx
- `TopicChipsBar` — src/components/shell/TopicChipsBar.tsx
- `TopicGroup` — src/components/shell/TopicGroup.tsx


## 3. Variant suffix siblings (11)

Components named like `Foo` AND `FooLite/FooCompact/FooMobile/...` — likely targets for a single component + variant prop.

- **PromptCard** ↔ **PromptCardGrid** (suffix: `grid`) — src/cloud-ui/components/brand/prompt-card.tsx
- **DashboardDataList** ↔ **DashboardDataListMobile** (suffix: `mobile`) — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- **DashboardDataList** ↔ **DashboardDataListCard** (suffix: `card`) — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- **Sidebar** ↔ **SidebarBody** (suffix: `body`) — src/components/composites/sidebar/sidebar-body.tsx
- **SidebarItem** ↔ **SidebarItemBody** (suffix: `body`) — src/components/composites/sidebar/sidebar-content.tsx
- **Sidebar** ↔ **SidebarHeader** (suffix: `header`) — src/components/composites/sidebar/sidebar-header.tsx
- **Sidebar** ↔ **SidebarPanel** (suffix: `panel`) — src/components/composites/sidebar/sidebar-panel.tsx
- **SettingsInput** ↔ **SettingsInputRow** (suffix: `row`) — src/components/settings/settings-agent-rows.tsx
- **SettingsTextarea** ↔ **SettingsTextareaRow** (suffix: `row`) — src/components/settings/settings-agent-rows.tsx
- **AdminDialog** ↔ **AdminDialogHeader** (suffix: `header`) — src/components/ui/admin-dialog.tsx
- **AdminSegmentedTab** ↔ **AdminSegmentedTabList** (suffix: `list`) — src/components/ui/admin-dialog.tsx