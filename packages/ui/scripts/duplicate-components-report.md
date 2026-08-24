# Atomic component duplicate inventory

Scanned 918 maintained React source files across packages and plugins.

This is a candidate inventory, not an instruction to merge every entry. Canonical wrappers, renderer adapters, and test doubles remain separate because they often have legitimate ownership.

| Atom | Canonical | Same-name | Wrappers | Parallel primitives | Raw host files |
| --- | ---: | ---: | ---: | ---: | ---: |
| alert | 5 | 0 | 0 | 1 | 0 |
| avatar | 2 | 0 | 0 | 0 | 0 |
| badge | 3 | 0 | 6 | 8 | 0 |
| button | 8 | 0 | 11 | 4 | 63 |
| card | 6 | 0 | 24 | 3 | 0 |
| checkbox | 1 | 0 | 0 | 0 | 14 |
| dialog | 10 | 0 | 10 | 2 | 1 |
| input | 4 | 0 | 3 | 3 | 14 |
| popover | 1 | 0 | 1 | 0 | 0 |
| progress | 1 | 0 | 0 | 3 | 0 |
| select | 2 | 0 | 2 | 0 | 3 |
| separator | 3 | 0 | 0 | 0 | 5 |
| skeleton | 4 | 0 | 2 | 5 | 0 |
| spinner | 1 | 0 | 0 | 0 | 0 |
| switch | 2 | 0 | 1 | 0 | 14 |
| table | 1 | 0 | 3 | 1 | 12 |
| tabs | 1 | 0 | 6 | 1 | 0 |
| textarea | 3 | 0 | 0 | 1 | 6 |
| tooltip | 4 | 0 | 0 | 0 | 0 |

## Named candidates by atom

### alert

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| parallel-primitive | `CostAlerts` in `packages/ui/src/cloud-ui/components/analytics/cost-alerts.tsx:16` | `AlertTriangle`, `Info`, `TrendingDown`, `div`, `p` |

### avatar

No named candidates.

### badge

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `ConnectionConnectedBadge` in `packages/ui/src/cloud-ui/components/connection-card.tsx:91` | `Badge`, `CheckCircle` |
| canonical-wrapper | `VoiceStatusBadge` in `packages/ui/src/cloud-ui/components/voice/voice-status-badge.tsx:20` | `AlertCircle`, `CheckCircle2`, `Clock`, `Loader2`, `StatusBadge` |
| canonical-wrapper | `ApprovalStatusBadge` in `packages/ui/src/cloud/approvals/components/status-badge.tsx:54` | `SharedStatusBadge` |
| canonical-wrapper | `AgentCostBadge` in `packages/ui/src/cloud/instances/components/agent-cost-badge.tsx:30` | `Tooltip`, `TooltipContent`, `TooltipTrigger`, `p`, `span` |
| canonical-wrapper | `McpStatusBadge` in `packages/ui/src/cloud/mcps/McpDetailDrawer.tsx:446` | `StatusBadge` |
| canonical-wrapper | `CloudStatusBadge` in `packages/ui/src/components/cloud/CloudStatusBadge.tsx:143` | `Button`, `span` |
| parallel-primitive | `LlmsTxtBadge` in `packages/ui/src/cloud-ui/components/docs/llms-txt-badge.tsx:8` | `a`, `div` |
| parallel-primitive | `SurfaceBadge` in `packages/ui/src/components/apps/extensions/surface.tsx:33` | `span` |
| parallel-primitive | `ChatVoiceSpeakerBadge` in `packages/ui/src/components/composites/chat/chat-source.tsx:56` | `Crown`, `Mic`, `span` |
| parallel-primitive | `OwnerBadge` in `packages/ui/src/components/composites/OwnerBadge.tsx:53` | `Crown`, `span` |
| parallel-primitive | `HardwareBadge` in `packages/ui/src/components/local-inference/HardwareBadge.tsx:16` | `AlertTriangle`, `Cpu`, `Gauge`, `HardDrive`, `div`, `span` |
| parallel-primitive | `RedactedBadge` in `packages/ui/src/components/RedactedBadge.tsx:13` | `EyeOff`, `span` |
| parallel-primitive | `BuildBadge` in `packages/ui/src/components/shell/BuildBadge.tsx:298` | `X`, `button`, `dd`, `div`, `dl`, `dt`, `span` |
| parallel-primitive | `SpeakerNameAttributionBadge` in `packages/ui/src/components/transcripts/SpeakerNameAttributionBadge.tsx:40` | `span` |

### button

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `AgentButton` in `packages/ui/src/agent-surface/components.tsx:32` | `Button` |
| canonical-wrapper | `ExportButton` in `packages/ui/src/cloud-ui/components/analytics/export-button.tsx:36` | `Button`, `ChevronDown`, `Download`, `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuTrigger`, `Upload` |
| canonical-wrapper | `ElizaConnectButton` in `packages/ui/src/cloud/instances/components/eliza-connect-button.tsx:16` | `BrandButton`, `ExternalLink` |
| canonical-wrapper | `PstnCallButton` in `packages/ui/src/components/composites/chat/pstn-call-button.tsx:77` | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Loader2`, `PhoneCall`, `div`, `p` |
| canonical-wrapper | `SidebarCollapsedActionButton` in `packages/ui/src/components/composites/sidebar/sidebar-collapsed-rail.tsx:77` | `Button` |
| canonical-wrapper | `SidebarItemButton` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:253` | `Button` |
| canonical-wrapper | `DestructiveSecondaryButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:74` | `Button` |
| canonical-wrapper | `CloudActionButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:496` | `Button`, `SettingRowShell` |
| canonical-wrapper | `SettingsActionButton` in `packages/ui/src/components/settings/settings-agent-rows.tsx:576` | `Button` |
| canonical-wrapper | `GlassIconButton` in `packages/ui/src/components/shell/glass-composer.tsx:24` | `Button`, `Icon` |
| canonical-wrapper | `RecoveryActionButton` in `plugins/plugin-task-coordinator/src/orchestrator-task-inspector.tsx:1101` | `Button` |
| parallel-primitive | `BrandButton` in `packages/ui/src/cloud-ui/components/brand/brand-button.tsx:46` | `Comp` |
| parallel-primitive | `LockOnButton` in `packages/ui/src/cloud-ui/components/brand/lock-on-button.tsx:14` | `Component` |
| parallel-primitive | `ViewBackButton` in `packages/ui/src/components/shared/ViewHeader.tsx:44` | `ArrowLeft`, `button`, `span` |
| parallel-primitive | `ActionButton` in `packages/ui/stories/src/lab/lab-ui.tsx:73` | `button` |
| renderer-adapter | `Button` in `packages/ui/src/spatial/primitives.tsx:517` | `UiButton` |
| template-adapter | `InferenceCloudAlertButton` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:14` |  |
| test-double | `Button` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:46` | `button` |
| test-double | `Button` in `plugins/plugin-contacts/test/stubs/ui.tsx:15` |  |
| test-double | `Button` in `plugins/plugin-phone/test/stubs/ui.tsx:13` |  |

### card

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `CostInsightsCard` in `packages/ui/src/cloud-ui/components/analytics/cost-insights-card.tsx:21` | `Badge`, `BrandCard`, `CostAlerts`, `Progress`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | `PromptCard` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:15` | `ArrowUp`, `Button`, `p` |
| canonical-wrapper | `ConnectionCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:369` | `AlertTriangle`, `Button`, `ConnectionLoadingCard`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | `Skeleton`, `div` |
| canonical-wrapper | `EndpointCard` in `packages/ui/src/cloud-ui/components/docs/endpoint-card.tsx:61` | `Button`, `ChevronRight`, `Coins`, `Sparkles`, `code`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | `BuyDomainCard` in `packages/ui/src/cloud/applications/components/BuyDomainCard.tsx:68` | `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogTrigger`, `AlertTriangle`, `Button`, `CheckCircle2`, `CreditCard`, `Input`, `Loader2`, `Search`, `ShoppingCart`, `XCircle`, `div`, `form`, `h3`, `p`, `span` |
| canonical-wrapper | `ActiveComputeCardView` in `packages/ui/src/cloud/billing/components/active-compute-card.tsx:301` | `AlertCircle`, `BrandCard`, `Calculator`, `Clock3`, `LoadingCard`, `RefreshCw`, `ResourceCard`, `RetryButton`, `StatusBadge`, `div`, `h3`, `p`, `span`, `ul` |
| canonical-wrapper | `AutoTopUpCard` in `packages/ui/src/cloud/billing/components/auto-top-up-card.tsx:144` | `AlertCircle`, `BrandCard`, `Button`, `CornerBrackets`, `CreditCard`, `Info`, `Loader2`, `RefreshCw`, `SettingsInputRow`, `SettingsSwitchRow`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | `DirectCryptoCreditCard` in `packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx:179` | `Button`, `Card`, `CardContent`, `CardHeader`, `CardTitle`, `Coins`, `ConnectButton.Custom`, `Link`, `Loader2`, `PaymentWaitingOverlay`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `ShieldCheck`, `Wallet`, `div`, `p`, `span` |
| canonical-wrapper | `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:178` | `Badge`, `Button`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `Spinner`, `StatusBadge`, `Trash2`, `UsageBar`, `div`, `span` |
| canonical-wrapper | `AccountRequiredCard` in `packages/ui/src/components/chat/AccountRequiredCard.tsx:133` | `Button`, `ReconnectProgressLine`, `RefreshCw`, `ShieldAlert`, `Spinner`, `StatusBadge`, `UserRound`, `div`, `span` |
| canonical-wrapper | `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83` | `Button`, `ConnectorBrandIcon`, `Input`, `ShieldCheck`, `div`, `form`, `label`, `span` |
| canonical-wrapper | `HomeWidgetCard` in `packages/ui/src/components/chat/widgets/home-widget-card.tsx:89` | `Button`, `span` |
| canonical-wrapper | `PermissionCard` in `packages/ui/src/components/composites/chat/permission-card.tsx:57` | `Button`, `div`, `h3`, `header`, `p`, `section`, `span` |
| canonical-wrapper | `TrajectoryLlmCallCard` in `packages/ui/src/components/composites/trajectories/trajectory-llm-call-card.tsx:64` | `Button`, `CallMetric`, `ChevronDown`, `ChevronRight`, `PagePanel`, `TrajectoryCodeBlock`, `div`, `span` |
| canonical-wrapper | `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163` | `Badge`, `Button`, `Checkbox`, `ConnectedCapabilityChips`, `ConnectorAccountPrivacySelector`, `ConnectorAccountPurposeSelector`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `RefreshCw`, `Spinner`, `Star`, `StatusBadge`, `Trash2`, `div`, `img`, `span` |
| canonical-wrapper | `ModelCard` in `packages/ui/src/components/local-inference/ModelCard.tsx:55` | `Button`, `DownloadProgress`, `div`, `p`, `span` |
| canonical-wrapper | `PluginCard` in `packages/ui/src/components/pages/PluginCard.tsx:46` | `Button`, `PluginVisual`, `div`, `li`, `p`, `span` |
| canonical-wrapper | `PendantSettingsCard` in `packages/ui/src/components/settings/PendantSettingsCard.tsx:46` | `BatteryBadge`, `Bluetooth`, `Button`, `Loader2`, `Radio`, `SettingsGroup`, `SettingsRow`, `span` |
| canonical-wrapper | `ProviderCard` in `packages/ui/src/components/settings/ProviderCard.tsx:46` | `Button`, `CheckCircle2`, `Icon`, `span` |
| canonical-wrapper | `AppBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/AppBlockerSettingsCard.tsx:110` | `AppBlockerStatusIcon`, `Button`, `CheckCircle2`, `Clock3`, `Input`, `ListChecks`, `Loader2`, `RefreshCw`, `Search`, `ShieldBan`, `Smartphone`, `Square`, `Timer`, `div`, `label`, `span` |
| canonical-wrapper | `WebsiteBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/WebsiteBlockerSettingsCard.tsx:80` | `Button`, `CheckCircle2`, `Monitor`, `Settings`, `ShieldBan`, `div`, `span` |
| canonical-wrapper | `GitHubConnectionCard` in `plugins/plugin-task-coordinator/src/GitHubConnectionCard.tsx:80` | `Button`, `CheckCircle2`, `ExternalLink`, `GitPullRequest`, `LogIn`, `SettingsControls.Input`, `Unplug`, `div`, `p`, `span` |
| canonical-wrapper | `TaskCard` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:238` | `Button`, `GitBranch`, `TaskStatusChip`, `TaskStatusMedallion`, `span` |
| molecular-candidate | `AgentCard` in `packages/ui/src/cloud-ui/components/brand/brand-card.tsx:63` | `BrandCard`, `div`, `h3`, `p` |
| molecular-candidate | `DashboardStatCard` in `packages/ui/src/cloud-ui/components/brand/dashboard-stat-card.tsx:37` | `BrandCard`, `div`, `p` |
| molecular-candidate | `PromptCardGrid` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:40` | `PromptCard`, `div` |
| molecular-candidate | `ConnectionLoadingCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:76` | `Loader2`, `div` |
| molecular-candidate | `DashboardActionCards` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:72` | `ArrowRight`, `BookOpen`, `Bot`, `Code`, `CreditCard`, `KeyRound`, `Link`, `Rocket`, `Server`, `Store`, `Wallet`, `div`, `h3`, `span` |
| molecular-candidate | `DashboardDataListCard` in `packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.tsx:79` | `div` |
| molecular-candidate | `Cards` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:57` | `div` |
| molecular-candidate | `MilestoneCard` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:88` | `MilestoneProgress`, `div`, `h4` |
| molecular-candidate | `AgentCard` in `packages/ui/src/cloud/instances/components/agent-card.tsx:856` |  |
| molecular-candidate | `MessagePermissionCard` in `packages/ui/src/components/chat/MessageContent.tsx:1259` |  |
| molecular-candidate | `MapsCardWidget` in `packages/ui/src/components/chat/widgets/maps-card.tsx:347` | `AttributionLine`, `HandoffCard`, `LocateCard`, `PlaceRow`, `Route`, `a`, `div`, `li`, `span`, `ul` |
| molecular-candidate | `OrchestratorGrillingCard` in `packages/ui/src/components/chat/widgets/orchestrator-grilling-card.tsx:85` | `div`, `li`, `p`, `span`, `ul` |
| molecular-candidate | `SummaryCard` in `packages/ui/src/components/composites/page-panel/page-panel-header.tsx:102` | `div` |
| molecular-candidate | `ProtectionCard` in `packages/ui/src/components/settings/vault-tabs/OverviewTab.tsx:258` | `AlertCircle`, `CheckCircle2`, `div`, `p`, `section` |
| parallel-primitive | `BrandCard` in `packages/ui/src/cloud-ui/components/brand/brand-card.tsx:26` | `Component`, `CornerBrackets` |
| parallel-primitive | `MiniStatCard` in `packages/ui/src/cloud-ui/components/brand/mini-stat-card.tsx:13` | `div`, `p` |
| parallel-primitive | `SurfaceCard` in `packages/ui/src/components/apps/extensions/surface.tsx:49` | `div` |
| renderer-adapter | `Card` in `packages/ui/src/spatial/primitives.tsx:801` | `Stack` |
| template-adapter | `AppBlockerSettingsCard` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:15` |  |
| template-adapter | `WebsiteBlockerSettingsCard` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:16` |  |

### checkbox

No named candidates.

### dialog

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `BulkDeleteDialog` in `packages/ui/src/cloud-ui/components/bulk/bulk-select.tsx:75` | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button` |
| canonical-wrapper | `AccountDeletionDialog` in `packages/ui/src/cloud/account-security/components/account-deletion-dialog.tsx:30` | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button`, `Input`, `a`, `div`, `label`, `p` |
| canonical-wrapper | `WithdrawDialog` in `packages/ui/src/cloud/applications/components/withdraw-dialog.tsx:45` | `AlertCircle`, `ArrowRight`, `Button`, `CheckCircle2`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Loader2`, `Wallet`, `div`, `h3`, `label`, `p`, `span` |
| canonical-wrapper | `McpEditorDialog` in `packages/ui/src/cloud/mcps/McpEditorDialog.tsx:185` | `BrandButton`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Switch`, `Textarea`, `div`, `p` |
| canonical-wrapper | `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:54` | `AlertCircle`, `BrandButton`, `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `KeyRound`, `Label`, `Loader2`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `ShieldCheck`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:64` | `AlertCircle`, `BrandButton`, `Button`, `Copy`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Link2`, `Loader2`, `Mail`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `UserCog`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | `AddAccountDialog` in `packages/ui/src/components/accounts/AddAccountDialog.tsx:180` | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `ProviderPicker`, `Spinner`, `a`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41` | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Sparkles`, `div` |
| canonical-wrapper | `PluginSettingsDialog` in `packages/ui/src/components/pages/plugin-view-dialogs.tsx:68` | `AdminDialog.BodyScroll`, `AdminDialog.Content`, `AdminDialog.Footer`, `AdminDialog.Header`, `AdminDialog.MetaBadge`, `AdminDialog.MonoMeta`, `Button`, `CheckCircle2`, `ConnectorSetupPanel`, `Dialog`, `DialogDescription`, `DialogTitle`, `PluginConfigForm`, `SettingsDialogIcon`, `div`, `span` |
| canonical-wrapper | `CloudConfirmDialog` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:685` | `Button`, `CloudModal`, `div`, `p` |
| parallel-primitive | `PromoteAppDialog` in `packages/ui/src/cloud-ui/components/promotion/promote-app-dialog.tsx:152` | `AlertCircle`, `ArrowLeft`, `ArrowRight`, `Braces`, `Button`, `Check`, `CheckCircle`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `FileText`, `Input`, `Label`, `Loader2`, `Megaphone`, `Search`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Send`, `Share2`, `Textarea`, `div`, `h3`, `p`, `platform.Icon`, `span` |
| parallel-primitive | `ConversationRenameDialog` in `packages/ui/src/components/conversations/ConversationRenameDialog.tsx:21` | `ChatConversationRenameDialog` |

### input

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `PhoneNumberInput` in `packages/homepage/src/components/login/phone-number-input.tsx:109` | `ChevronDown`, `CountryFlag`, `Input`, `div`, `label`, `option`, `select` |
| canonical-wrapper | `AgentInput` in `packages/ui/src/agent-surface/components.tsx:68` | `Input` |
| canonical-wrapper | `TaskSearchInput` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:184` | `Input`, `Search`, `div` |
| parallel-primitive | `CloudInputRow` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:416` | `SettingRowShell`, `input` |
| parallel-primitive | `CloudTextInput` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:753` | `input` |
| parallel-primitive | `AgentInput` in `plugins/plugin-notes/src/views/viewPrimitives.tsx:187` | `input` |
| test-double | `Input` in `plugins/plugin-contacts/test/stubs/ui.tsx:26` |  |

### popover

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `CellPopover` in `packages/ui/src/components/pages/database-utils.tsx:80` | `CodeBlock`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle` |
| test-double | `Popover` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:61` | `div` |
| test-double | `PopoverContent` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:74` | `div` |

### progress

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| parallel-primitive | `MilestoneProgress` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:20` | `CheckCircle2`, `Target`, `div`, `span` |
| parallel-primitive | `NavigationProgress` in `packages/ui/src/cloud-ui/components/navigation-progress.tsx:13` |  |
| parallel-primitive | `DownloadProgress` in `packages/ui/src/components/local-inference/DownloadProgress.tsx:14` | `div`, `span` |

### select

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `ApiParameterSelect` in `packages/ui/src/cloud-ui/components/docs/api-parameter-select.tsx:29` | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` |
| canonical-wrapper | `FilterSelect` in `plugins/plugin-task-coordinator/src/orchestrator-workbench-list.tsx:29` | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `TaskStatusChip`, `span` |

### separator

No named candidates.

### skeleton

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | `Skeleton`, `div` |
| canonical-wrapper | `DashboardTableSkeleton` in `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx:29` | `Skeleton`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `div` |
| parallel-primitive | `MonacoEditorSkeleton` in `packages/ui/src/cloud-ui/components/code/monaco-editor-skeleton.tsx:14` | `Loader2`, `div`, `span` |
| parallel-primitive | `AppsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:218` | `DashboardTableSkeleton` |
| parallel-primitive | `ContainersSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:237` | `DashboardTableSkeleton` |
| parallel-primitive | `LoginOptionsSkeleton` in `packages/ui/src/cloud/public-pages/pages/login/login-section-skeleton.tsx:39` | `GhostRow`, `div` |
| parallel-primitive | `ViewLoadingSkeleton` in `packages/ui/src/components/views/ViewStatusStates.tsx:82` | `LoaderCircle`, `ViewStatusFrame` |

### spinner

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| test-double | `Spinner` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:57` | `span` |

### switch

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `ConnectorChannelModeSwitch` in `packages/ui/src/components/connectors/ConnectorChannelModeSwitch.tsx:40` | `SegmentedControl`, `span` |

### table

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `ApiKeysTable` in `packages/ui/src/cloud-ui/components/data-list/api-keys-table.tsx:83` | `DashboardDataListDesktop`, `DashboardDataListMobile`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `div`, `p`, `span` |
| canonical-wrapper | `ElizaAgentsTable` in `packages/ui/src/cloud/instances/components/eliza-agents-table.tsx:334` | `AgentCostBadge`, `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `ArrowUpDown`, `BulkDeleteDialog`, `BulkSelectionBar`, `Button`, `Checkbox`, `DashboardDataList`, `DashboardDataListDesktop`, `DashboardDataListFilteredCount`, `DashboardDataListMobile`, `DataListEmptyState`, `ExternalLink`, `Input`, `Moon`, `Pause`, `Play`, `Search`, `StatusCell`, `Sun`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger`, `Trash2`, `a`, `div`, `p`, `span` |
| canonical-wrapper | `AccountCommandTable` in `packages/ui/src/components/accounts/AccountCommandTable.tsx:224` | `Button`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `HealthCell`, `KeyRound`, `RotateCw`, `SortHeader`, `Spinner`, `Trash2`, `UsageBar`, `button`, `div`, `input`, `span`, `table`, `tbody`, `td`, `th`, `thead`, `tr` |
| parallel-primitive | `AppsTable` in `packages/ui/src/cloud/applications/components/apps-table.tsx:31` | `AppsListView`, `BulkDeleteDialog`, `BulkSelectionBar`, `Link`, `span` |

### tabs

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| canonical-wrapper | `BrandTabsResponsive` in `packages/ui/src/cloud-ui/components/brand/brand-tabs-responsive.tsx:53` | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `TabsPrimitive.List`, `TabsPrimitive.Root`, `TabsPrimitive.Trigger`, `div`, `span` |
| canonical-wrapper | `SimpleBrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:67` | `Button`, `div` |
| canonical-wrapper | `Tabs` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:70` | `TabsContent`, `TabsList`, `TabsTrigger`, `UiTabs`, `div` |
| canonical-wrapper | `AppDetailsTabs` in `packages/ui/src/cloud/applications/components/app-details-tabs.tsx:49` | `AppAnalytics`, `AppDomains`, `AppEarningsDashboard`, `AppFrontendHosting`, `AppMonetizationSettings`, `AppOverview`, `AppPromote`, `AppSettings`, `AppUsers`, `Button`, `Icon`, `div`, `span` |
| canonical-wrapper | `BrowserTabSwitcher` in `packages/ui/src/components/pages/BrowserTabSwitcher.tsx:274` | `BrowserTabCard`, `Button`, `Dialog`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Plus`, `X`, `div`, `h3`, `p`, `section`, `span` |
| canonical-wrapper | `AgentTabsSection` in `plugins/plugin-task-coordinator/src/AgentTabsSection.tsx:38` | `Button`, `ExternalLink`, `InstallStateIcon`, `KeyRound`, `Loader2`, `RotateCw`, `SettingsControls.MutedText`, `SettingsControls.SegmentedGroup`, `a`, `div`, `span` |
| parallel-primitive | `BrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:13` |  |
| test-double | `Tabs` in `plugins/plugin-phone/test/stubs/ui-tabs.tsx:25` |  |

### textarea

| Classification | Definition | Rendered tags |
| --- | --- | --- |
| parallel-primitive | `AgentTextarea` in `plugins/plugin-notes/src/views/viewPrimitives.tsx:225` | `textarea` |

### tooltip

No named candidates.

