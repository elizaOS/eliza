# Molecular component duplicate inventory

Scanned 895 maintained React files. 100 exported compositions have a recognized molecular role and at least two atomic dependencies.

Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.

## Canonical molecule contracts

These owners are fail-closed contracts. The audit fails if an owner disappears, drops a required canonical atom, or loses its maintained consumers.

| Contract | Canonical owner | Maintained references | Responsibility |
| --- | --- | ---: | --- |
| auth-result-shell | `AuthResultShell` in `packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.tsx` | 2 | Full-page surface, centered card, and content geometry for authentication results. |
| connection-capability-tile | `ConnectionCapabilityTile` in `packages/ui/src/cloud/connectors/connection-capability-tile.tsx` | 2 | Icon, title, and description hierarchy for connector capability grids. |
| content-state | `ContentState` in `packages/ui/src/components/composites/page-panel/content-state.tsx` | 2 | Empty and loading presentation inside page-panel placements. |
| settings-row | `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx` | 40 | Label, description, control, and navigation alignment for settings. |
| selectable-tile | `SelectableTile` in `packages/ui/src/components/composites/settings/selectable-tile.tsx` | 1 | Pressed-state selection tile with a leading visual and check indicator. |
| action-list-row | `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx` | 2 | Button, link, and static list rows with shared content slots. |

## Duplicate review queue

| Role | Atomic dependencies | Components | Decision |
| --- | --- | ---: | --- |
| row | button, card | 4 | distinct-domain-compositions |
| dialog | button, dialog | 3 | distinct-domain-compositions |
| dialog | button, dialog, input | 3 | distinct-domain-compositions |
| list | badge, button, card | 3 | distinct-domain-compositions |
| panel | button, card, input | 3 | distinct-domain-compositions |
| card | badge, button, card, checkbox, dialog, spinner | 2 | distinct-domain-compositions |
| card | button, input | 2 | distinct-domain-compositions |
| dialog | alert, button, card | 2 | distinct-domain-compositions |
| form | button, input | 2 | distinct-domain-compositions |
| panel | badge, button, input | 2 | shared-lifecycle-owner |
| panel | button, input | 2 | distinct-domain-compositions |
| row | button, card, statusDot | 2 | distinct-domain-compositions |

## Reviewed clusters

### row: button + card

- `SidebarItem` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:174`
- `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx:196`
- `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx:115`
- `ReasoningCell` in `plugins/plugin-task-coordinator/src/orchestrator-reasoning.tsx:96`
- Decision: **distinct-domain-compositions** — Sidebar and settings rows share atomic controls but own different selection, status, and lifecycle contracts.

### dialog: button + dialog

- `EditSkillModal` in `packages/ui/src/components/pages/skill-detail-panel.tsx:35`
- `ConfirmDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:35`
- `EventEditorDrawer` in `plugins/plugin-calendar/src/components/EventEditorDrawer.tsx:469`
- Decision: **distinct-domain-compositions** — The shared atoms describe ordinary modal chrome; the six components own unrelated workflows and state.

### dialog: button + dialog + input

- `SaveCommandModal` in `packages/ui/src/components/chat/SaveCommandModal.tsx:37`
- `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41`
- `PromptDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:95`
- Decision: **distinct-domain-compositions** — Withdrawal, command persistence, conversation renaming, and generic prompting have different validation, pending, error, and result contracts; their only stable shared behavior already belongs to the canonical Dialog, Input, and Button atoms.

### list: badge + button + card

- `CredentialsList` in `packages/ui/src/cloud/organization/credentials-list.tsx:78`
- `MembersList` in `packages/ui/src/cloud/organization/members-list.tsx:53`
- `PendingInvitesList` in `packages/ui/src/cloud/organization/pending-invites-list.tsx:42`
- Decision: **distinct-domain-compositions** — The lists share canonical status, action, and surface atoms, but their item identity, loading, selection, and mutation contracts remain domain-specific.

### panel: button + card + input

- `MessageSearchPanel` in `packages/ui/src/components/chat/message-search/MessageSearchPanel.tsx:50`
- `TelegramAccountConnectorPanel` in `packages/ui/src/components/connectors/TelegramAccountConnectorPanel.tsx:72`
- `DesktopTalkModePanel` in `packages/ui/src/components/settings/VoiceConfigView.tsx:64`
- Decision: **distinct-domain-compositions** — These panels use the canonical Card boundary but retain unrelated search, connector, and release workflows.

### card: badge + button + card + checkbox + dialog + spinner

- `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:174`
- `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163`
- Decision: **distinct-domain-compositions** — The credential-pool card owns priority ordering, provider usage windows, credential repair, and enabled opacity; the connector card owns selection/default state, capability grants, privacy/purpose, sync identity, and independent busy transitions. Their shared status, editing, controls, and confirmation behavior already comes from canonical atoms, while a shared slot shell would hide distinct state machines without removing domain logic.

### card: button + input

- `ChoiceWidget` in `packages/ui/src/components/chat/widgets/ChoiceWidget.tsx:60`
- `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83`
- Decision: **distinct-domain-compositions** — Domain purchase, chat choice, and connector cards only coincide at a broad dependency signature.

### dialog: alert + button + card

- `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:57`
- `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:67`
- Decision: **distinct-domain-compositions** — The dialogs share canonical feedback and surface atoms while retaining unrelated validation, confirmation, and completion lifecycles.

### form: button + input

- `TriggerForm` in `packages/ui/src/components/pages/TriggerForm.tsx:231`
- `TagEditor` in `packages/ui/src/components/ui/tag-editor.tsx:29`
- Decision: **distinct-domain-compositions** — Trigger configuration and tag editing do not share a domain contract or meaningful layout beyond generic form controls.

### panel: badge + button + input

- `AgentSection` in `packages/ui/src/components/settings/cloud-panel/sections/AgentSection.tsx:109`
- `CloudAgentsSection` in `packages/ui/src/components/settings/CloudAgentsSection.tsx:77`
- Decision: **shared-lifecycle-owner** — The cloud-panel-owned useCloudAgentManagement pattern owns list refresh, create, rename, suspend/resume, delete polling, wake-and-switch, persistence, and notices; AgentSection and CloudAgentsSection are distinct presentation adapters with explicit management-token providers.

### panel: button + input

- `TelegramBotSetupPanel` in `packages/ui/src/components/connectors/TelegramBotSetupPanel.tsx:35`
- `ReleaseNotesSection` in `packages/ui/src/components/release-center/sections.tsx:241`
- Decision: **distinct-domain-compositions** — Search, connector setup, and release-note panels have different interaction and state contracts.

### row: button + card + statusDot

- `ChatConversationItem` in `packages/ui/src/components/composites/chat/chat-conversation-item.tsx:126`
- `SidebarRailItem` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:361`
- Decision: **distinct-domain-compositions** — Rail rows compose the same atomic status indicator while preserving domain-specific navigation and selection behavior.
