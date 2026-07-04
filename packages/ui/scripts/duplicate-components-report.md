# Duplicate component candidates in @elizaos/ui

Scanned **1445** files, **830** component-like exports.

Report JSON: `scripts/duplicate-components-report.json`


## 1. Exact-name duplicates (7)

Components exported with the *same name* from multiple files.


### `StatusBadge` × 3
- src/components/ui/status-badge.tsx
- src/cloud/mcps/McpDetailDrawer.tsx
- src/cloud/approvals/components/status-badge.tsx

### `AgentCard` × 2
- src/cloud-ui/components/brand/brand-card.tsx
- src/cloud/instances/components/agent-card.tsx

### `ThemeToggle` × 2
- src/cloud-ui/components/theme/theme-toggle.tsx
- src/components/shared/ThemeToggle.tsx

### `Text` × 2
- src/components/ui/typography.tsx
- src/spatial/primitives.tsx

### `Stack` × 2
- src/components/ui/stack.tsx
- src/spatial/primitives.tsx

### `TopicChipsBar` × 2
- src/components/chat/widgets/topic-chips-bar.tsx
- src/components/shell/TopicChipsBar.tsx

### `ApiError` × 2
- src/cloud/lib/api-client.ts
- src/api/client-types-core.ts


## 2. Partial-name clusters (123)

Components whose first token (lowercased) matches another. Useful for spotting families that share a name root (e.g. `Chat*`, `Setup*`).


_(Showing top 40 by size; pass --verbose for all.)_


### `sidebar*` × 26
- `SidebarCollapsedRail` — src/components/composites/sidebar/sidebar-collapsed-rail.tsx
- `SidebarCollapsedActionButton` — src/components/composites/sidebar/sidebar-collapsed-rail.tsx
- `SidebarPanel` — src/components/composites/sidebar/sidebar-panel.tsx
- `Sidebar` — src/components/composites/sidebar/sidebar-root.tsx
- `SidebarBody` — src/components/composites/sidebar/sidebar-body.tsx
- `SidebarHeaderStack` — src/components/composites/sidebar/sidebar-header-stack.tsx
- `SidebarScrollRegion` — src/components/composites/sidebar/sidebar-scroll-region.tsx
- `SidebarHeader` — src/components/composites/sidebar/sidebar-header.tsx
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
- `SidebarSearchBar` — src/components/composites/search/searchbar.tsx

### `cloud*` × 25
- `CloudImage` — src/cloud-ui/runtime/image.tsx
- `CloudOverviewSection` — src/components/settings/CloudOverviewSection.tsx
- `CloudAgentsSection` — src/components/settings/CloudAgentsSection.tsx
- `CloudPanel` — src/components/settings/ProviderPanels.tsx
- `CloudHandoffBanner` — src/components/shell/CloudHandoffBanner.tsx
- `CloudSourceModeToggle` — src/components/cloud/CloudSourceControls.tsx
- `CloudConnectionStatus` — src/components/cloud/CloudSourceControls.tsx
- `CloudStatusBadge` — src/components/cloud/CloudStatusBadge.tsx
- `CloudRpcStatus` — src/components/pages/config-page-sections.tsx
- `CloudServicesSection` — src/components/pages/config-page-sections.tsx
- `CloudDashboard` — src/components/pages/ElizaCloudDashboard.tsx
- `CloudConnectorsSection` — src/cloud/connectors/CloudConnectorsSection.tsx
- `CloudConnectorsSettingsBody` — src/cloud/connectors/CloudConnectorsUpsell.tsx
- `CloudConnectorsSettingsSection` — src/cloud/connectors/index.ts
- `CloudAccountSection` — src/cloud/settings/sections.tsx
- `CloudBillingSection` — src/cloud/settings/sections.tsx
- `CloudApiKeysSection` — src/cloud/settings/sections.tsx
- `CloudApplicationsSection` — src/cloud/settings/sections.tsx
- `CloudMonetizationSection` — src/cloud/settings/sections.tsx
- `CloudOrganizationSection` — src/cloud/settings/sections.tsx
- `CloudSecuritySection` — src/cloud/settings/sections.tsx
- `CloudPluginGrantsSection` — src/cloud/settings/sections.tsx
- `CloudSettingsSectionShell` — src/cloud/settings/CloudSettingsSectionShell.tsx
- `CloudRouterShell` — src/cloud/shell/CloudRouterShell.tsx
- `CloudI18nProvider` — src/cloud/shell/CloudI18nProvider.tsx

### `app*` × 24
- `App` — src/App.tsx
- `AppBootContext` — src/config/boot-config-react.hooks.ts
- `AppContext` — src/state/useApp.ts
- `AppProvider` — src/state/AppContext.tsx
- `AppBackground` — src/backgrounds/AppBackground.tsx
- `AppPermissionsSection` — src/components/settings/AppPermissionsSection.tsx
- `AppWorkspaceChrome` — src/components/workspace/AppWorkspaceChrome.tsx
- `AppPageSidebar` — src/components/shared/AppPageSidebar.tsx
- `AppIdentityTile` — src/components/apps/app-identity.tsx
- `AppHero` — src/components/apps/app-identity.tsx
- `AppWindowRenderer` — src/components/apps/AppWindowRenderer.tsx
- `AppCatchAllRoute` — src/cloud/shell/CloudRouterShell.tsx
- `AppChargePaymentPage` — src/cloud/public-pages/pages/payment/app-charge-page.tsx
- `AppAuthAuthorizePage` — src/cloud/public-pages/pages/app-auth/app-authorize-page.tsx
- `AppPromote` — src/cloud/applications/components/app-promote.tsx
- `AppEarningsDashboard` — src/cloud/applications/components/app-earnings-dashboard.tsx
- `AppAnalytics` — src/cloud/applications/components/app-analytics.tsx
- `AppMonetizationSettings` — src/cloud/applications/components/app-monetization-settings.tsx
- `AppUsers` — src/cloud/applications/components/app-users.tsx
- `AppDetailsTabs` — src/cloud/applications/components/app-details-tabs.tsx
- `AppDomains` — src/cloud/applications/components/app-domains.tsx
- `AppOverview` — src/cloud/applications/components/app-overview.tsx
- `AppSettings` — src/cloud/applications/components/app-settings.tsx
- `AppFrontendHosting` — src/cloud/applications/components/app-frontend-hosting.tsx

### `dashboard*` × 24
- `DashboardPageContainer` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardPageStack` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardToolbar` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardStatGrid` — src/cloud-ui/components/layout/dashboard-page.tsx
- `DashboardSidebarNavigationSection` — src/cloud-ui/components/layout/dashboard-sidebar-section.tsx
- `DashboardShellLayout` — src/cloud-ui/components/layout/dashboard-shell.tsx
- `DashboardSidebar` — src/cloud-ui/components/layout/dashboard-sidebar.tsx
- `DashboardHeader` — src/cloud-ui/components/layout/dashboard-header.tsx
- `DashboardSidebarNavigationItem` — src/cloud-ui/components/layout/dashboard-sidebar-item.tsx
- `DashboardRoutePage` — src/cloud-ui/components/layout/dashboard-route-page.tsx
- `DashboardSection` — src/cloud-ui/components/brand/dashboard-section.tsx
- `DashboardStatCard` — src/cloud-ui/components/brand/dashboard-stat-card.tsx
- `DashboardActionCards` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardActionCardsSkeleton` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `DashboardLoadingState` — src/cloud-ui/components/dashboard/route-placeholders.tsx
- `DashboardErrorState` — src/cloud-ui/components/dashboard/route-placeholders.tsx
- `DashboardRouteError` — src/cloud-ui/components/dashboard/dashboard-route-error.tsx
- `DashboardDataList` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListMobile` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListDesktop` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListCard` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardDataListFilteredCount` — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- `DashboardTableSkeleton` — src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx

### `chat*` × 23
- `ChatComposerCtx` — src/state/ChatComposerContext.hooks.ts
- `ChatInputRefCtx` — src/state/ChatComposerContext.hooks.ts
- `ChatTurnStatusCtx` — src/state/ChatTurnStatusContext.hooks.ts
- `ChatHotkeySettingsGroup` — src/components/settings/ChatHotkeySettingsGroup.tsx
- `ChatSurface` — src/components/shell/ChatSurface.tsx
- `ChatMessageActions` — src/components/composites/chat/chat-message-actions.tsx
- `ChatVoiceStatusBar` — src/components/composites/chat/ChatVoiceStatusBar.tsx
- `ChatComposer` — src/components/composites/chat/chat-composer.tsx
- `ChatEmptyState` — src/components/composites/chat/chat-empty-state.tsx
- `ChatBubble` — src/components/composites/chat/chat-bubble.tsx
- `ChatComposerShell` — src/components/composites/chat/chat-composer-shell.tsx
- `ChatConversationItem` — src/components/composites/chat/chat-conversation-item.tsx
- `ChatEmptyStateWithRecommendations` — src/components/composites/chat/ChatEmptyStateWithRecommendations.tsx
- `ChatThreadLayout` — src/components/composites/chat/chat-thread-layout.tsx
- `ChatAttachmentStrip` — src/components/composites/chat/chat-attachment-strip.tsx
- `ChatTranscript` — src/components/composites/chat/chat-transcript.tsx
- `ChatConversationRenameDialog` — src/components/composites/chat/chat-conversation-rename-dialog.tsx
- `ChatSourceIcon` — src/components/composites/chat/chat-source.tsx
- `ChatVoiceSpeakerBadge` — src/components/composites/chat/chat-source.tsx
- `ChatMessage` — src/components/composites/chat/chat-message.tsx
- `ChatSearchHint` — src/components/composites/chat-search-hint.tsx
- `ChatView` — src/components/pages/ChatView.tsx
- `ChatPanelLayout` — src/layouts/chat-panel-layout/chat-panel-layout.tsx

### `settings*` × 19
- `SettingsMutedText` — src/components/ui/settings-controls.tsx
- `SettingsField` — src/components/ui/settings-controls.tsx
- `SettingsFieldLabel` — src/components/ui/settings-controls.tsx
- `SettingsFieldDescription` — src/components/ui/settings-controls.tsx
- `SettingsSelectTrigger` — src/components/ui/settings-controls.tsx
- `SettingsInput` — src/components/ui/settings-controls.tsx
- `SettingsTextarea` — src/components/ui/settings-controls.tsx
- `SettingsSegmentedGroup` — src/components/ui/settings-controls.tsx
- `SettingsControls` — src/components/ui/settings-controls.tsx
- `SettingsSwitchRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsSelectRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsSegmentedRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsInputRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsTextareaRow` — src/components/settings/settings-agent-rows.tsx
- `SettingsActionButton` — src/components/settings/settings-agent-rows.tsx
- `SettingsStack` — src/components/settings/settings-layout.tsx
- `SettingsGroup` — src/components/settings/settings-layout.tsx
- `SettingsRow` — src/components/settings/settings-layout.tsx
- `SettingsView` — src/components/pages/SettingsView.tsx

### `eliza*` × 18
- `ElizaLogo` — src/cloud-ui/components/brand/eliza-logo.tsx
- `ElizaCloudLockup` — src/cloud-ui/components/brand/eliza-cloud-lockup.tsx
- `ElizaAgentsPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `ElizaAvatar` — src/cloud-ui/components/ai-elements/eliza-avatar.tsx
- `ElizaGenUiRenderer` — src/genui/renderer.tsx
- `ElizaGenUiActionError` — src/genui/actions.ts
- `ElizaMark` — src/components/brand/eliza-mark.tsx
- `ElizaAgentTabs` — src/cloud/instances/components/eliza-agent-tabs.tsx
- `ElizaAgentBackupsPanel` — src/cloud/instances/components/eliza-agent-backups-panel.tsx
- `ElizaTransactionsSection` — src/cloud/instances/components/eliza-transactions-section.tsx
- `ElizaWalletSection` — src/cloud/instances/components/eliza-wallet-section.tsx
- `ElizaAgentPricingBanner` — src/cloud/instances/components/eliza-agent-pricing-banner.tsx
- `ElizaAgentActions` — src/cloud/instances/components/agent-actions.tsx
- `ElizaPoliciesSection` — src/cloud/instances/components/eliza-policies-section.tsx
- `ElizaAgentsTable` — src/cloud/instances/components/eliza-agents-table.tsx
- `ElizaConnectButton` — src/cloud/instances/components/eliza-connect-button.tsx
- `ElizaAgentLogsViewer` — src/cloud/instances/components/eliza-agent-logs-viewer.tsx
- `ElizaClient` — src/api/client-base.ts

### `relationships*` × 15
- `RelationshipsAttentionWidget` — src/components/chat/widgets/relationships-attention.tsx
- `RelationshipsView` — src/components/pages/RelationshipsView.tsx
- `RelationshipsIdentityCluster` — src/components/pages/RelationshipsIdentityCluster.tsx
- `RelationshipsGraphPanel` — src/components/pages/RelationshipsGraphPanel.tsx
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

### `page*` × 14
- `PageHeaderContext` — src/cloud-ui/components/layout/page-header-context.hooks.ts
- `PageTransition` — src/cloud-ui/components/layout/page-transition.tsx
- `PageHeaderProvider` — src/cloud-ui/components/layout/page-header-context.tsx
- `PagePanelFeatureEmpty` — src/components/composites/page-panel/page-panel-feature-empty.tsx
- `PageLoadingState` — src/components/composites/page-panel/page-panel-loading.tsx
- `PageEmptyState` — src/components/composites/page-panel/page-panel-empty.tsx
- `PagePanelToolbar` — src/components/composites/page-panel/page-panel-toolbar.tsx
- `PagePanelRoot` — src/components/composites/page-panel/page-panel-root.tsx
- `PagePanelCollapsibleSection` — src/components/composites/page-panel/page-panel-collapsible-section.tsx
- `PagePanelFrame` — src/components/composites/page-panel/page-panel-frame.tsx
- `PagePanelContentArea` — src/components/composites/page-panel/page-panel-frame.tsx
- `PageActionRail` — src/components/composites/page-panel/page-panel-header.tsx
- `PageLayoutMobileDrawer` — src/layouts/page-layout/page-layout-mobile-drawer.tsx
- `PageLayoutHeader` — src/layouts/page-layout/page-layout-header.tsx

### `api*` × 14
- `ApiRouteExplorerClient` — src/cloud-ui/components/docs/api-route-explorer-client.tsx
- `ApiParameterSelect` — src/cloud-ui/components/docs/api-parameter-select.tsx
- `ApiKeyEmptyState` — src/cloud-ui/components/api-key-empty-state.tsx
- `ApiKeysTable` — src/cloud-ui/components/data-list/api-keys-table.tsx
- `ApiKeyConfig` — src/components/settings/ApiKeyConfig.tsx
- `ApiKeyPanel` — src/components/settings/ProviderPanels.tsx
- `ApiKeysLink` — src/cloud/account-security/components/api-keys-link.tsx
- `ApiKeysSurface` — src/cloud/api-keys/ApiKeysSurface.tsx
- `ApiKeysView` — src/cloud/api-keys/ApiKeysView.tsx
- `ApiExplorerSurface` — src/cloud/api-explorer/ApiExplorerPage.tsx
- `ApiExplorerRoute` — src/cloud/api-explorer/ApiExplorerPage.tsx
- `ApiTester` — src/cloud/api-explorer/api-tester.tsx
- `ApiError` — src/cloud/lib/api-client.ts
- `ApiError` — src/api/client-types-core.ts

### `view*` × 14
- `ViewLifecycleSlot` — src/state/view-lifecycle-context.tsx
- `ViewLifecycleSlotContext` — src/state/view-lifecycle-context.tsx
- `ViewBackButton` — src/components/shared/ViewHeader.tsx
- `ViewHeader` — src/components/shared/ViewHeader.tsx
- `ViewIcon` — src/components/views/ViewIcon.tsx
- `ViewTelemetryProfiler` — src/components/views/ViewTelemetryProfiler.tsx
- `ViewTileImage` — src/components/views/ViewTileImage.tsx
- `ViewErrorBoundary` — src/components/views/ViewErrorBoundary.tsx
- `ViewStatusFrame` — src/components/views/ViewStatusStates.tsx
- `ViewLoadingSkeleton` — src/components/views/ViewStatusStates.tsx
- `ViewRecoveryActions` — src/components/views/ViewStatusStates.tsx
- `ViewErrorState` — src/components/views/ViewStatusStates.tsx
- `ViewRestrictedState` — src/components/views/ViewStatusStates.tsx
- `ViewAgentRegistry` — src/agent-surface/registry.ts

### `character*` × 14
- `CharacterIdentityPanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterStylePanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterExamplesPanel` — src/components/character/CharacterEditorPanels.tsx
- `CharacterEditor` — src/components/character/CharacterEditor.tsx
- `CharacterExperienceView` — src/components/character/CharacterExperienceView.tsx
- `CharacterLearnedSkillsSection` — src/components/character/CharacterLearnedSkillsSection.tsx
- `CharacterSkillsView` — src/components/character/CharacterSkillsView.tsx
- `CharacterHubView` — src/components/character/CharacterHubView.tsx
- `CharacterPersonalityTimeline` — src/components/character/CharacterPersonalityTimeline.tsx
- `CharacterRoster` — src/components/character/CharacterRoster.tsx
- `CharacterOverviewSection` — src/components/character/CharacterOverviewSection.tsx
- `CharacterExperienceWorkspace` — src/components/character/CharacterExperienceWorkspace.tsx
- `CharacterFilters` — src/cloud/instances/components/character-filters.tsx
- `CharacterLibraryGrid` — src/cloud/instances/components/character-library-grid.tsx

### `agent*` × 13
- `AgentCard` — src/cloud-ui/components/brand/brand-card.tsx
- `AgentActivityBox` — src/components/chat/AgentActivityBox.tsx
- `AgentProvisioningWidget` — src/components/chat/widgets/agent-provisioning.tsx
- `AgentActivityWidget` — src/components/chat/widgets/agent-activity.tsx
- `AgentDetailPage` — src/cloud/instances/AgentDetailPage.tsx
- `AgentCard` — src/cloud/instances/components/agent-card.tsx
- `AgentCostBadge` — src/cloud/instances/components/agent-cost-badge.tsx
- `AgentProfileView` — src/spatial/example.tsx
- `AgentSurfaceContext` — src/agent-surface/AgentSurfaceContext.hooks.ts
- `AgentButton` — src/agent-surface/components.tsx
- `AgentInput` — src/agent-surface/components.tsx
- `AgentSurfaceProvider` — src/agent-surface/AgentSurfaceContext.tsx
- `AgentElementOverlay` — src/agent-surface/AgentElementOverlay.tsx

### `voice*` × 12
- `VoiceEmptyState` — src/cloud-ui/components/voice/voice-empty-state.tsx
- `VoiceStatusBadge` — src/cloud-ui/components/voice/voice-status-badge.tsx
- `VoiceAudioPlayer` — src/cloud-ui/components/voice/voice-audio-player.tsx
- `VoiceConfigView` — src/components/settings/VoiceConfigView.tsx
- `VoiceProfileSection` — src/components/settings/VoiceProfileSection.tsx
- `VoiceSection` — src/components/settings/VoiceSection.tsx
- `VoiceTierBanner` — src/components/settings/VoiceTierBanner.tsx
- `VoiceSectionMount` — src/components/settings/VoiceSectionMount.tsx
- `VoiceSelfTestShell` — src/voice/voice-selftest/VoiceSelfTestShell.tsx
- `VoiceWorkbenchShell` — src/voice/voice-selftest/VoiceWorkbenchShell.tsx
- `VoiceProfilesUnavailableError` — src/api/client-voice-profiles.ts
- `VoiceProfilesClient` — src/api/client-voice-profiles.ts

### `connector*` × 12
- `ConnectorSetupPanel` — src/components/connectors/ConnectorSetupPanel.tsx
- `ConnectorModeSelector` — src/components/connectors/ConnectorModeSelector.tsx
- `ConnectorQrPairingOverlay` — src/components/connectors/ConnectorQrPairingOverlay.tsx
- `ConnectorAccountPurposeSelector` — src/components/connectors/ConnectorAccountPurposeSelector.tsx
- `ConnectorAccountSetupScope` — src/components/connectors/ConnectorAccountSetupScope.tsx
- `ConnectorAccountAuditList` — src/components/connectors/ConnectorAccountAuditList.tsx
- `ConnectorAccountPrivacySelector` — src/components/connectors/ConnectorAccountPrivacySelector.tsx
- `ConnectorAccountCard` — src/components/connectors/ConnectorAccountCard.tsx
- `ConnectorAccountList` — src/components/connectors/ConnectorAccountList.tsx
- `ConnectorAccountPicker` — src/components/chat/ConnectorAccountPicker.tsx
- `ConnectorPluginGroups` — src/components/pages/plugin-view-connectors.tsx
- `ConnectorSidebar` — src/components/pages/plugin-view-sidebar.tsx

### `admin*` × 12
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
- `AdminGate` — src/cloud/admin/AdminGate.tsx

### `apps*` × 10
- `AppsPageWrapper` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsEmptyState` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsSkeleton` — src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx
- `AppsListView` — src/cloud-ui/components/data-list/apps-list-view.tsx
- `AppsManagementSection` — src/components/settings/AppsManagementSection.tsx
- `AppsSection` — src/components/chat/AppsSection.tsx
- `AppsPageView` — src/components/pages/AppsPageView.tsx
- `AppsSidebar` — src/components/apps/AppsSidebar.tsx
- `AppsCatalogGrid` — src/components/apps/AppsCatalogGrid.tsx
- `AppsTable` — src/cloud/applications/components/apps-table.tsx

### `trajectory*` × 8
- `TrajectoryContextDiffList` — src/components/composites/trajectories/trajectory-context-diff-list.tsx
- `TrajectorySidebarItem` — src/components/composites/trajectories/trajectory-sidebar-item.tsx
- `TrajectoryCacheStats` — src/components/composites/trajectories/trajectory-cache-stats.tsx
- `TrajectoryEventTimeline` — src/components/composites/trajectories/trajectory-event-timeline.tsx
- `TrajectoryPipelineGraph` — src/components/composites/trajectories/trajectory-pipeline-graph.tsx
- `TrajectoryCodeBlock` — src/components/composites/trajectories/trajectory-code-block.tsx
- `TrajectoryLlmCallCard` — src/components/composites/trajectories/trajectory-llm-call-card.tsx
- `TrajectoryDetailView` — src/components/pages/TrajectoryDetailView.tsx

### `shell*` × 7
- `ShellRoleProvider` — src/components/ShellRoleProvider.tsx
- `ShellControllerContext` — src/components/shell/ShellControllerContext.hooks.ts
- `ShellControllerProvider` — src/components/shell/ShellControllerContext.tsx
- `ShellOverlays` — src/components/shell/ShellOverlays.tsx
- `ShellHeaderControls` — src/components/shell/ShellHeaderControls.tsx
- `ShellModalityProvider` — src/components/ShellModalityProvider.tsx
- `ShellViewAgentSurface` — src/components/views/ShellViewAgentSurface.tsx

### `account*` × 7
- `AccountConnectBlock` — src/components/chat/AccountConnectBlock.tsx
- `AccountRequiredCard` — src/components/chat/AccountRequiredCard.tsx
- `AccountList` — src/components/accounts/AccountList.tsx
- `AccountCard` — src/components/accounts/AccountCard.tsx
- `AccountSurface` — src/cloud/account-security/AccountSurface.tsx
- `AccountDetails` — src/cloud/account-security/components/account-details.tsx
- `AccountPageClient` — src/cloud/account-security/components/account-page-client.tsx

### `status*` × 6
- `StatusBadge` — src/components/ui/status-badge.tsx
- `StatusDot` — src/components/ui/status-badge.tsx
- `StatusPill` — src/components/release-center/shared.tsx
- `StatusBar` — src/components/stream/StatusBar.tsx
- `StatusBadge` — src/cloud/mcps/McpDetailDrawer.tsx
- `StatusBadge` — src/cloud/approvals/components/status-badge.tsx

### `plugin*` × 6
- `PluginCard` — src/components/pages/PluginCard.tsx
- `PluginGameModal` — src/components/pages/plugin-view-modal.tsx
- `PluginSettingsDialog` — src/components/pages/plugin-view-dialogs.tsx
- `PluginConfigForm` — src/components/pages/PluginConfigForm.tsx
- `PluginVisual` — src/components/pages/PluginVisual.tsx
- `PluginPermissionsPageClient` — src/cloud/account-security/components/plugin-permissions-page-client.tsx

### `render*` × 5
- `RenderTelemetryProfiler` — src/cloud-ui/runtime/render-telemetry.tsx
- `RenderProbe` — src/testing/render-counter.tsx
- `RenderSelectField` — src/components/config-ui/config-field.helpers.tsx
- `RenderFileField` — src/components/config-ui/config-field.helpers.tsx
- `RenderCustomField` — src/components/config-ui/config-field.helpers.tsx

### `background*` × 5
- `BackgroundHost` — src/backgrounds/BackgroundHost.tsx
- `BackgroundSettingsControls` — src/components/settings/BackgroundSettingsControls.tsx
- `BackgroundSettingsSection` — src/components/settings/BackgroundSettingsSection.tsx
- `BackgroundView` — src/components/pages/BackgroundView.tsx
- `BackgroundImageError` — src/components/pages/background-image.ts

### `local*` × 5
- `LocalInferencePanel` — src/components/local-inference/LocalInferencePanel.tsx
- `LocalProviderPanel` — src/components/settings/ProviderPanels.tsx
- `LocalStewardAuthContext` — src/cloud/shell/StewardProviderShared.ts
- `LocalInferenceEngine` — src/services/local-inference/engine.ts
- `LocalInferenceService` — src/services/local-inference/service.ts

### `model*` × 5
- `ModelHubView` — src/components/local-inference/ModelHubView.tsx
- `ModelUpdatesPanel` — src/components/local-inference/ModelUpdatesPanel.tsx
- `ModelCard` — src/components/local-inference/ModelCard.tsx
- `ModelDownloadWidget` — src/components/chat/widgets/model-download.tsx
- `ModelBreakdown` — src/cloud/analytics/_components/model-breakdown.tsx

### `desktop*` × 5
- `DesktopWorkspaceSection` — src/components/settings/DesktopWorkspaceSection.tsx
- `DesktopTalkModePanel` — src/components/settings/VoiceConfigView.tsx
- `DesktopWorkspaceDisplay` — src/components/settings/DesktopWorkspaceDisplay.tsx
- `DesktopTabBar` — src/components/desktop/DesktopTabBar.tsx
- `DesktopGameWindowControls` — src/components/apps/FullscreenView.tsx

### `wallet*` × 5
- `WalletRpcSection` — src/components/settings/WalletRpcSection.tsx
- `WalletKeysSection` — src/components/settings/WalletKeysSection.tsx
- `WalletBalanceWidget` — src/components/chat/widgets/wallet-balance.tsx
- `WalletSectionNav` — src/components/pages/WalletSectionNav.tsx
- `WalletSignError` — src/cloud/approvals/lib/wallet-sign.ts

### `message*` × 5
- `MessageUiSpecBlock` — src/components/chat/MessageContent.tsx
- `MessagePermissionCard` — src/components/chat/MessageContent.tsx
- `MessageContent` — src/components/chat/MessageContent.tsx
- `MessageAttachments` — src/components/chat/MessageAttachments.tsx
- `MessageSearchPanel` — src/components/chat/message-search/MessageSearchPanel.tsx

### `organization*` × 5
- `OrganizationGeneralTab` — src/cloud/organization/organization-general-tab.tsx
- `OrganizationSection` — src/cloud/organization/OrganizationSection.tsx
- `OrganizationTab` — src/cloud/organization/organization-tab.tsx
- `OrganizationPage` — src/cloud/organization/OrganizationPage.tsx
- `OrganizationInfo` — src/cloud/account-security/components/organization-info.tsx

### `theme*` × 4
- `ThemeProvider` — src/cloud-ui/components/theme/theme-provider.tsx
- `ThemeContext` — src/cloud-ui/components/theme/theme-provider.hooks.ts
- `ThemeToggle` — src/cloud-ui/components/theme/theme-toggle.tsx
- `ThemeToggle` — src/components/shared/ThemeToggle.tsx

### `telegram*` × 4
- `TelegramIcon` — src/cloud-ui/components/icons.tsx
- `TelegramAccountConnectorPanel` — src/components/connectors/TelegramAccountConnectorPanel.tsx
- `TelegramBotSetupPanel` — src/components/connectors/TelegramBotSetupPanel.tsx
- `TelegramConnection` — src/cloud/connectors/telegram-connection.tsx

### `active*` × 4
- `ActiveModelBar` — src/components/local-inference/ActiveModelBar.tsx
- `ActiveProviderSummary` — src/components/settings/ProviderSwitcher.tsx
- `ActiveSessionsPanel` — src/cloud/account-security/components/active-sessions-panel.tsx
- `ActiveModelCoordinator` — src/services/local-inference/active-model.ts

### `provider*` × 4
- `ProviderRoutingPanel` — src/components/settings/ProviderRoutingPanel.tsx
- `ProviderCard` — src/components/settings/ProviderCard.tsx
- `ProviderSwitcher` — src/components/settings/ProviderSwitcher.tsx
- `ProviderBreakdown` — src/cloud/analytics/_components/provider-breakdown.tsx

### `permission*` × 4
- `PermissionRow` — src/components/settings/permission-controls.tsx
- `PermissionCard` — src/components/composites/chat/permission-card.tsx
- `PermissionIcon` — src/components/permissions/PermissionIcon.tsx
- `PermissionRecoveryCallout` — src/components/permissions/PermissionRecoveryCallout.tsx

### `topic*` × 4
- `TopicGroupedTranscript` — src/components/chat/widgets/topic-grouped-transcript.tsx
- `TopicChipsBar` — src/components/chat/widgets/topic-chips-bar.tsx
- `TopicGroup` — src/components/shell/TopicGroup.tsx
- `TopicChipsBar` — src/components/shell/TopicChipsBar.tsx

### `home*` × 4
- `HomeWidgetCard` — src/components/chat/widgets/home-widget-card.tsx
- `HomePill` — src/components/shell/HomePill.tsx
- `HomeLauncherSurface` — src/components/shell/HomeLauncherSurface.tsx
- `HomeScreen` — src/components/shell/HomeScreen.tsx

### `my*` × 4
- `MyRuntimesSection` — src/components/cockpit/MyRuntimesSection.tsx
- `MyRuntimesContainer` — src/components/cockpit/MyRuntimesContainer.tsx
- `MyAgentsPage` — src/cloud/instances/MyAgentsPage.tsx
- `MyAgentsClient` — src/cloud/instances/components/my-agents.tsx

### `cockpit*` × 4
- `CockpitNewSessionForm` — src/components/cockpit/CockpitNewSessionForm.tsx
- `CockpitView` — src/components/cockpit/CockpitView.tsx
- `CockpitTierToggle` — src/components/cockpit/CockpitTierToggle.tsx
- `CockpitModePicker` — src/components/cockpit/CockpitModePicker.tsx

### `config*` × 4
- `ConfigFieldErrors` — src/components/config-ui/config-control-primitives.tsx
- `ConfigRenderer` — src/components/config-ui/config-renderer.tsx
- `ConfigField` — src/components/config-ui/config-field.tsx
- `ConfigPageView` — src/components/pages/ConfigPageView.tsx


## 3. Variant suffix siblings (11)

Components named like `Foo` AND `FooLite/FooCompact/FooMobile/...` — likely targets for a single component + variant prop.

- **PromptCard** ↔ **PromptCardGrid** (suffix: `grid`) — src/cloud-ui/components/brand/prompt-card.tsx
- **DashboardDataList** ↔ **DashboardDataListMobile** (suffix: `mobile`) — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- **DashboardDataList** ↔ **DashboardDataListCard** (suffix: `card`) — src/cloud-ui/components/data-list/dashboard-data-list.tsx
- **AdminDialog** ↔ **AdminDialogHeader** (suffix: `header`) — src/components/ui/admin-dialog.tsx
- **AdminSegmentedTab** ↔ **AdminSegmentedTabList** (suffix: `list`) — src/components/ui/admin-dialog.tsx
- **SettingsInput** ↔ **SettingsInputRow** (suffix: `row`) — src/components/settings/settings-agent-rows.tsx
- **SettingsTextarea** ↔ **SettingsTextareaRow** (suffix: `row`) — src/components/settings/settings-agent-rows.tsx
- **Sidebar** ↔ **SidebarPanel** (suffix: `panel`) — src/components/composites/sidebar/sidebar-panel.tsx
- **Sidebar** ↔ **SidebarBody** (suffix: `body`) — src/components/composites/sidebar/sidebar-body.tsx
- **Sidebar** ↔ **SidebarHeader** (suffix: `header`) — src/components/composites/sidebar/sidebar-header.tsx
- **SidebarItem** ↔ **SidebarItemBody** (suffix: `body`) — src/components/composites/sidebar/sidebar-content.tsx