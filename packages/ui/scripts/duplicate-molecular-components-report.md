# Molecular component duplicate inventory

Scanned 926 maintained React files. 68 exported compositions have a recognized molecular role and at least two atomic dependencies.

Clusters share both a role and an atomic dependency signature. Detection creates a review queue; this committed report contains only final dispositions based on product behavior, state ownership, and responsive layout.

| Role | Atomic dependencies | Components | Decision |
| --- | --- | ---: | --- |
| dialog | button, dialog | 6 | distinct-domain-compositions |
| dialog | button, dialog, input | 4 | distinct-domain-compositions |
| panel | button, input | 4 | distinct-domain-compositions |
| card | button, input | 3 | distinct-domain-compositions |
| card | badge, button, checkbox, dialog, spinner | 2 | distinct-domain-compositions |
| dialog | button, input | 2 | distinct-domain-compositions |
| form | button, input | 2 | distinct-domain-compositions |
| header | button, input | 2 | distinct-domain-compositions |
| panel | badge, button, input | 2 | shared-lifecycle-owner |

## Reviewed clusters

### dialog: button + dialog

- `PluginSettingsDialog` in `packages/ui/src/components/pages/plugin-view-dialogs.tsx:68`
- `EditSkillModal` in `packages/ui/src/components/pages/skill-detail-panel.tsx:35`
- `InstallModal` in `packages/ui/src/components/pages/skill-installer.tsx:16`
- `CloudModal` in `packages/ui/src/components/settings/cloud-panel/cloud-settings-primitives.tsx:556`
- `ConfirmDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:35`
- `EventEditorDrawer` in `plugins/plugin-calendar/src/components/EventEditorDrawer.tsx:469`
- Decision: **distinct-domain-compositions** — The shared atoms describe ordinary modal chrome; the six components own unrelated workflows and state.

### dialog: button + dialog + input

- `WithdrawDialog` in `packages/ui/src/cloud/applications/components/withdraw-dialog.tsx:45`
- `SaveCommandModal` in `packages/ui/src/components/chat/SaveCommandModal.tsx:37`
- `ChatConversationRenameDialog` in `packages/ui/src/components/composites/chat/chat-conversation-rename-dialog.tsx:41`
- `PromptDialog` in `packages/ui/src/components/ui/confirm-dialog.tsx:100`
- Decision: **distinct-domain-compositions** — Withdrawal, command persistence, conversation renaming, and generic prompting have different validation, pending, error, and result contracts; their only stable shared behavior already belongs to the canonical Dialog, Input, and Button atoms.

### panel: button + input

- `MessageSearchPanel` in `packages/ui/src/components/chat/message-search/MessageSearchPanel.tsx:49`
- `TelegramAccountConnectorPanel` in `packages/ui/src/components/connectors/TelegramAccountConnectorPanel.tsx:71`
- `TelegramBotSetupPanel` in `packages/ui/src/components/connectors/TelegramBotSetupPanel.tsx:34`
- `ReleaseNotesSection` in `packages/ui/src/components/release-center/sections.tsx:241`
- Decision: **distinct-domain-compositions** — Search, connector setup, and release-note panels have different interaction and state contracts.

### card: button + input

- `BuyDomainCard` in `packages/ui/src/cloud/applications/components/BuyDomainCard.tsx:68`
- `ChoiceWidget` in `packages/ui/src/components/chat/widgets/ChoiceWidget.tsx:60`
- `ConnectorCardWidget` in `packages/ui/src/components/chat/widgets/connector-card.tsx:83`
- Decision: **distinct-domain-compositions** — Domain purchase, chat choice, and connector cards only coincide at a broad dependency signature.

### card: badge + button + checkbox + dialog + spinner

- `AccountCard` in `packages/ui/src/components/accounts/AccountCard.tsx:178`
- `ConnectorAccountCard` in `packages/ui/src/components/connectors/ConnectorAccountCard.tsx:163`
- Decision: **distinct-domain-compositions** — The credential-pool card owns priority ordering, provider usage windows, credential repair, and enabled opacity; the connector card owns selection/default state, capability grants, privacy/purpose, sync identity, and independent busy transitions. Their shared status, editing, controls, and confirmation behavior already comes from canonical atoms, while a shared slot shell would hide distinct state machines without removing domain logic.

### dialog: button + input

- `AccountDeletionDialog` in `packages/ui/src/cloud/account-security/components/account-deletion-dialog.tsx:30`
- `SigninSheet` in `packages/ui/src/components/settings/vault-tabs/OverviewTab.tsx:921`
- Decision: **distinct-domain-compositions** — Account deletion and sign-in are unrelated workflows despite using the same atoms.

### form: button + input

- `TriggerForm` in `packages/ui/src/components/pages/TriggerForm.tsx:229`
- `TagEditor` in `packages/ui/src/components/ui/tag-editor.tsx:29`
- Decision: **distinct-domain-compositions** — Trigger configuration and tag editing do not share a domain contract or meaningful layout beyond generic form controls.

### header: button + input

- `SidebarSearchBar` in `packages/ui/src/components/composites/search/searchbar.tsx:19`
- `MeetingJoinBar` in `packages/ui/src/components/transcripts/MeetingJoinBar.tsx:43`
- Decision: **distinct-domain-compositions** — Search navigation and meeting join controls have unrelated behavior; the role-name match is superficial.

### panel: badge + button + input

- `AgentSection` in `packages/ui/src/components/settings/cloud-panel/sections/AgentSection.tsx:109`
- `CloudAgentsSection` in `packages/ui/src/components/settings/CloudAgentsSection.tsx:77`
- Decision: **shared-lifecycle-owner** — The cloud-panel-owned useCloudAgentManagement pattern owns list refresh, create, rename, suspend/resume, delete polling, wake-and-switch, persistence, and notices; AgentSection and CloudAgentsSection are distinct presentation adapters with explicit management-token providers.
