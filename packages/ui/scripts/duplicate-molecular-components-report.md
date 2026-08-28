# Molecular component duplicate inventory

Scanned 897 maintained React files. 103 exported compositions have a recognized molecular role and at least two atomic dependencies.

Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.

## Canonical molecule contracts

These owners are fail-closed contracts. The audit fails if an owner disappears, drops a required canonical atom, loses a named consumer, or loses its rendered story or behavioral test.

| Contract | Canonical owner | Maintained references | Representative proof | Responsibility |
| --- | --- | ---: | --- | --- |
| auth-result-shell | `AuthResultShell` in `packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.tsx` | 2 | `packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.stories.tsx`<br>`packages/ui/src/cloud/public-pages/pages/auth/auth-result-shell.test.tsx` | Full-page surface, centered card, and content geometry for authentication results. |
| connection-capability-tile | `ConnectionCapabilityTile` in `packages/ui/src/cloud/connectors/connection-capability-tile.tsx` | 2 | `packages/ui/src/cloud/connectors/connection-capability-tile.stories.tsx`<br>`packages/ui/src/cloud/connectors/connection-capability-tile.test.tsx` | Icon, title, and description hierarchy for connector capability grids. |
| content-state | `ContentState` in `packages/ui/src/components/composites/page-panel/content-state.tsx` | 2 | `packages/ui/src/components/composites/page-panel/content-state.stories.tsx`<br>`packages/ui/src/components/composites/page-panel/content-state.test.tsx` | Empty and loading presentation inside page-panel placements. |
| settings-row | `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx` | 42 | `packages/ui/src/components/settings/settings-layout.stories.tsx`<br>`packages/ui/src/components/settings/settings-layout.test.tsx` | Label, description, control, and navigation alignment for settings. |
| action-list-row | `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx` | 2 | `packages/ui/src/components/shared/ActionListRow.stories.tsx`<br>`packages/ui/src/components/shared/ActionListRow.test.tsx` | Button, link, and static list rows with shared content slots. |

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
- `SettingsRow` in `packages/ui/src/components/settings/settings-layout.tsx:298`
- `ActionListRow` in `packages/ui/src/components/shared/ActionListRow.tsx:115`
- `ReasoningCell` in `plugins/plugin-task-coordinator/src/orchestrator-reasoning.tsx:96`
- Fingerprint: `sha256:fd78fc85a90ee454e7e021a6637ca7d81c7d1c48cd9491e96b99f3175784a020`
- Decision: **distinct-domain-compositions**. Sidebar and settings rows share atomic controls but own different selection, status, and lifecycle contracts.

### dialog: button + dialog

- `EditSkillModal` in `packages/ui/src/components/pages/skill-detail-panel.tsx:35`
- `ConfirmDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:35`
- `EventEditorDrawer` in `plugins/plugin-calendar/src/components/EventEditorDrawer.tsx:469`
- Fingerprint: `sha256:947ceb36e16ef7a3aa4c0573a96769b3876c58f6564e858ac1f3bbb636e997ed`
- Decision: **distinct-domain-compositions**. The three dialogs own unrelated editing, confirmation, and calendar workflows.

### dialog: button + dialog + input

- `SaveCommandModal` in `packages/ui/src/components/chat/SaveCommandModal.tsx:37`
- `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41`
- `PromptDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:95`
- Fingerprint: `sha256:00ceb89f6fe73868413b0028529b0ad6edf2af5297e2c21084e59cc1026a2e7d`
- Decision: **distinct-domain-compositions**. Command persistence, conversation renaming, and generic prompting have different validation, pending, error, and result contracts. Their stable shared behavior already belongs to Dialog, Input, and Button.

### list: badge + button + card

- `CredentialsList` in `packages/ui/src/cloud/organization/credentials-list.tsx:78`
- `MembersList` in `packages/ui/src/cloud/organization/members-list.tsx:53`
- `PendingInvitesList` in `packages/ui/src/cloud/organization/pending-invites-list.tsx:42`
- Fingerprint: `sha256:c31d0df24a1084c39b7dbc6d355666c54d88f8166c02a6a55bba547b6e91f30a`
- Decision: **distinct-domain-compositions**. The lists share canonical status, action, and surface atoms, but their item identity, loading, selection, and mutation contracts remain domain-specific.

### panel: button + card + input

- `MessageSearchPanel` in `packages/ui/src/components/chat/message-search/MessageSearchPanel.tsx:50`
- `TelegramAccountConnectorPanel` in `packages/ui/src/components/connectors/TelegramAccountConnectorPanel.tsx:72`
- `DesktopTalkModePanel` in `packages/ui/src/components/settings/VoiceConfigView.tsx:64`
- Fingerprint: `sha256:f7345abc1428d196ccedee6737be18b6f42af9f022aad9cb9a0d948ad8c6be6d`
- Decision: **distinct-domain-compositions**. These panels use the canonical Card boundary but retain unrelated search, connector, and release workflows.

### card: badge + button + card + checkbox + dialog + spinner

- `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:174`
- `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163`
- Fingerprint: `sha256:4250aea273e79d484e15009ef24f27ec2e4ef7ffb9c3a9a50df793e44e46938a`
- Decision: **distinct-domain-compositions**. The credential-pool card owns priority ordering, provider usage windows, credential repair, and enabled opacity; the connector card owns selection/default state, capability grants, privacy/purpose, sync identity, and independent busy transitions. Their shared status, editing, controls, and confirmation behavior already comes from canonical atoms, while a shared slot shell would hide distinct state machines without removing domain logic.

### card: button + input

- `ChoiceWidget` in `packages/ui/src/components/chat/widgets/ChoiceWidget.tsx:60`
- `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83`
- Fingerprint: `sha256:d117c0f4416d00578f8951dea1438e1314848151b99ba8432591a7f77bb3d93b`
- Decision: **distinct-domain-compositions**. Domain purchase, chat choice, and connector cards only coincide at a broad dependency signature.

### dialog: alert + button + card

- `ContributeCredentialDialog` in `packages/ui/src/cloud/organization/contribute-credential-dialog.tsx:56`
- `InviteMemberDialog` in `packages/ui/src/cloud/organization/invite-member-dialog.tsx:66`
- Fingerprint: `sha256:d79bada7a8fe1a7748f1f3ed393b0ad8b5ea866611e2a11e24b9ad1b779b20c6`
- Decision: **distinct-domain-compositions**. The dialogs share canonical feedback and surface atoms while retaining unrelated validation, confirmation, and completion lifecycles.

### form: button + input

- `TriggerForm` in `packages/ui/src/components/pages/TriggerForm.tsx:231`
- `TagEditor` in `packages/ui/src/components/ui/tag-editor.tsx:29`
- Fingerprint: `sha256:ecc864434687a7ce763252d359cad9bdb85db187f1defa060a767d5e5df45290`
- Decision: **distinct-domain-compositions**. Trigger configuration and tag editing do not share a domain contract or meaningful layout beyond generic form controls.

### panel: badge + button + input

- `AgentSection` in `packages/ui/src/components/settings/cloud-panel/sections/AgentSection.tsx:109`
- `CloudAgentsSection` in `packages/ui/src/components/settings/CloudAgentsSection.tsx:77`
- Fingerprint: `sha256:f0e0a109e0fab258115f7e1cc83319bae2890d554c23083a69f95a6700db6757`
- Decision: **shared-lifecycle-owner**. The cloud-panel-owned useCloudAgentManagement pattern owns list refresh, create, rename, suspend/resume, delete polling, wake-and-switch, persistence, and notices; AgentSection and CloudAgentsSection are distinct presentation adapters with explicit management-token providers.

### panel: button + input

- `TelegramBotSetupPanel` in `packages/ui/src/components/connectors/TelegramBotSetupPanel.tsx:35`
- `ReleaseNotesSection` in `packages/ui/src/components/release-center/sections.tsx:241`
- Fingerprint: `sha256:7c11e8d4a6401f86006252780a6d7d428dc8d5ade6007d697bf320b213c709af`
- Decision: **distinct-domain-compositions**. Search, connector setup, and release-note panels have different interaction and state contracts.

### row: button + card + statusDot

- `ChatConversationItem` in `packages/ui/src/components/composites/chat/chat-conversation-item.tsx:126`
- `SidebarRailItem` in `packages/ui/src/components/composites/sidebar/sidebar-content.tsx:361`
- Fingerprint: `sha256:f6d48d195f3dd4ea624645beeb9ab2db5ffd4c892685663a2498a8d0a9bfda91`
- Decision: **distinct-domain-compositions**. Rail rows compose the same atomic status indicator while preserving domain-specific navigation and selection behavior.
