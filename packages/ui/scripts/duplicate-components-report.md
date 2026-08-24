# Atomic component duplicate inventory

Scanned 918 maintained React source files across packages and plugins.

This is a candidate inventory, not an instruction to merge every entry. Canonical wrappers, renderer adapters, and test doubles remain separate because they often have legitimate ownership.

| Atom | Canonical | Same-name | Wrappers | Parallel primitives | Raw host files |
| --- | ---: | ---: | ---: | ---: | ---: |
| alert | 5 | 0 | 0 | 1 | 0 |
| avatar | 2 | 0 | 0 | 0 | 0 |
| badge | 3 | 0 | 9 | 5 | 0 |
| button | 8 | 0 | 11 | 4 | 63 |
| card | 6 | 0 | 24 | 3 | 0 |
| checkbox | 1 | 0 | 0 | 0 | 2 |
| dialog | 10 | 0 | 10 | 2 | 1 |
| input | 4 | 0 | 3 | 2 | 11 |
| popover | 1 | 0 | 1 | 0 | 0 |
| progress | 1 | 0 | 1 | 2 | 0 |
| select | 2 | 0 | 2 | 0 | 3 |
| separator | 3 | 0 | 0 | 0 | 5 |
| skeleton | 4 | 0 | 2 | 5 | 0 |
| spinner | 1 | 0 | 0 | 0 | 0 |
| switch | 2 | 0 | 1 | 0 | 2 |
| table | 1 | 0 | 3 | 1 | 12 |
| tabs | 1 | 0 | 6 | 1 | 0 |
| textarea | 3 | 0 | 0 | 0 | 5 |
| tooltip | 4 | 0 | 0 | 0 | 0 |

## Raw semantic host usage

Raw host elements are reported only where HTML provides a meaningful atomic signal. Generic `div` and `span` usage is deliberately excluded.

### Raw button hosts

| Classification | File | Lines |
| --- | --- | --- |
| runtime-host-control | `packages/app-core/src/runtime/desktop/AppWindowRenderer.tsx` | 424 |
| test-or-story-harness | `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx` | 51, 93 |
| template | `packages/elizaos/templates/plugin/src/frontend/index.tsx` | 65 |
| mixed-canonical-and-raw | `packages/homepage/src/pages/connected.tsx` | 317, 428, 491, 532, 602, 645, 665 |
| mixed-canonical-and-raw | `packages/homepage/src/pages/get-started.tsx` | 535, 627, 1417, 1471, 1490, 1521, 1559, 1577, 1596, 1615, 1633, 1887, 1936, 2025, 2084 |
| product-package-raw-host | `packages/homepage/src/pages/landing.tsx` | 859, 865, 919, 1101, 1111, 1156, 1173 |
| product-package-raw-host | `packages/homepage/src/pages/profile-edit.tsx` | 146, 165 |
| ui-raw-host | `packages/ui/src/android-cloud/AndroidCloudApp.tsx` | 320, 328, 337, 358, 369, 395, 418, 440, 448 |
| ui-raw-host | `packages/ui/src/cloud/public-pages/pages/login/wallet-buttons.tsx` | 351, 452 |
| ui-raw-host | `packages/ui/src/cloud/shell/CloudRouterShell.tsx` | 218 |
| mixed-canonical-and-raw | `packages/ui/src/components/accounts/AccountCommandTable.tsx` | 164, 530 |
| mixed-canonical-and-raw | `packages/ui/src/components/accounts/AccountManagementPanel.tsx` | 338 |
| mixed-canonical-and-raw | `packages/ui/src/components/accounts/ProviderAccountRow.tsx` | 229 |
| ui-raw-host | `packages/ui/src/components/accounts/ProviderPicker.tsx` | 186 |
| ui-raw-host | `packages/ui/src/components/auth/CloudPairRelay.tsx` | 425, 447, 543 |
| ui-raw-host | `packages/ui/src/components/capabilities/ConnectedCapabilityChips.tsx` | 76 |
| mixed-canonical-and-raw | `packages/ui/src/components/chat/MessageContent.tsx` | 571, 616, 899 |
| mixed-canonical-and-raw | `packages/ui/src/components/chat/widgets/ChoiceWidget.tsx` | 162 |
| ui-raw-host | `packages/ui/src/components/chat/widgets/chat-widget-shell.tsx` | 98 |
| ui-raw-host | `packages/ui/src/components/chat/widgets/todo.tsx` | 188, 239 |
| ui-raw-host | `packages/ui/src/components/chat/widgets/workflow-steps.tsx` | 178, 189 |
| mixed-canonical-and-raw | `packages/ui/src/components/config-ui/config-field.tsx` | 244 |
| ui-raw-host | `packages/ui/src/components/pages/Launcher.tsx` | 108 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/MemoryViewerView.tsx` | 857, 874 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/SettingsView.tsx` | 212 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/WorkflowCanvas.tsx` | 150 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/WorkflowEditor.tsx` | 515, 529, 659, 671, 798 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/WorkflowTriggerPanel.tsx` | 217, 260 |
| test-or-story-harness | `packages/ui/src/components/pages/__e2e__/background-fixture.tsx` | 204, 228, 238 |
| mixed-canonical-and-raw | `packages/ui/src/components/pages/documents-detail.tsx` | 356 |
| mixed-canonical-and-raw | `packages/ui/src/components/permissions/PermissionPrimingModal.tsx` | 398 |
| mixed-canonical-and-raw | `packages/ui/src/components/settings/BackgroundSettingsControls.tsx` | 152 |
| mixed-canonical-and-raw | `packages/ui/src/components/settings/ConnectorsSection.tsx` | 432, 599 |
| ui-raw-host | `packages/ui/src/components/settings/DesktopSettingsNavigation.tsx` | 99 |
| ui-raw-host | `packages/ui/src/components/settings/SettingsHubList.tsx` | 47 |
| ui-raw-host | `packages/ui/src/components/settings/cloud-panel/CloudSettingsPanel.tsx` | 82, 139, 279 |
| ui-raw-host | `packages/ui/src/components/settings/cloud-panel/CloudSettingsSidebar.tsx` | 71, 118, 132, 164, 217 |
| mixed-canonical-and-raw | `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx` | 652 |
| ui-raw-host | `packages/ui/src/components/shared/ViewHeader.tsx` | 69 |
| ui-raw-host | `packages/ui/src/components/shared/ViewHeaderSidebarTrigger.tsx` | 40 |
| ui-raw-host | `packages/ui/src/components/shell/BuildBadge.tsx` | 371, 390, 404, 425 |
| mixed-canonical-and-raw | `packages/ui/src/components/shell/ChatOverlay.tsx` | 5993 |
| ui-raw-host | `packages/ui/src/components/shell/DefaultHomeWidgets.tsx` | 101 |
| ui-raw-host | `packages/ui/src/components/shell/NotificationsHomeCenter.tsx` | 2602, 2998, 3012 |
| ui-raw-host | `packages/ui/src/components/shell/VoiceCaptureHud.tsx` | 281 |
| ui-raw-host | `packages/ui/src/components/shell/notification-shade-content.tsx` | 540, 598 |
| mixed-canonical-and-raw | `packages/ui/src/components/transcripts/MeetingJoinBar.tsx` | 178 |
| canonical-implementation | `packages/ui/src/components/ui/admin-dialog.tsx` | 162 |
| canonical-implementation | `packages/ui/src/components/ui/confirm-delete.tsx` | 46, 68, 82 |
| canonical-implementation | `packages/ui/src/components/ui/copy-button.tsx` | 73 |
| canonical-implementation | `packages/ui/src/components/ui/field-switch.tsx` | 28 |
| canonical-implementation | `packages/ui/src/components/ui/segmented-control.tsx` | 52, 128 |
| canonical-implementation | `packages/ui/src/components/ui/switch.tsx` | 59 |
| test-or-story-harness | `packages/ui/src/testing/__e2e__/widget-cert-fixture.tsx` | 67 |
| test-or-story-harness | `packages/ui/stories/src/lab/DesignLab.tsx` | 105, 120 |
| test-or-story-harness | `packages/ui/stories/src/lab/lab-ui.tsx` | 37, 83 |
| test-or-story-harness | `packages/ui/stories/src/lab/surfaces/WidgetsLab.tsx` | 61 |
| test-or-story-harness | `packages/ui/stories/src/voice-main.tsx` | 786, 809 |
| plugin-raw-host | `plugins/plugin-calendar/src/components/calendar/SimpleCalendarView.tsx` | 274, 431, 444, 468, 488, 509, 535, 546 |
| plugin-raw-host | `plugins/plugin-computeruse/src/views/ComputerUseSessionsView.tsx` | 384, 407, 427, 456, 480 |
| plugin-raw-host | `plugins/plugin-elizacloud/src/components/cloud/CloudView.tsx` | 386, 404 |
| plugin-raw-host | `plugins/plugin-maps/src/components/MapsView.tsx` | 163, 210, 241, 306, 366 |
| plugin-raw-host | `plugins/plugin-notes/src/views/viewPrimitives.tsx` | 145 |

### Raw checkbox hosts

| Classification | File | Lines |
| --- | --- | --- |
| ui-raw-host | `packages/ui/src/components/pages/WorkflowEditor.tsx` | 1054 |
| test-or-story-harness | `packages/ui/stories/src/lab/lab-ui.tsx` | 62 |

### Raw dialog hosts

| Classification | File | Lines |
| --- | --- | --- |
| product-package-raw-host | `packages/homepage/src/pages/landing.tsx` | 835 |

### Raw input hosts

| Classification | File | Lines |
| --- | --- | --- |
| product-package-raw-host | `packages/homepage/src/pages/get-started.tsx` | 600 |
| product-package-raw-host | `packages/homepage/src/pages/profile-edit.tsx` | 117, 131 |
| test-or-story-harness | `packages/ui/src/agent-surface/__e2e__/teardown-fixture.tsx` | 46, 75 |
| ui-raw-host | `packages/ui/src/components/accounts/AccountCommandTable.tsx` | 507 |
| ui-raw-host | `packages/ui/src/components/accounts/ConsumerKeyPanel.tsx` | 311, 322, 504 |
| ui-raw-host | `packages/ui/src/components/accounts/ProviderPicker.tsx` | 143 |
| test-or-story-harness | `packages/ui/src/components/pages/__e2e__/background-fixture.tsx` | 220 |
| ui-raw-host | `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx` | 446, 771 |
| canonical-implementation | `packages/ui/src/components/ui/input-group.tsx` | 101 |
| canonical-implementation | `packages/ui/src/components/ui/input.tsx` | 46 |
| plugin-raw-host | `plugins/plugin-maps/src/components/MapsView.tsx` | 128 |

### Raw select hosts

| Classification | File | Lines |
| --- | --- | --- |
| product-package-raw-host | `packages/homepage/src/components/login/phone-number-input.tsx` | 127 |
| ui-raw-host | `packages/ui/src/components/pages/WorkflowTriggerPanel.tsx` | 289, 304, 321 |
| plugin-raw-host | `plugins/plugin-calendar/src/components/calendar/SimpleCalendarView.tsx` | 476 |

### Raw separator hosts

| Classification | File | Lines |
| --- | --- | --- |
| ui-raw-host | `packages/ui/src/components/chat/TasksEventsPanel.tsx` | 267 |
| ui-raw-host | `packages/ui/src/components/composites/sidebar/sidebar-root.tsx` | 829 |
| ui-raw-host | `packages/ui/src/components/config-ui/ui-renderer.tsx` | 484 |
| ui-raw-host | `packages/ui/src/genui/renderer.tsx` | 329 |
| plugin-raw-host | `plugins/plugin-task-coordinator/src/orchestrator-markdown.tsx` | 137 |

### Raw switch hosts

| Classification | File | Lines |
| --- | --- | --- |
| ui-raw-host | `packages/ui/src/components/pages/WorkflowEditor.tsx` | 1054 |
| test-or-story-harness | `packages/ui/stories/src/lab/lab-ui.tsx` | 62 |

### Raw table hosts

| Classification | File | Lines |
| --- | --- | --- |
| ui-raw-host | `packages/ui/src/cloud/analytics/_components/model-breakdown.tsx` | 99 |
| ui-raw-host | `packages/ui/src/cloud/applications/components/app-analytics.tsx` | 741, 889, 977 |
| ui-raw-host | `packages/ui/src/cloud/applications/components/app-users.tsx` | 210 |
| ui-raw-host | `packages/ui/src/components/accounts/AccountCommandTable.tsx` | 341 |
| ui-raw-host | `packages/ui/src/components/config-ui/config-field.helpers.tsx` | 1844 |
| ui-raw-host | `packages/ui/src/components/config-ui/ui-renderer.tsx` | 882 |
| ui-raw-host | `packages/ui/src/components/pages/WorkflowEditor.tsx` | 212 |
| ui-raw-host | `packages/ui/src/components/pages/database-utils.tsx` | 149 |
| ui-raw-host | `packages/ui/src/components/settings/AppsManagementSection.tsx` | 743 |
| ui-raw-host | `packages/ui/src/components/settings/vault-tabs/RoutingTab.tsx` | 592 |
| canonical-implementation | `packages/ui/src/components/ui/table.tsx` | 15 |
| plugin-raw-host | `plugins/plugin-task-coordinator/src/orchestrator-markdown.tsx` | 95 |

### Raw textarea hosts

| Classification | File | Lines |
| --- | --- | --- |
| product-package-raw-host | `packages/homepage/src/pages/profile-edit.tsx` | 159 |
| ui-raw-host | `packages/ui/src/android-cloud/AndroidCloudApp.tsx` | 430 |
| canonical-implementation | `packages/ui/src/components/ui/admin-dialog.tsx` | 131 |
| canonical-implementation | `packages/ui/src/components/ui/input-group.tsx` | 118 |
| canonical-implementation | `packages/ui/src/components/ui/textarea.tsx` | 44 |


## Named candidates by atom

### alert

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| parallel-primitive | molecular | `CostAlerts` in `packages/ui/src/cloud-ui/components/analytics/cost-alerts.tsx:16` | - | `AlertTriangle`, `Info`, `TrendingDown`, `div`, `p` |
|  |  | Analytics alert collection, not an Alert primitive. |  |  |

### avatar

No named candidates.

### badge

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ConnectionConnectedBadge` in `packages/ui/src/cloud-ui/components/connection-card.tsx:91` | - | `Badge`, `CheckCircle` |
| canonical-wrapper | not-reviewed | `VoiceStatusBadge` in `packages/ui/src/cloud-ui/components/voice/voice-status-badge.tsx:20` | - | `AlertCircle`, `CheckCircle2`, `Clock`, `Loader2`, `StatusBadge` |
| canonical-wrapper | not-reviewed | `ApprovalStatusBadge` in `packages/ui/src/cloud/approvals/components/status-badge.tsx:54` | - | `SharedStatusBadge` |
| canonical-wrapper | not-reviewed | `AgentCostBadge` in `packages/ui/src/cloud/instances/components/agent-cost-badge.tsx:30` | - | `Tooltip`, `TooltipContent`, `TooltipTrigger`, `p`, `span` |
| canonical-wrapper | not-reviewed | `McpStatusBadge` in `packages/ui/src/cloud/mcps/McpDetailDrawer.tsx:446` | - | `StatusBadge` |
| canonical-wrapper | consolidation-candidate | `SurfaceBadge` in `packages/ui/src/components/apps/extensions/surface.tsx:34` | `packages/ui/src/components/ui/status-badge.tsx` | `StatusBadge` |
|  |  | Tone-based text badge overlaps the canonical status badge contract. |  |  |
| canonical-wrapper | not-reviewed | `CloudStatusBadge` in `packages/ui/src/components/cloud/CloudStatusBadge.tsx:143` | - | `Button`, `span` |
| canonical-wrapper | consolidation-candidate | `RedactedBadge` in `packages/ui/src/components/RedactedBadge.tsx:14` | `packages/ui/src/components/ui/badge.tsx` | `Badge`, `EyeOff` |
|  |  | Static labeled badge duplicates canonical badge structure and styling. |  |  |
| canonical-wrapper | consolidation-candidate | `SpeakerNameAttributionBadge` in `packages/ui/src/components/transcripts/SpeakerNameAttributionBadge.tsx:40` | `packages/ui/src/components/ui/status-badge.tsx` | `StatusBadge`, `span` |
|  |  | Status-toned attribution label should compose the canonical status badge. |  |  |
| parallel-primitive | consolidation-candidate | `LlmsTxtBadge` in `packages/ui/src/cloud-ui/components/docs/llms-txt-badge.tsx:8` | `packages/ui/src/components/ui/badge.tsx` | `a`, `div` |
|  |  | Link-shaped badge duplicates badge chrome and should compose Badge with asChild support. |  |  |
| parallel-primitive | intentional-specialization | `ChatVoiceSpeakerBadge` in `packages/ui/src/components/composites/chat/chat-source.tsx:56` | `packages/ui/src/components/ui/badge.tsx` | `Crown`, `Mic`, `span` |
|  |  | Role and voice icon marker has domain behavior, but should continue to source base badge tokens from the canonical owner. |  |  |
| parallel-primitive | intentional-specialization | `OwnerBadge` in `packages/ui/src/components/composites/OwnerBadge.tsx:53` | `packages/ui/src/components/ui/badge.tsx` | `Crown`, `span` |
|  |  | Placement-aware owner marker is shared domain UI rather than a second general badge. |  |  |
| parallel-primitive | molecular | `HardwareBadge` in `packages/ui/src/components/local-inference/HardwareBadge.tsx:16` | - | `AlertTriangle`, `Cpu`, `Gauge`, `HardDrive`, `div`, `span` |
|  |  | Multi-field hardware summary made of several status regions. |  |  |
| parallel-primitive | molecular | `BuildBadge` in `packages/ui/src/components/shell/BuildBadge.tsx:298` | - | `X`, `button`, `dd`, `div`, `dl`, `dt`, `span` |
|  |  | Interactive build-details control and popover, not an atomic badge. |  |  |

### button

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `AgentButton` in `packages/ui/src/agent-surface/components.tsx:32` | - | `Button` |
| canonical-wrapper | not-reviewed | `ExportButton` in `packages/ui/src/cloud-ui/components/analytics/export-button.tsx:36` | - | `Button`, `ChevronDown`, `Download`, `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuTrigger`, `Upload` |
| canonical-wrapper | not-reviewed | `ElizaConnectButton` in `packages/ui/src/cloud/instances/components/eliza-connect-button.tsx:16` | - | `BrandButton`, `ExternalLink` |
| canonical-wrapper | not-reviewed | `PstnCallButton` in `packages/ui/src/components/composites/chat/pstn-call-button.tsx:77` | - | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Loader2`, `PhoneCall`, `div`, `p` |
| canonical-wrapper | not-reviewed | `SidebarCollapsedActionButton` in `packages/ui/src/components/composites/sidebar/sidebar-collapsed-rail.tsx:77` | - | `Button` |
| canonical-wrapper | not-reviewed | `SidebarItemButton` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:253` | - | `Button` |
| canonical-wrapper | not-reviewed | `DestructiveSecondaryButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:74` | - | `Button` |
| canonical-wrapper | not-reviewed | `CloudActionButton` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:496` | - | `Button`, `SettingRowShell` |
| canonical-wrapper | not-reviewed | `SettingsActionButton` in `packages/ui/src/components/settings/settings-agent-rows.tsx:576` | - | `Button` |
| canonical-wrapper | not-reviewed | `GlassIconButton` in `packages/ui/src/components/shell/glass-composer.tsx:24` | - | `Button`, `Icon` |
| canonical-wrapper | not-reviewed | `RecoveryActionButton` in `plugins/plugin-task-coordinator/src/orchestrator-task-inspector.tsx:1101` | - | `Button` |
| parallel-primitive | consolidation-candidate | `BrandButton` in `packages/ui/src/cloud-ui/components/brand/brand-button.tsx:46` | `packages/ui/src/components/ui/button.tsx` | `Comp` |
|  |  | Reimplements Slot, button attributes, sizes, states, and variants already owned by Button. |  |  |
| parallel-primitive | consolidation-candidate | `LockOnButton` in `packages/ui/src/cloud-ui/components/brand/lock-on-button.tsx:14` | `packages/ui/src/components/ui/button.tsx` | `Component` |
|  |  | Special hover treatment can be a canonical Button variant or wrapper without a second button base. |  |  |
| parallel-primitive | consolidation-candidate | `ViewBackButton` in `packages/ui/src/components/shared/ViewHeader.tsx:44` | `packages/ui/src/components/ui/button.tsx` | `ArrowLeft`, `button`, `span` |
|  |  | Agent instrumentation is specialized, but the raw button can compose the canonical Button. |  |  |
| parallel-primitive | lab-only | `ActionButton` in `packages/ui/stories/src/lab/lab-ui.tsx:73` | `packages/ui/src/components/ui/button.tsx` | `button` |
|  |  | Design-lab fixture is not shipped product UI. |  |  |
| renderer-adapter | not-reviewed | `Button` in `packages/ui/src/spatial/primitives.tsx:517` | - | `UiButton` |
| template-adapter | not-reviewed | `InferenceCloudAlertButton` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:14` | - |  |
| test-double | not-reviewed | `Button` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:46` | - | `button` |
| test-double | not-reviewed | `Button` in `plugins/plugin-contacts/test/stubs/ui.tsx:15` | - |  |
| test-double | not-reviewed | `Button` in `plugins/plugin-phone/test/stubs/ui.tsx:13` | - |  |

### card

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `CostInsightsCard` in `packages/ui/src/cloud-ui/components/analytics/cost-insights-card.tsx:21` | - | `Badge`, `BrandCard`, `CostAlerts`, `Progress`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `PromptCard` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:15` | - | `ArrowUp`, `Button`, `p` |
| canonical-wrapper | not-reviewed | `ConnectionCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:369` | - | `AlertTriangle`, `Button`, `ConnectionLoadingCard`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | - | `Skeleton`, `div` |
| canonical-wrapper | not-reviewed | `EndpointCard` in `packages/ui/src/cloud-ui/components/docs/endpoint-card.tsx:61` | - | `Button`, `ChevronRight`, `Coins`, `Sparkles`, `code`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `BuyDomainCard` in `packages/ui/src/cloud/applications/components/BuyDomainCard.tsx:68` | - | `AlertDialog`, `AlertDialogAction`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `AlertDialogTrigger`, `AlertTriangle`, `Button`, `CheckCircle2`, `CreditCard`, `Input`, `Loader2`, `Search`, `ShoppingCart`, `XCircle`, `div`, `form`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ActiveComputeCardView` in `packages/ui/src/cloud/billing/components/active-compute-card.tsx:301` | - | `AlertCircle`, `BrandCard`, `Calculator`, `Clock3`, `LoadingCard`, `RefreshCw`, `ResourceCard`, `RetryButton`, `StatusBadge`, `div`, `h3`, `p`, `span`, `ul` |
| canonical-wrapper | not-reviewed | `AutoTopUpCard` in `packages/ui/src/cloud/billing/components/auto-top-up-card.tsx:144` | - | `AlertCircle`, `BrandCard`, `Button`, `CornerBrackets`, `CreditCard`, `Info`, `Loader2`, `RefreshCw`, `SettingsInputRow`, `SettingsSwitchRow`, `div`, `h3`, `p`, `span` |
| canonical-wrapper | not-reviewed | `DirectCryptoCreditCard` in `packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx:179` | - | `Button`, `Card`, `CardContent`, `CardHeader`, `CardTitle`, `Coins`, `ConnectButton.Custom`, `Link`, `Loader2`, `PaymentWaitingOverlay`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `ShieldCheck`, `Wallet`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:178` | - | `Badge`, `Button`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `Spinner`, `StatusBadge`, `Trash2`, `UsageBar`, `div`, `span` |
| canonical-wrapper | not-reviewed | `AccountRequiredCard` in `packages/ui/src/components/chat/AccountRequiredCard.tsx:133` | - | `Button`, `ReconnectProgressLine`, `RefreshCw`, `ShieldAlert`, `Spinner`, `StatusBadge`, `UserRound`, `div`, `span` |
| canonical-wrapper | not-reviewed | `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83` | - | `Button`, `ConnectorBrandIcon`, `Input`, `ShieldCheck`, `div`, `form`, `label`, `span` |
| canonical-wrapper | not-reviewed | `HomeWidgetCard` in `packages/ui/src/components/chat/widgets/home-widget-card.tsx:89` | - | `Button`, `span` |
| canonical-wrapper | not-reviewed | `PermissionCard` in `packages/ui/src/components/composites/chat/permission-card.tsx:57` | - | `Button`, `div`, `h3`, `header`, `p`, `section`, `span` |
| canonical-wrapper | not-reviewed | `TrajectoryLlmCallCard` in `packages/ui/src/components/composites/trajectories/trajectory-llm-call-card.tsx:64` | - | `Button`, `CallMetric`, `ChevronDown`, `ChevronRight`, `PagePanel`, `TrajectoryCodeBlock`, `div`, `span` |
| canonical-wrapper | not-reviewed | `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163` | - | `Badge`, `Button`, `Checkbox`, `ConnectedCapabilityChips`, `ConnectorAccountPrivacySelector`, `ConnectorAccountPurposeSelector`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `EditableAccountLabel`, `KeyRound`, `RefreshCw`, `Spinner`, `Star`, `StatusBadge`, `Trash2`, `div`, `img`, `span` |
| canonical-wrapper | not-reviewed | `ModelCard` in `packages/ui/src/components/local-inference/ModelCard.tsx:55` | - | `Button`, `DownloadProgress`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `PluginCard` in `packages/ui/src/components/pages/PluginCard.tsx:46` | - | `Button`, `PluginVisual`, `div`, `li`, `p`, `span` |
| canonical-wrapper | not-reviewed | `PendantSettingsCard` in `packages/ui/src/components/settings/PendantSettingsCard.tsx:46` | - | `BatteryBadge`, `Bluetooth`, `Button`, `Loader2`, `Radio`, `SettingsGroup`, `SettingsRow`, `span` |
| canonical-wrapper | not-reviewed | `ProviderCard` in `packages/ui/src/components/settings/ProviderCard.tsx:46` | - | `Button`, `CheckCircle2`, `Icon`, `span` |
| canonical-wrapper | not-reviewed | `AppBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/AppBlockerSettingsCard.tsx:110` | - | `AppBlockerStatusIcon`, `Button`, `CheckCircle2`, `Clock3`, `Input`, `ListChecks`, `Loader2`, `RefreshCw`, `Search`, `ShieldBan`, `Smartphone`, `Square`, `Timer`, `div`, `label`, `span` |
| canonical-wrapper | not-reviewed | `WebsiteBlockerSettingsCard` in `plugins/plugin-personal-assistant/src/components/WebsiteBlockerSettingsCard.tsx:80` | - | `Button`, `CheckCircle2`, `Monitor`, `Settings`, `ShieldBan`, `div`, `span` |
| canonical-wrapper | not-reviewed | `GitHubConnectionCard` in `plugins/plugin-task-coordinator/src/GitHubConnectionCard.tsx:80` | - | `Button`, `CheckCircle2`, `ExternalLink`, `GitPullRequest`, `LogIn`, `SettingsControls.Input`, `Unplug`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `TaskCard` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:238` | - | `Button`, `GitBranch`, `TaskStatusChip`, `TaskStatusMedallion`, `span` |
| molecular-candidate | not-reviewed | `AgentCard` in `packages/ui/src/cloud-ui/components/brand/brand-card.tsx:63` | - | `BrandCard`, `div`, `h3`, `p` |
| molecular-candidate | not-reviewed | `DashboardStatCard` in `packages/ui/src/cloud-ui/components/brand/dashboard-stat-card.tsx:37` | - | `BrandCard`, `div`, `p` |
| molecular-candidate | not-reviewed | `PromptCardGrid` in `packages/ui/src/cloud-ui/components/brand/prompt-card.tsx:40` | - | `PromptCard`, `div` |
| molecular-candidate | not-reviewed | `ConnectionLoadingCard` in `packages/ui/src/cloud-ui/components/connection-card.tsx:76` | - | `Loader2`, `div` |
| molecular-candidate | not-reviewed | `DashboardActionCards` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:72` | - | `ArrowRight`, `BookOpen`, `Bot`, `Code`, `CreditCard`, `KeyRound`, `Link`, `Rocket`, `Server`, `Store`, `Wallet`, `div`, `h3`, `span` |
| molecular-candidate | not-reviewed | `DashboardDataListCard` in `packages/ui/src/cloud-ui/components/data-list/dashboard-data-list.tsx:79` | - | `div` |
| molecular-candidate | not-reviewed | `Cards` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:57` | - | `div` |
| molecular-candidate | not-reviewed | `MilestoneCard` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:88` | - | `MilestoneProgress`, `div`, `h4` |
| molecular-candidate | not-reviewed | `AgentCard` in `packages/ui/src/cloud/instances/components/agent-card.tsx:856` | - |  |
| molecular-candidate | not-reviewed | `MessagePermissionCard` in `packages/ui/src/components/chat/MessageContent.tsx:1259` | - |  |
| molecular-candidate | not-reviewed | `MapsCardWidget` in `packages/ui/src/components/chat/widgets/maps-card.tsx:347` | - | `AttributionLine`, `HandoffCard`, `LocateCard`, `PlaceRow`, `Route`, `a`, `div`, `li`, `span`, `ul` |
| molecular-candidate | not-reviewed | `OrchestratorGrillingCard` in `packages/ui/src/components/chat/widgets/orchestrator-grilling-card.tsx:85` | - | `div`, `li`, `p`, `span`, `ul` |
| molecular-candidate | not-reviewed | `SummaryCard` in `packages/ui/src/components/composites/page-panel/page-panel-header.tsx:102` | - | `div` |
| molecular-candidate | not-reviewed | `ProtectionCard` in `packages/ui/src/components/settings/vault-tabs/OverviewTab.tsx:258` | - | `AlertCircle`, `CheckCircle2`, `div`, `p`, `section` |
| parallel-primitive | consolidation-candidate | `BrandCard` in `packages/ui/src/cloud-ui/components/brand/brand-card.tsx:26` | `packages/ui/src/components/ui/card.tsx` | `Component`, `CornerBrackets` |
|  |  | Reimplements the base card surface, polymorphism, padding, border, and hover contract. |  |  |
| parallel-primitive | molecular | `MiniStatCard` in `packages/ui/src/cloud-ui/components/brand/mini-stat-card.tsx:13` | `packages/ui/src/components/ui/card.tsx` | `div`, `p` |
|  |  | Metric composition, not a base card primitive. |  |  |
| parallel-primitive | false-positive | `SurfaceCard` in `packages/ui/src/components/apps/extensions/surface.tsx:51` | - | `div` |
|  |  | Compact label-value definition block; the Card suffix does not represent card chrome. |  |  |
| renderer-adapter | not-reviewed | `Card` in `packages/ui/src/spatial/primitives.tsx:801` | - | `Stack` |
| template-adapter | not-reviewed | `AppBlockerSettingsCard` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:15` | - |  |
| template-adapter | not-reviewed | `WebsiteBlockerSettingsCard` in `packages/elizaos/templates/project/apps/app/src/optional-eliza-app-stub.tsx:16` | - |  |

### checkbox

No named candidates.

### dialog

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `BulkDeleteDialog` in `packages/ui/src/cloud-ui/components/bulk/bulk-select.tsx:75` | - | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button` |
| canonical-wrapper | not-reviewed | `AccountDeletionDialog` in `packages/ui/src/cloud/account-security/components/account-deletion-dialog.tsx:30` | - | `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `Button`, `Input`, `a`, `div`, `label`, `p` |
| canonical-wrapper | not-reviewed | `WithdrawDialog` in `packages/ui/src/cloud/applications/components/withdraw-dialog.tsx:45` | - | `AlertCircle`, `ArrowRight`, `Button`, `CheckCircle2`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Loader2`, `Wallet`, `div`, `h3`, `label`, `p`, `span` |
| canonical-wrapper | not-reviewed | `McpEditorDialog` in `packages/ui/src/cloud/mcps/McpEditorDialog.tsx:185` | - | `BrandButton`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Switch`, `Textarea`, `div`, `p` |
| canonical-wrapper | not-reviewed | `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:54` | - | `AlertCircle`, `BrandButton`, `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `KeyRound`, `Label`, `Loader2`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `ShieldCheck`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | not-reviewed | `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:64` | - | `AlertCircle`, `BrandButton`, `Button`, `Copy`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Link2`, `Loader2`, `Mail`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `UserCog`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AddAccountDialog` in `packages/ui/src/components/accounts/AddAccountDialog.tsx:180` | - | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `ProviderPicker`, `Spinner`, `a`, `code`, `div`, `form`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41` | - | `Button`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `Input`, `Label`, `Sparkles`, `div` |
| canonical-wrapper | not-reviewed | `PluginSettingsDialog` in `packages/ui/src/components/pages/plugin-view-dialogs.tsx:68` | - | `AdminDialog.BodyScroll`, `AdminDialog.Content`, `AdminDialog.Footer`, `AdminDialog.Header`, `AdminDialog.MetaBadge`, `AdminDialog.MonoMeta`, `Button`, `CheckCircle2`, `ConnectorSetupPanel`, `Dialog`, `DialogDescription`, `DialogTitle`, `PluginConfigForm`, `SettingsDialogIcon`, `div`, `span` |
| canonical-wrapper | not-reviewed | `CloudConfirmDialog` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:685` | - | `Button`, `CloudModal`, `div`, `p` |
| parallel-primitive | molecular | `PromoteAppDialog` in `packages/ui/src/cloud-ui/components/promotion/promote-app-dialog.tsx:152` | `packages/ui/src/components/ui/dialog.tsx` | `AlertCircle`, `ArrowLeft`, `ArrowRight`, `Braces`, `Button`, `Check`, `CheckCircle`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `FileText`, `Input`, `Label`, `Loader2`, `Megaphone`, `Search`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `Send`, `Share2`, `Textarea`, `div`, `h3`, `p`, `platform.Icon`, `span` |
|  |  | Multi-step workflow already composes the canonical Dialog family. |  |  |
| parallel-primitive | intentional-specialization | `ConversationRenameDialog` in `packages/ui/src/components/conversations/ConversationRenameDialog.tsx:21` | `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx` | `ChatConversationRenameDialog` |
|  |  | Compatibility adapter around the shared conversation rename composition. |  |  |

### input

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `PhoneNumberInput` in `packages/homepage/src/components/login/phone-number-input.tsx:109` | - | `ChevronDown`, `CountryFlag`, `Input`, `div`, `label`, `option`, `select` |
| canonical-wrapper | not-reviewed | `AgentInput` in `packages/ui/src/agent-surface/components.tsx:68` | - | `Input` |
| canonical-wrapper | not-reviewed | `TaskSearchInput` in `plugins/plugin-task-coordinator/src/TaskCardList.tsx:184` | - | `Input`, `Search`, `div` |
| parallel-primitive | molecular | `CloudInputRow` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:416` | `packages/ui/src/components/ui/input.tsx` | `SettingRowShell`, `input` |
|  |  | Settings row composition; its internal raw input remains a separate migration target. |  |  |
| parallel-primitive | consolidation-candidate | `CloudTextInput` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:753` | `packages/ui/src/components/ui/input.tsx` | `input` |
|  |  | Directly reimplements the canonical text input with a narrower value callback. |  |  |
| test-double | not-reviewed | `Input` in `plugins/plugin-contacts/test/stubs/ui.tsx:26` | - |  |

### popover

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `CellPopover` in `packages/ui/src/components/pages/database-utils.tsx:80` | - | `CodeBlock`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle` |
| test-double | not-reviewed | `Popover` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:61` | - | `div` |
| test-double | not-reviewed | `PopoverContent` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:74` | - | `div` |

### progress

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | consolidation-candidate | `DownloadProgress` in `packages/ui/src/components/local-inference/DownloadProgress.tsx:15` | `packages/ui/src/components/ui/progress.tsx` | `Progress`, `div`, `span` |
|  |  | Inline determinate progress bar duplicates the canonical Progress base. |  |  |
| parallel-primitive | molecular | `MilestoneProgress` in `packages/ui/src/cloud-ui/components/monetization/milestone-progress.tsx:20` | `packages/ui/src/components/ui/progress.tsx` | `CheckCircle2`, `Target`, `div`, `span` |
|  |  | Milestone state composition, not a generic progress primitive. |  |  |
| parallel-primitive | intentional-specialization | `NavigationProgress` in `packages/ui/src/cloud-ui/components/navigation-progress.tsx:13` | - |  |
|  |  | Route lifecycle adapter around nprogress, not an inline progress control. |  |  |

### select

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ApiParameterSelect` in `packages/ui/src/cloud-ui/components/docs/api-parameter-select.tsx:29` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` |
| canonical-wrapper | not-reviewed | `FilterSelect` in `plugins/plugin-task-coordinator/src/orchestrator-workbench-list.tsx:29` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `TaskStatusChip`, `span` |

### separator

No named candidates.

### skeleton

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `DashboardActionCardsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:169` | - | `Skeleton`, `div` |
| canonical-wrapper | not-reviewed | `DashboardTableSkeleton` in `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx:29` | - | `Skeleton`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `div` |
| parallel-primitive | molecular | `MonacoEditorSkeleton` in `packages/ui/src/cloud-ui/components/code/monaco-editor-skeleton.tsx:14` | `packages/ui/src/components/ui/skeleton.tsx` | `Loader2`, `div`, `span` |
|  |  | Editor loading composition with label and spinner. |  |  |
| parallel-primitive | intentional-specialization | `AppsSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:218` | `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx` | `DashboardTableSkeleton` |
|  |  | Named preset around the shared dashboard table skeleton. |  |  |
| parallel-primitive | intentional-specialization | `ContainersSkeleton` in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx:237` | `packages/ui/src/cloud-ui/components/data-list/dashboard-table-skeleton.tsx` | `DashboardTableSkeleton` |
|  |  | Named preset around the shared dashboard table skeleton. |  |  |
| parallel-primitive | molecular | `LoginOptionsSkeleton` in `packages/ui/src/cloud/public-pages/pages/login/login-section-skeleton.tsx:39` | `packages/ui/src/components/ui/skeleton.tsx` | `GhostRow`, `div` |
|  |  | Full login-options loading composition. |  |  |
| parallel-primitive | false-positive | `ViewLoadingSkeleton` in `packages/ui/src/components/views/ViewStatusStates.tsx:82` | - | `LoaderCircle`, `ViewStatusFrame` |
|  |  | Loading status frame uses a spinner and contains no skeleton primitive. |  |  |

### spinner

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| test-double | not-reviewed | `Spinner` in `packages/app/test/view-screenshots/stubs/elizaos-ui.tsx:57` | - | `span` |

### switch

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ConnectorChannelModeSwitch` in `packages/ui/src/components/connectors/ConnectorChannelModeSwitch.tsx:40` | - | `SegmentedControl`, `span` |

### table

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `ApiKeysTable` in `packages/ui/src/cloud-ui/components/data-list/api-keys-table.tsx:83` | - | `DashboardDataListDesktop`, `DashboardDataListMobile`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `ElizaAgentsTable` in `packages/ui/src/cloud/instances/components/eliza-agents-table.tsx:334` | - | `AgentCostBadge`, `AlertDialog`, `AlertDialogCancel`, `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`, `AlertDialogTitle`, `ArrowUpDown`, `BulkDeleteDialog`, `BulkSelectionBar`, `Button`, `Checkbox`, `DashboardDataList`, `DashboardDataListDesktop`, `DashboardDataListFilteredCount`, `DashboardDataListMobile`, `DataListEmptyState`, `ExternalLink`, `Input`, `Moon`, `Pause`, `Play`, `Search`, `StatusCell`, `Sun`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow`, `Tooltip`, `TooltipContent`, `TooltipProvider`, `TooltipTrigger`, `Trash2`, `a`, `div`, `p`, `span` |
| canonical-wrapper | not-reviewed | `AccountCommandTable` in `packages/ui/src/components/accounts/AccountCommandTable.tsx:224` | - | `Button`, `Checkbox`, `ChevronDown`, `ChevronUp`, `Dialog`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogTitle`, `HealthCell`, `KeyRound`, `RotateCw`, `SortHeader`, `Spinner`, `Trash2`, `UsageBar`, `button`, `div`, `input`, `span`, `table`, `tbody`, `td`, `th`, `thead`, `tr` |
| parallel-primitive | molecular | `AppsTable` in `packages/ui/src/cloud/applications/components/apps-table.tsx:31` | `packages/ui/src/cloud-ui/components/data-list/apps-list-view.tsx` | `AppsListView`, `BulkDeleteDialog`, `BulkSelectionBar`, `Link`, `span` |
|  |  | Application list composition, not a table primitive implementation. |  |  |

### tabs

| Classification | Decision | Definition | Canonical owner | Rendered tags |
| --- | --- | --- | --- | --- |
| canonical-wrapper | not-reviewed | `BrandTabsResponsive` in `packages/ui/src/cloud-ui/components/brand/brand-tabs-responsive.tsx:53` | - | `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`, `TabsPrimitive.List`, `TabsPrimitive.Root`, `TabsPrimitive.Trigger`, `div`, `span` |
| canonical-wrapper | not-reviewed | `SimpleBrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:67` | - | `Button`, `div` |
| canonical-wrapper | not-reviewed | `Tabs` in `packages/ui/src/cloud-ui/components/docs/mdx-components.tsx:70` | - | `TabsContent`, `TabsList`, `TabsTrigger`, `UiTabs`, `div` |
| canonical-wrapper | not-reviewed | `AppDetailsTabs` in `packages/ui/src/cloud/applications/components/app-details-tabs.tsx:49` | - | `AppAnalytics`, `AppDomains`, `AppEarningsDashboard`, `AppFrontendHosting`, `AppMonetizationSettings`, `AppOverview`, `AppPromote`, `AppSettings`, `AppUsers`, `Button`, `Icon`, `div`, `span` |
| canonical-wrapper | not-reviewed | `BrowserTabSwitcher` in `packages/ui/src/components/pages/BrowserTabSwitcher.tsx:274` | - | `BrowserTabCard`, `Button`, `Dialog`, `DialogClose`, `DialogContent`, `DialogHeader`, `DialogTitle`, `Plus`, `X`, `div`, `h3`, `p`, `section`, `span` |
| canonical-wrapper | not-reviewed | `AgentTabsSection` in `plugins/plugin-task-coordinator/src/AgentTabsSection.tsx:38` | - | `Button`, `ExternalLink`, `InstallStateIcon`, `KeyRound`, `Loader2`, `RotateCw`, `SettingsControls.MutedText`, `SettingsControls.SegmentedGroup`, `a`, `div`, `span` |
| parallel-primitive | consolidation-candidate | `BrandTabs` in `packages/ui/src/cloud-ui/components/brand/brand-tabs.tsx:13` | `packages/ui/src/components/ui/tabs.tsx` |  |
|  |  | Direct Radix Tabs root and subcomponent implementation duplicates canonical Tabs. |  |  |
| test-double | not-reviewed | `Tabs` in `plugins/plugin-phone/test/stubs/ui-tabs.tsx:25` | - |  |

### textarea

No named candidates.

### tooltip

No named candidates.

