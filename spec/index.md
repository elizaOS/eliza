# Eliza

Eliza is an agent runtime and the packages a product builds on it: the
kernel, the on-device agent, the Android device package, the hosted cloud
services and the assistant plugins. Each package is specified top-down here
before its VibeLang and Effect implementation: stories, then rules, then the
Quint model that the generated code and proofs come from. A change to Eliza
starts in this tree.

Agents run on the owner's device. The cloud hosts no agent; it serves
identity, accounts, billing and the metered services the on-device agent
calls. Products compose these packages and keep their own interfaces,
branding and deployments. A product's cloud deployment runs the cloud
package with its own deployment profile. Eliza names no product: what a
product needs is stated as a generic capability of the package that owns it,
and [consumer contracts](./core/consumerContracts.md) state how a consumer's
recorded imports are traced to an owning rule. Each record and state machine
has one owner. Base specs import across packages in this direction: os →
agent → cloud → core. Plugin specs may import an owning rule or policy
where ownership stays acyclic. Base packages never import plugins.

| Package | Specification |
| --- | --- |
| `@elizaos/core` | [Kernel](./core/) |
| `@elizaos/agent` | [On-device agent: the Node process that runs one owner's agent, its local API, and the client and voice libraries that screens use](./agent/) |
| `@elizaos/os` | [Android device: the agent service, device sign-in and credential custody, native bridges, device audio and listener, browser, and the image, APK and update build library](./os/) |
| `@elizaos/cloud` | [Hosted services: identity and sessions, native clients and device keys, billing and entitlements, metered inference, speech and maps, managed Google, and the client that devices use](./cloud/) |
| `@elizaos/plugin-workflow` | [Workflows](./workflow/) |
| `@elizaos/plugin-browser` | [Browser automation](./browser/) |
| `@elizaos/plugin-calendar` | [Calendar](./calendar/) |
| `@elizaos/plugin-inbox` | [Inbox](./inbox/) |
| `@elizaos/plugin-notes` | [Notes](./notes/) |
| `@elizaos/plugin-maps` | [Maps](./maps/) |
| `@elizaos/plugin-files` | [Files](./files/) |
| `@elizaos/plugin-personal-assistant` | [Personal assistance](./assistant/) |
| `@elizaos/plugin-local-inference` | [Local inference](./localInference/) |

The optional integrations and native bridge contracts are specified below.

| Package | Specification |
| --- | --- |
| `@elizaos/plugin-agent-orchestrator` | [Agent orchestration](./agentOrchestrator/) |
| `@elizaos/plugin-anthropic` | [Anthropic inference](./anthropic/) |
| `@elizaos/plugin-blocker` | [Focus blocking](./blocker/) |
| `@elizaos/plugin-coding-tools` | [Workspace coding tools](./codingTools/) |
| `@elizaos/plugin-computeruse` | [Computer use sessions](./computerUse/) |
| `@elizaos/plugin-discord` | [Discord](./discord/) |
| `@elizaos/plugin-elizacloud` | [Eliza Cloud plugin](./elizaCloud/) |
| `@elizaos/plugin-embeddings` | [OpenAI-compatible embeddings](./embeddings/) |
| `@elizaos/plugin-form` | [Conversational forms](./form/) |
| `@elizaos/plugin-github` | [GitHub](./github/) |
| `@elizaos/plugin-goals` | [Goals and check-in views](./goals/) |
| `@elizaos/plugin-google-workspace` | [Google Workspace connections](./googleWorkspace/) |
| `@elizaos/plugin-health` | [Health and activity observations](./health/) |
| `@elizaos/plugin-imessage` | [iMessage](./imessage/) |
| `@elizaos/plugin-knowledge` | [Knowledge document views](./knowledge/) |
| `@elizaos/plugin-mcp` | [MCP capabilities](./mcp/) |
| `@elizaos/plugin-meetings` | [Meeting transcription](./meetings/) |
| `@elizaos/capacitor-action-journal` | [Native action journal](./nativeActionJournal/) |
| `@elizaos/native-activity-tracker` | [Native activity tracker](./nativeActivityTracker/) |
| `@elizaos/capacitor-agent` | [Native agent bridge](./nativeAgent/) |
| `@elizaos/capacitor-appblocker` | [Native app blocking](./nativeAppblocker/) |
| `@elizaos/capacitor-calendar` | [Native calendar](./nativeCalendar/) |
| `@elizaos/capacitor-camera` | [Native camera](./nativeCamera/) |
| `@elizaos/capacitor-canvas` | [Native canvas](./nativeCanvas/) |
| `@elizaos/plugin-native-contacts` | [Native contacts](./nativeContacts/) |
| `@elizaos/capacitor-desktop` | [Native desktop](./nativeDesktop/) |
| `@elizaos/capacitor-eliza-tasks` | [Native background tasks](./nativeElizaTasks/) |
| `@elizaos/plugin-native-filesystem` | [Native filesystem](./nativeFilesystem/) |
| `@elizaos/capacitor-gateway` | [Native gateway](./nativeGateway/) |
| `@elizaos/capacitor-location` | [Native location](./nativeLocation/) |
| `@elizaos/capacitor-owned-media` | [Native media](./nativeMedia/) |
| `@elizaos/plugin-native-messages` | [Native messages](./nativeMessages/) |
| `@elizaos/capacitor-mobile-signals` | [Native mobile signals](./nativeMobileSignals/) |
| `@elizaos/capacitor-network-policy` | [Native network cost hints](./nativeNetworkPolicy/) |
| `@elizaos/capacitor-notification-mirror` | [Native notifications](./nativeNotifications/) |
| `@elizaos/capacitor-passwords` | [Native passwords](./nativePasswords/) |
| `@elizaos/plugin-native-phone` | [Native phone](./nativePhone/) |
| `@elizaos/macosreminders` | [Native reminders](./nativeReminders/) |
| `@elizaos/capacitor-secure-store` | [Native secure store](./nativeSecureStore/) |
| `@elizaos/plugin-native-settings` | [Native settings](./nativeSettings/) |
| `@elizaos/native-plugin-shared-types` | [Native plugin shared types](./nativeSharedTypes/) |
| `@elizaos/capacitor-swabble` | [Native wake detection](./nativeSwabble/) |
| `@elizaos/capacitor-system` | [Native system capabilities](./nativeSystem/) |
| `@elizaos/capacitor-talkmode` | [Native talk mode](./nativeTalkmode/) |
| `@elizaos/capacitor-websiteblocker` | [Native website blocking](./nativeWebsiteblocker/) |
| `@elizaos/plugin-native-wifi` | [Native Wi-Fi](./nativeWifi/) |
| `@elizaos/plugin-network` | [Network](./network/) |
| `@elizaos/plugin-openai` | [OpenAI-compatible inference](./openai/) |
| `@elizaos/plugin-pdf` | [PDF extraction](./pdf/) |
| `@elizaos/plugin-pty` | [Interactive terminals](./pty/) |
| `@elizaos/plugin-relationships` | [Relationship graph](./relationships/) |
| `@elizaos/plugin-reminders` | [Reminder delivery records](./reminders/) |
| `@elizaos/plugin-scheduling` | [Scheduled task delivery](./scheduling/) |
| `@elizaos/plugin-slack` | [Slack](./slack/) |
| `@elizaos/plugin-sql` | [PostgreSQL and PGlite persistence](./sql/) |
| `@elizaos/plugin-sqlite` | [Per-agent SQLite persistence](./sqlite/) |
| `@elizaos/plugin-telegram` | [Telegram](./telegram/) |
| `@elizaos/plugin-todos` | [To-do storage and views](./todos/) |
| `@elizaos/plugin-trajectory-logger` | [Trajectory inspector](./trajectoryLogger/) |
| `@elizaos/plugin-video` | [Video processing](./video/) |
| `@elizaos/plugin-vision` | [Vision](./vision/) |
| `@elizaos/plugin-wallet` | [Wallet](./wallet/) |
| `@elizaos/plugin-web-search` | [Web search](./webSearch/) |
| `@elizaos/plugin-x` | [X](./x/) |

Eliza has no shared user interface, training, benchmark, testing or script
package. `packages/ui` and `packages/design-system` are the toolchain's
private React components and design tokens, not a published Eliza package.
Cloud-hosted user applications, cloud-run agents, sandboxes and remote
pairing to a hosted agent are not part of Eliza.
