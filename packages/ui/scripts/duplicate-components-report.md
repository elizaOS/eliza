# Atomic component duplicate inventory

Scanned 898 maintained React source files across packages and plugins.

This is a candidate inventory, not an instruction to merge every entry. Canonical wrappers, renderer adapters, and test doubles remain separate because they often have legitimate ownership.

| Atom | Canonical | Same-name | Wrappers | Parallel primitives | Raw host files |
| --- | ---: | ---: | ---: | ---: | ---: |
| alert | 5 | 0 | 0 | 1 | 0 |
| alertDialog | 1 | 0 | 0 | 0 | 0 |
| attachment | 5 | 0 | 1 | 5 | 0 |
| avatar | 2 | 0 | 0 | 0 | 0 |
| badge | 3 | 0 | 12 | 2 | 0 |
| button | 8 | 0 | 15 | 0 | 6 |
| banner | 1 | 0 | 3 | 1 | 0 |
| card | 7 | 0 | 29 | 2 | 0 |
| checkbox | 1 | 0 | 0 | 0 | 0 |
| codeBlock | 1 | 0 | 1 | 0 | 0 |
| cornerBrackets | 1 | 0 | 0 | 0 | 0 |
| statusDot | 1 | 0 | 0 | 0 | 0 |
| statusPulseDot | 1 | 0 | 0 | 0 | 0 |
| dialog | 11 | 0 | 10 | 2 | 1 |
| dropdownMenu | 1 | 0 | 0 | 0 | 0 |
| input | 4 | 0 | 3 | 0 | 2 |
| marker | 3 | 0 | 0 | 0 | 0 |
| popover | 1 | 0 | 1 | 0 | 0 |
| progress | 1 | 0 | 2 | 1 | 0 |
| radioGroup | 2 | 0 | 0 | 0 | 0 |
| scrollArea | 1 | 0 | 0 | 0 | 0 |
| select | 3 | 0 | 2 | 0 | 1 |
| separator | 3 | 0 | 0 | 0 | 2 |
| skeleton | 5 | 0 | 3 | 5 | 0 |
| slider | 1 | 0 | 1 | 0 | 0 |
| spinner | 1 | 0 | 0 | 0 | 0 |
| switch | 2 | 0 | 1 | 0 | 0 |
| table | 1 | 0 | 3 | 1 | 1 |
| tabs | 1 | 0 | 6 | 1 | 0 |
| textarea | 3 | 0 | 0 | 0 | 2 |
| tooltip | 4 | 0 | 0 | 0 | 0 |

## Raw semantic host usage

Raw host elements are reported only where HTML provides a meaningful atomic signal. Generic `div` and `span` usage is deliberately excluded.

### Raw button hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/admin-dialog.tsx` | 133 |
| canonical-implementation | `packages/ui/src/components/ui/confirm-delete.tsx` | 46, 68, 82 |
| canonical-implementation | `packages/ui/src/components/ui/switch.tsx` | 61 |
| test-or-story-harness | `packages/ui/stories/src/lab/DesignLab.tsx` | 105, 120 |
| test-or-story-harness | `packages/ui/stories/src/lab/surfaces/WidgetsLab.tsx` | 61 |
| test-or-story-harness | `packages/ui/stories/src/voice-main.tsx` | 786, 809 |

### Raw dialog hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/native-dialog.tsx` | 13 |

### Raw input hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/input-group.tsx` | 101 |
| canonical-implementation | `packages/ui/src/components/ui/input.tsx` | 122 |

### Raw select hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/native-select.tsx` | 32 |

### Raw separator hosts

| Classification | File | Lines |
| --- | --- | --- |
| ui-raw-host | `packages/ui/src/components/chat/TasksEventsPanel.tsx` | 267 |
| ui-raw-host | `packages/ui/src/genui/renderer.tsx` | 329 |

### Raw table hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/table.tsx` | 35 |

### Raw textarea hosts

| Classification | File | Lines |
| --- | --- | --- |
| canonical-implementation | `packages/ui/src/components/ui/input-group.tsx` | 118 |
| canonical-implementation | `packages/ui/src/components/ui/textarea.tsx` | 69 |


## Named candidates by atom

### alert

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| parallel-primitive | molecular | `CostAlerts` in `packages/ui/src/cloud-ui/components/analytics/cost-alerts.tsx:16` | - | `AlertTriangle`, `Info`, `TrendingDown`, `div`, `p` |
|  |  | Analytics alert collection, not an Alert primitive. |  |  |

### alertDialog

No named candidates.

### attachment

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `MessageAttachments` in `packages/ui/src/components/chat/MessageAttachments.tsx:1053` | - | `Attachment`, `AttachmentContent`, `AttachmentTitle`, `CodeTile`, `FileTile`, `ImageTile`, `Lightbox`, `Model3dTile`, `NotProcessedNotice`, `PdfTile`, `RedactedBadge`, `TranscriptTile`, `TranscriptViewerOverlay`, `UnsafeAttachmentTile`, `audio`, `div`, `track`, `video` |
| parallel-primitive | molecular | `LandingDemoAttachment` in `packages/homepage/src/components/landing-demo-attachment.tsx:20` | - | `LandingHandoffAttachment`, `LandingItineraryAttachment`, `LandingPlaceAttachment`, `LandingTaskListAttachment` |
|  |  | Typed dispatcher for homepage demo artifacts, not an Attachment primitive. |  |  |
| parallel-primitive | intentional-specialization | `LandingHandoffAttachment` in `packages/homepage/src/components/landing-handoff-attachment.tsx:4` | - | `CalendarDays`, `article`, `div`, `header`, `small`, `span`, `strong` |
|  |  | Homepage calendar illustration with domain-specific event geometry, not a file Attachment control. |  |  |
| parallel-primitive | intentional-specialization | `LandingItineraryAttachment` in `packages/homepage/src/components/landing-itinerary-attachment.tsx:6` | - | `Route`, `StopIcon`, `article`, `header`, `li`, `ol`, `span`, `strong` |
|  |  | Homepage itinerary illustration with ordered travel stops, not a file Attachment control. |  |  |
| parallel-primitive | intentional-specialization | `LandingPlaceAttachment` in `packages/homepage/src/components/landing-place-attachment.tsx:4` | - | `Navigation`, `Star`, `article`, `circle`, `div`, `g`, `path`, `span`, `strong`, `svg` |
|  |  | Homepage map illustration with place metadata, not a file Attachment control. |  |  |
| parallel-primitive | intentional-specialization | `LandingTaskListAttachment` in `packages/homepage/src/components/landing-task-list-attachment.tsx:4` | - | `Check`, `ListChecks`, `article`, `b`, `header`, `li`, `small`, `span`, `strong`, `ul` |
|  |  | Homepage task-list illustration with completion state, not a file Attachment control. |  |  |

### avatar

No named candidates.

### badge

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ConnectionConnectedBadge` in `packages/ui/src/cloud-ui/components/connection-card.tsx:117` | - | `Badge`, `CheckCircle` |
| canonical-wrapper | not-reviewed | `VoiceStatusBadge` in `packages/ui/src/cloud-ui/components/voice/voice-status-badge.tsx:20` | - | `AlertCircle`, `CheckCircle2`, `Clock`, `Loader2`, `StatusBadge` |
| canonical-wrapper | not-reviewed | `ApprovalStatusBadge` in `packages/ui/src/cloud/approvals/components/status-badge.tsx:54` | - | `SharedStatusBadge` |
| canonical-wrapper | not-reviewed | `AgentCostBadge` in `packages/ui/src/cloud/instances/components/agent-cost-badge.tsx:30` | - | `Tooltip`, `TooltipContent`, `TooltipTrigger`, `p`, `span` |
| canonical-wrapper | not-reviewed | `McpStatusBadge` in `packages/ui/src/cloud/mcps/McpDetailDrawer.tsx:452` | - | `StatusBadge` |
| canonical-wrapper | not-reviewed | `CloudStatusBadge` in `packages/ui/src/components/cloud/CloudStatusBadge.tsx:126` | - | `Button`, `span` |
| canonical-wrapper | intentional-specialization | `ChatVoiceSpeakerBadge` in `packages/ui/src/components/composites/chat/chat-source.tsx:63` | `packages/ui/src/components/ui/badge.tsx` | `Badge`, `Crown`, `Mic`, `span` |
|  |  | Role and voice icon marker has domain behavior, but should continue to source base badge tokens from the canonical owner. |  |  |
| canonical-wrapper | intentional-specialization | `OwnerBadge` in `packages/ui/src/components/composites/OwnerBadge.tsx:53` | `packages/ui/src/components/ui/badge.tsx` | `Badge`, `Crown`, `span` |
|  |  | Placement-aware owner marker is shared domain UI rather than a second general badge. |  |  |
| canonical-wrapper | intentional-specialization | `RedactedBadge` in `packages/ui/src/components/RedactedBadge.tsx:14` | `packages/ui/src/components/ui/badge.tsx` | `Badge`, `EyeOff` |
|  |  | Redaction semantics stay local while presentation composes the canonical Badge. |  |  |
| canonical-wrapper | not-reviewed | `PermissionStatusBadge` in `packages/ui/src/components/settings/cloud-panel/sections/permission-status-badge.tsx:10` | - | `StatusBadge` |
| canonical-wrapper | molecular | `BuildBadge` in `packages/ui/src/components/shell/BuildBadge.tsx:299` | - | `Button`, `X`, `dd`, `div`, `dl`, `dt`, `span` |
|  |  | Interactive build-details control and popover, not an atomic badge. |  |  |
| canonical-wrapper | intentional-specialization | `SpeakerNameAttributionBadge` in `packages/ui/src/components/transcripts/SpeakerNameAttributionBadge.tsx:40` | `packages/ui/src/components/ui/status-badge.tsx` | `StatusBadge`, `span` |
|  |  | Speaker attribution maps transcript state into the canonical StatusBadge. |  |  |
| parallel-primitive | molecular | `LlmsTxtBadge` in `packages/ui/src/cloud-ui/components/docs/llms-txt-badge.tsx:28` | `packages/ui/src/components/ui/badge.tsx` | `DocsBadgeLink`, `div` |
|  |  | Docs-route link group now composes Badge with asChild; it no longer owns badge chrome. |  |  |
| parallel-primitive | molecular | `HardwareBadge` in `packages/ui/src/components/local-inference/HardwareBadge.tsx:16` | - | `AlertTriangle`, `Cpu`, `Gauge`, `HardDrive`, `div`, `span` |
|  |  | Multi-field hardware summary made of several status regions. |  |  |

### button

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `AgentButton` in `packages/ui/src/agent-surface/components.tsx:32` | - | `Button` |
| canonical-wrapper | not-reviewed | `ExportButton` in `packages/ui/src/cloud-ui/components/analytics/export-button.tsx:36` | - | `Button`, `ChevronDown`, `Download`, `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuTrigger`, `Upload` |
| canonical-wrapper | not-reviewed | `ElizaConnectButton` in `packages/ui/src/cloud/instances/components/eliza-connect-button.tsx:16` | - | `Button`, `ExternalLink` |
| canonical-wrapper | not-reviewed | `PstnCallButton` in `packages/ui/src/components/composites/chat/pstn-call-button.tsx:77` | - | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Loader2`, `PhoneCall`, `div`, `p` |
| canonical-wrapper | not-reviewed | `SidebarCollapsedActionButton` in `packages/ui/src/components/composites/sidebar/sidebar-collapsed-rail.tsx:75` | - | `Button` |
| canonical-wrapper | not-reviewed | `SidebarItemButton` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:276` | - | `Button`, `Card` |
| canonical-wrapper | not-reviewed | `DestructiveSecondaryButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:82` | - | `Button` |
| canonical-wrapper | not-reviewed | `CloudActionButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:465` | - | `Button`, `SettingsRow` |
| canonical-wrapper | not-reviewed | `SettingsActionButton` in `packages/ui/src/components/settings/settings-agent-rows.tsx:569` | - | `Button` |
| canonical-wrapper | intentional-specialization | `ViewBackButton` in `packages/ui/src/components/shared/ViewHeader.tsx:45` | `packages/ui/src/components/ui/button.tsx` | `ArrowLeft`, `Button` |
|  |  | Agent instrumentation stays local while the control composes the canonical Button. |  |  |
| canonical-wrapper | not-reviewed | `SoftButton` in `packages/ui/src/components/shell/ChatOverlay.tsx:507` | - | `Button`, `Glyph`, `Icon` |
| canonical-wrapper | not-reviewed | `GlassIconButton` in `packages/ui/src/components/shell/glass-composer.tsx:23` | - | `Button`, `Icon` |
| canonical-wrapper | not-reviewed | `NotificationStackClearButton` in `packages/ui/src/components/shell/NotificationsHomeCenter.tsx:664` | - | `Button`, `ClearConfirmationContent` |
| canonical-wrapper | lab-only | `ActionButton` in `packages/ui/stories/src/lab/lab-ui.tsx:70` | `packages/ui/src/components/ui/button.tsx` | `Button` |
|  |  | Design-lab fixture is not shipped product UI. |  |  |
| canonical-wrapper | not-reviewed | `RecoveryActionButton` in `plugins/plugin-task-coordinator/src/orchestrator-task-inspector.tsx:1102` | - | `Button` |
| renderer-adapter | not-reviewed | `Button` in `packages/ui/src/spatial/primitives.tsx:578` | - | `UiButton` |

### banner

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ElizaAgentPricingBanner` in `packages/ui/src/cloud/instances/components/eliza-agent-pricing-banner.tsx:30` | - | `Card`, `Clock`, `CornerBrackets`, `DollarSign`, `StatusBadge`, `TrendingDown`, `Zap`, `div`, `p` |
| canonical-wrapper | not-reviewed | `RestartBanner` in `packages/ui/src/components/shell/RestartBanner.tsx:14` | - | `Button`, `div`, `span` |
| canonical-wrapper | not-reviewed | `SystemWarningBanner` in `packages/ui/src/components/shell/SystemWarningBanner.tsx:19` | - | `Button`, `div`, `span` |
| parallel-primitive | molecular | `VoiceTierBanner` in `packages/ui/src/components/settings/VoiceTierBanner.tsx:67` | - | `Icon`, `div`, `p`, `span` |
|  |  | Device capability summary with tier-specific content and iconography, not a notification Banner primitive. |  |  |

### card

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `CostInsightsCard` in `packages/ui/src/cloud-ui/components/analytics/cost-insights-card.tsx:21` | - | `Badge`, `Card`, `CostAlerts`, `Progress`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AgentCard` in `packages/ui/src/cloud-ui/components/brand/agent-card.tsx:18` | - | `Card`, `CornerBrackets`, `div`, `h3`, `p` |
| canonical-wrapper | not-reviewed | `DashboardStatCard` in `packages/ui/src/cloud-ui/components/brand/dashboard-stat-card.tsx:51` | - | `Badge`, `Card`, `div`, `p` |
| canonical-wrapper | not-reviewed | `KeyMetricCard` in `packages/ui/src/cloud-ui/components/brand/key-metrics-grid.tsx:40` | - | `Card` |
| canonical-wrapper | not-reviewed | `PromptCard` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:15` | - | `ArrowUp`, `Button`, `p` |
| canonical-wrapper | not-reviewed | `ConnectionLoadingCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:101` | - | `Card`, `SettingsRow`, `Skeleton` |
| canonical-wrapper | not-reviewed | `ConnectionCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:477` | - | `Button`, `Card`, `ChevronDown`, `SettingsRow`, `Skeleton`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | - | `Skeleton`, `div` |
| canonical-wrapper | not-reviewed | `EndpointCard` in `packages/ui/src/cloud-ui/components/docs/endpoint-card.tsx:61` | - | `Button`, `ChevronRight`, `Coins`, `Sparkles`, `code`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `BuyDomainCard` in `packages/ui/src/cloud/applications/components/BuyDomainCard.tsx:69` | - | `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogTrigger`, `AlertTriangle`, `Button`, `Card`, `CheckCircle2`, `CreditCard`, `Input`, `Loader2`, `Search`, `ShoppingCart`, `XCircle`, `div`, `form`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ActiveComputeCardView` in `packages/ui/src/cloud/billing/components/active-compute-card.tsx:676` | - | `AlertCircle`, `Calculator`, `Card`, `Clock3`, `CornerBrackets`, `LoadingCard`, `RefreshCw`, `ResourceCard`, `RetryButton`, `StatusBadge`, `div`, `h3`, `p`, `span`, `ul` |
| canonical-wrapper | not-reviewed | `AutoTopUpCard` in `packages/ui/src/cloud/billing/components/auto-top-up-card.tsx:147` | - | `Alert`, `AlertCircle`, `Badge`, `Button`, `Card`, `CornerBrackets`, `CreditCard`, `Info`, `Loader2`, `RefreshCw`, `SettingsInputRow`, `SettingsSwitchRow`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `DirectCryptoCreditCard` in `packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx:179` | - | `Button`, `Card`, `CardContent`, `CardHeader`, `CardTitle`, `Coins`, `ConnectButton.Custom`, `Link`, `Loader2`, `PaymentWaitingOverlay`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `ShieldCheck`, `Wallet`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:174` | - | `Badge`, `Button`, `Card`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `Spinner`, `StatusBadge`, `Trash2`, `UsageBar`, `div`, `span` |
| canonical-wrapper | not-reviewed | `AccountRequiredCard` in `packages/ui/src/components/chat/AccountRequiredCard.tsx:133` | - | `Button`, `ReconnectProgressLine`, `RefreshCw`, `ShieldAlert`, `Spinner`, `StatusBadge`, `UserRound`, `div`, `span` |
| canonical-wrapper | not-reviewed | `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83` | - | `Button`, `ConnectorBrandIcon`, `Input`, `ShieldCheck`, `div`, `form`, `label`, `span` |
| canonical-wrapper | not-reviewed | `HomeWidgetCard` in `packages/ui/src/components/chat/widgets/home-widget-card.tsx:81` | - | `Badge`, `Button`, `StatusDot`, `span` |
| canonical-wrapper | not-reviewed | `PermissionCard` in `packages/ui/src/components/composites/chat/permission-card.tsx:59` | - | `Badge`, `Button`, `Card`, `div`, `h3`, `header`, `p` |
| canonical-wrapper | not-reviewed | `TrajectoryLlmCallCard` in `packages/ui/src/components/composites/trajectories/trajectory-llm-call-card.tsx:67` | - | `Badge`, `Button`, `CallMetric`, `ChevronDown`, `ChevronRight`, `PagePanel`, `TrajectoryCodeBlock`, `div` |
| canonical-wrapper | not-reviewed | `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163` | - | `Badge`, `Button`, `Card`, `Checkbox`, `ConnectedCapabilityChips`, `ConnectorAccountPrivacySelector`, `ConnectorAccountPurposeSelector`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `RefreshCw`, `Spinner`, `Star`, `StatusBadge`, `Trash2`, `div`, `img`, `span` |
| canonical-wrapper | not-reviewed | `ModelCard` in `packages/ui/src/components/local-inference/ModelCard.tsx:56` | - | `Button`, `Card`, `DownloadProgress`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `PluginCard` in `packages/ui/src/components/pages/PluginCard.tsx:48` | - | `Badge`, `Button`, `PluginVisual`, `Switch`, `div`, `li`, `p`, `span` |
| canonical-wrapper | not-reviewed | `PendantSettingsCard` in `packages/ui/src/components/settings/PendantSettingsCard.tsx:46` | - | `BatteryBadge`, `Bluetooth`, `Button`, `Loader2`, `Radio`, `SettingsGroup`, `SettingsRow`, `span` |
| canonical-wrapper | not-reviewed | `ProviderCard` in `packages/ui/src/components/settings/ProviderCard.tsx:46` | - | `Button`, `CheckCircle2`, `Icon`, `span` |
| canonical-wrapper | not-reviewed | `ProtectionCard` in `packages/ui/src/components/settings/vault-tabs/OverviewTab.tsx:281` | - | `AlertCircle`, `Card`, `CheckCircle2`, `div`, `p`, `section` |
| canonical-wrapper | not-reviewed | `AppBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/AppBlockerSettingsCard.tsx:110` | - | `AppBlockerStatusIcon`, `Button`, `CheckCircle2`, `Checkbox`, `Clock3`, `Input`, `ListChecks`, `Loader2`, `RefreshCw`, `Search`, `ShieldBan`, `Smartphone`, `Square`, `Timer`, `div`, `label`, `span` |
| canonical-wrapper | not-reviewed | `WebsiteBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/WebsiteBlockerSettingsCard.tsx:80` | - | `Button`, `CheckCircle2`, `Monitor`, `Settings`, `ShieldBan`, `div`, `span` |
| canonical-wrapper | not-reviewed | `GitHubConnectionCard` in `plugins/plugin-task-coordinator/src/GitHubConnectionCard.tsx:80` | - | `Button`, `CheckCircle2`, `ExternalLink`, `GitPullRequest`, `LogIn`, `SettingsControls.Input`, `Unplug`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `TaskCard` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:239` | - | `Button`, `GitBranch`, `TaskStatusChip`, `TaskStatusMedallion`, `span` |
| molecular-candidate | not-reviewed | `PromptCardGrid` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:39` | - | `PromptCard`, `div` |
| molecular-candidate | not-reviewed | `DashboardActionCards` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:72` | - | `ArrowRight`, `BookOpen`, `Bot`, `Code`, `CreditCard`, `KeyRound`, `Link`, `Rocket`, `Server`, `Store`, `Wallet`, `div`, `h3`, `span` |
| molecular-candidate | not-reviewed | `DashboardDataListCard` in `packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.tsx:84` | - | `div` |
| molecular-candidate | not-reviewed | `Cards` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:57` | - | `div` |
| molecular-candidate | not-reviewed | `MilestoneCard` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:82` | - | `MilestoneProgress`, `div`, `h4` |
| molecular-candidate | not-reviewed | `AgentCard` in `packages/ui/src/cloud/instances/components/agent-card.tsx:852` | - |  |
| molecular-candidate | not-reviewed | `MessagePermissionCard` in `packages/ui/src/components/chat/MessageContent.tsx:1270` | - |  |
| molecular-candidate | not-reviewed | `MapsCardWidget` in `packages/ui/src/components/chat/widgets/maps-card.tsx:344` | - | `AttributionLine`, `HandoffCard`, `LocateCard`, `PlaceRow`, `Route`, `a`, `div`, `li`, `span`, `ul` |
| molecular-candidate | not-reviewed | `OrchestratorGrillingCard` in `packages/ui/src/components/chat/widgets/orchestrator-grilling-card.tsx:85` | - | `div`, `li`, `p`, `span`, `ul` |
| molecular-candidate | not-reviewed | `SummaryCard` in `packages/ui/src/components/composites/page-panel/page-panel-header.tsx:104` | - | `div` |
| molecular-candidate | not-reviewed | `AppBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/ui.ts:24` | - |  |
| molecular-candidate | not-reviewed | `WebsiteBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/ui.ts:28` | - |  |
| parallel-primitive | molecular | `MiniStatCard` in `packages/ui/src/cloud-ui/components/brand/mini-stat-card.tsx:13` | `packages/ui/src/components/ui/card.tsx` | `div`, `p` |
|  |  | Metric composition, not a base card primitive. |  |  |
| parallel-primitive | false-positive | `SurfaceCard` in `packages/ui/src/components/apps/extensions/surface.tsx:33` | - | `div` |
|  |  | Compact label-value definition block; the Card suffix does not represent card chrome. |  |  |
| renderer-adapter | not-reviewed | `Card` in `packages/ui/src/spatial/primitives.tsx:839` | - | `Stack` |

### checkbox

No named candidates.

### codeBlock

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `TrajectoryCodeBlock` in `packages/ui/src/components/composites/trajectories/trajectory-code-block.tsx:23` | - | `Button`, `CodeBlock`, `PagePanel`, `PagePanel.ActionRail`, `PagePanel.Header` |

### cornerBrackets

No named candidates.

### statusDot

No named candidates.

### statusPulseDot

No named candidates.

### dialog

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `BulkDeleteDialog` in `packages/ui/src/cloud-ui/components/bulk/bulk-select.tsx:81` | - | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button` |
| canonical-wrapper | not-reviewed | `AccountDeletionDialog` in `packages/ui/src/cloud/account-security/components/account-deletion-dialog.tsx:22` | - | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button`, `Input`, `TextLink`, `label`, `p` |
| canonical-wrapper | not-reviewed | `WithdrawDialog` in `packages/ui/src/cloud/applications/components/withdraw-dialog.tsx:46` | - | `AlertCircle`, `ArrowRight`, `Button`, `Card`, `CheckCircle2`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Loader2`, `Wallet`, `div`, `h3`, `label`, `p`, `span` |
| canonical-wrapper | not-reviewed | `McpEditorDialog` in `packages/ui/src/cloud/mcps/McpEditorDialog.tsx:186` | - | `Button`, `Card`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Switch`, `Textarea`, `div`, `p` |
| canonical-wrapper | not-reviewed | `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:56` | - | `Alert`, `AlertCircle`, `Button`, `Card`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `KeyRound`, `Label`, `Loader2`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `SemanticForm`, `ShieldCheck`, `code`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:66` | - | `Alert`, `AlertCircle`, `Button`, `Card`, `Copy`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Link2`, `Loader2`, `Mail`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `SemanticForm`, `UserCog`, `code`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AddAccountDialog` in `packages/ui/src/components/accounts/AddAccountDialog.tsx:183` | - | `Alert`, `AlertDescription`, `Button`, `Card`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `ProviderPicker`, `SemanticForm`, `Spinner`, `TextLink`, `code`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41` | - | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Sparkles`, `div` |
| canonical-wrapper | not-reviewed | `PluginSettingsDialog` in `packages/ui/src/components/pages/plugin-view-dialogs.tsx:72` | - | `AdminDialog.BodyScroll`, `AdminDialog.Content`, `AdminDialog.Footer`, `AdminDialog.Header`, `AdminDialog.MetaBadge`, `AdminDialog.MonoMeta`, `Badge`, `Button`, `CheckCircle2`, `ConnectorSetupPanel`, `Dialog`, `DialogDescription`, `DialogTitle`, `PluginConfigForm`, `SettingsDialogIcon`, `div`, `span` |
| canonical-wrapper | not-reviewed | `CloudConfirmDialog` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:659` | - | `Button`, `CloudModal`, `div`, `p` |
| parallel-primitive | molecular | `PromoteAppDialog` in `packages/ui/src/cloud-ui/components/promotion/promote-app-dialog.tsx:152` | `packages/ui/src/components/ui/dialog.tsx` | `AlertCircle`, `ArrowLeft`, `ArrowRight`, `Braces`, `Button`, `Check`, `CheckCircle`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `FileText`, `Input`, `Label`, `Loader2`, `Megaphone`, `Search`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Send`, `Share2`, `Textarea`, `div`, `h3`, `p`, `platform.Icon`, `span` |
|  |  | Multi-step workflow already composes the canonical Dialog family. |  |  |
| parallel-primitive | intentional-specialization | `ConversationRenameDialog` in `packages/ui/src/components/conversations/ConversationRenameDialog.tsx:21` | `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx` | `ChatConversationRenameDialog` |
|  |  | Compatibility adapter around the shared conversation rename composition. |  |  |

### dropdownMenu

No named candidates.

### input

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `PhoneNumberInput` in `packages/homepage/src/components/login/phone-number-input.tsx:98` | - | `ChevronDown`, `CountryFlag`, `Input`, `NativeSelect`, `div`, `label`, `option` |
| canonical-wrapper | not-reviewed | `AgentInput` in `packages/ui/src/agent-surface/components.tsx:68` | - | `Input` |
| canonical-wrapper | not-reviewed | `TaskSearchInput` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:182` | - | `Card`, `Input`, `Search` |

### marker

No named candidates.

### popover

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `CellPopover` in `packages/ui/src/components/pages/database-utils.tsx:89` | - | `CodeBlock`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle` |

### progress

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | molecular | `MilestoneProgress` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:21` | `packages/ui/src/components/ui/progress.tsx` | `CheckCircle2`, `Progress`, `Target`, `div`, `span` |
|  |  | Milestone state composition, not a generic progress primitive. |  |  |
| canonical-wrapper | intentional-specialization | `DownloadProgress` in `packages/ui/src/components/local-inference/DownloadProgress.tsx:15` | `packages/ui/src/components/ui/progress.tsx` | `Progress`, `div`, `span` |
|  |  | Download state and labels stay local while the meter composes canonical Progress. |  |  |
| parallel-primitive | intentional-specialization | `NavigationProgress` in `packages/ui/src/cloud-ui/components/navigation-progress.tsx:13` | - |  |
|  |  | Route lifecycle adapter around nprogress, not an inline progress control. |  |  |

### radioGroup

No named candidates.

### scrollArea

No named candidates.

### select

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ApiParameterSelect` in `packages/ui/src/cloud-ui/components/docs/api-parameter-select.tsx:29` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` |
| canonical-wrapper | not-reviewed | `FilterSelect` in `plugins/plugin-task-coordinator/src/orchestrator-workbench-list.tsx:24` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `TaskStatusChip`, `span` |

### separator

No named candidates.

### skeleton

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | - | `Skeleton`, `div` |
| canonical-wrapper | not-reviewed | `DashboardTableSkeleton` in `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx:30` | - | `Card`, `Skeleton`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow` |
| canonical-wrapper | not-reviewed | `LauncherAppIconSkeleton` in `packages/ui/src/components/views/LauncherAppIcon.tsx:91` | - | `Card`, `div` |
| parallel-primitive | molecular | `MonacoEditorSkeleton` in `packages/ui/src/cloud-ui/components/code/monaco-editor-skeleton.tsx:14` | `packages/ui/src/components/ui/skeleton.tsx` | `Loader2`, `div`, `span` |
|  |  | Editor loading composition with label and spinner. |  |  |
| parallel-primitive | intentional-specialization | `AppsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:218` | `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx` | `DashboardTableSkeleton` |
|  |  | Named preset around the shared dashboard table skeleton. |  |  |
| parallel-primitive | intentional-specialization | `ContainersSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:237` | `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx` | `DashboardTableSkeleton` |
|  |  | Named preset around the shared dashboard table skeleton. |  |  |
| parallel-primitive | molecular | `LoginOptionsSkeleton` in `packages/ui/src/cloud/public-pages/pages/login/login-section-skeleton.tsx:38` | `packages/ui/src/components/ui/skeleton.tsx` | `GhostRow`, `div` |
|  |  | Full login-options loading composition. |  |  |
| parallel-primitive | false-positive | `ViewLoadingSkeleton` in `packages/ui/src/components/views/ViewStatusStates.tsx:98` | - | `LoaderCircle`, `ViewStatusFrame` |
|  |  | Loading status frame uses a spinner and contains no skeleton primitive. |  |  |

### slider

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `CloudSliderRow` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:309` | - | `SettingsRow`, `Slider`, `div`, `span` |

### spinner

No named candidates.

### switch

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ConnectorChannelModeSwitch` in `packages/ui/src/components/connectors/ConnectorChannelModeSwitch.tsx:40` | - | `SegmentedControl`, `span` |

### table

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ApiKeysTable` in `packages/ui/src/cloud-ui/components/data-list/api-keys-table.tsx:81` | - | `Card`, `DashboardDataListDesktop`, `DashboardDataListMobile`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ElizaAgentsTable` in `packages/ui/src/cloud/instances/components/eliza-agents-table.tsx:346` | - | `AgentCostBadge`, `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `ArrowUpDown`, `BulkDeleteDialog`, `BulkSelectionBar`, `Button`, `Checkbox`, `DashboardDataList`, `DashboardDataListDesktop`, `DashboardDataListFilteredCount`, `DashboardDataListMobile`, `DataListEmptyState`, `ExternalLink`, `Input`, `Moon`, `Pause`, `Play`, `Search`, `StatusCell`, `Sun`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger`, `Trash2`, `a`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AccountCommandTable` in `packages/ui/src/components/accounts/AccountCommandTable.tsx:232` | - | `Button`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `HealthCell`, `Input`, `KeyRound`, `RotateCw`, `SortHeader`, `Spinner`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `Trash2`, `UsageBar`, `div`, `span` |
| parallel-primitive | molecular | `AppsTable` in `packages/ui/src/cloud/applications/components/apps-table.tsx:31` | `packages/ui/src/cloud-ui/components/data-list/apps-list-view.tsx` | `AppsListView`, `BulkDeleteDialog`, `BulkSelectionBar`, `Link`, `span` |
|  |  | Application list composition, not a table primitive implementation. |  |  |

### tabs

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `BrandTabsResponsive` in `packages/ui/src/cloud-ui/components/brand/brand-tabs-responsive.tsx:53` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Tabs`, `TabsList`, `TabsTrigger`, `div`, `span` |
| canonical-wrapper | not-reviewed | `SimpleBrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:51` | - | `Button`, `div` |
| canonical-wrapper | not-reviewed | `Tabs` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:70` | - | `TabsContent`, `TabsList`, `TabsTrigger`, `UiTabs`, `div` |
| canonical-wrapper | not-reviewed | `AppDetailsTabs` in `packages/ui/src/cloud/applications/components/app-details-tabs.tsx:48` | - | `AppAnalytics`, `AppDomains`, `AppEarningsDashboard`, `AppFrontendHosting`, `AppMonetizationSettings`, `AppOverview`, `AppPromote`, `AppSettings`, `AppUsers`, `Button`, `Icon`, `div`, `span` |
| canonical-wrapper | not-reviewed | `BrowserTabSwitcher` in `packages/ui/src/components/pages/BrowserTabSwitcher.tsx:292` | - | `BrowserTabCard`, `Button`, `Dialog`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Plus`, `X`, `div`, `h3`, `p`, `section`, `span` |
| canonical-wrapper | not-reviewed | `AgentTabsSection` in `plugins/plugin-task-coordinator/src/AgentTabsSection.tsx:38` | - | `Button`, `ExternalLink`, `InstallStateIcon`, `KeyRound`, `Loader2`, `RotateCw`, `SettingsControls.MutedText`, `SettingsControls.SegmentedGroup`, `a`, `div`, `span` |
| parallel-primitive | compatibility-adapter | `BrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:18` | `packages/ui/src/components/ui/tabs.tsx` |  |
|  |  | Legacy Cloud export now aliases canonical Tabs while callers migrate to the supported atom export. |  |  |

### textarea

No named candidates.

### tooltip

No named candidates.
