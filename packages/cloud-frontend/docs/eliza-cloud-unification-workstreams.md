# Eliza Cloud Unification Workstreams

This is the implementation brief for unifying Eliza Cloud, Eliza App, ElizaOS, and the shared UI system. It keeps the Cloud product focused on hosted agent runtime while preserving links into the app and operating system offerings.

## Product Architecture

ElizaOS Platform is one agent platform available as:

- **ElizaOS**: full operating system for devices that run themselves.
- **Eliza App**: desktop and mobile app for everyday use.
- **Eliza Cloud**: hosted agent runtime, dashboard, API, billing, and deployment.

All three products share:

- One account identity.
- One Tailwind/design-token system.
- One component library from `@elizaos/ui`.
- One product switcher: ElizaOS, App, Cloud, Docs, GitHub.
- Orange primary actions over the default Eliza sky/glass visual system.

## Pushback And Product Guardrails

The plan is directionally strong, but a few boundaries need to stay explicit:

- **Do not make Cloud a second consumer app.** Cloud should offer a direct path to chat with "My Agent", but the full consumer chat experience should live in Eliza App. Cloud is the hosted runtime and console.
- **Do not collapse agent concepts without a migration plan.** The repo has `eliza/agents`, provisioning agents, containers, app agents, and character-library language. Cloud UX can rename the top-level product to "My Agent", but API and database concepts need a deliberate cleanup.
- **Do not delete media/generation APIs casually.** Removing Studio from the dashboard does not automatically mean removing public media API routes; they may still be API products, legacy routes, or billing surfaces.
- **Do not market ElizaOS as a Mac app.** Mac hardware support is specialized OS support for selected Intel/M1/M2 targets, not a normal `.dmg` app.
- **Do not ship billing as a single balance.** Credits, active runtime billing, app monetization, earnings, affiliate markup, invoices, and AI provider markup are different ledgers.
- **Do not promise one identity until Cloud, App, CLI, mobile, local runtime, and plugin auth are mapped.** Current auth spans Steward, local sessions, pairing, API keys, and plugin-stored keys.

## Eliza Cloud Workstreams

### 1. Shared UI System

Acceptance criteria:

- `cloud-ui` brand primitives are available from the main `@elizaos/ui` export path.
- Cloud frontend imports shared components from `@elizaos/ui`, not local copies.
- Cloud, App, docs, dashboard, login, and landing pages use the same sky/orange tokens.
- Dark Cloud-era token defaults are removed or isolated behind an explicit theme.

### 2. Cloud Homepage

Primary job:

- Convert anonymous users into Cloud users who log in and run a hosted agent.

Required messaging:

- Tagline: "Run your agent instantly in the cloud."
- Primary CTA: "Run in cloud."
- Secondary CTAs: "Download the app" and "Install ElizaOS."
- Product switcher: ElizaOS, App, Cloud, Docs, GitHub.

### 3. Login And Account Identity

Acceptance criteria:

- Login copy is Cloud-specific: deploy, manage, and connect hosted Eliza agents.
- Account identity copy does not imply identity unification is complete until App/Cloud/OS auth boundaries are reconciled.
- CLI login, API key creation, and app pairing remain visible from the console.

### 4. My Agent

Primary job:

- Give the user one obvious place to administer their running hosted agent and open it in the full Eliza experience.

Required sections:

- Agent runtime status.
- Open agent chat / go to my agent.
- Connect Eliza App devices.
- API keys.
- Billing and credits.
- Docs and quickstart.
- Containers / runtime instances.
- MCP and integrations.

### 5. Developer Dashboard

Keep:

- Docs.
- API explorer.
- API reference/docs for API.
- API keys.
- Monetization.
- Billing and payments.
- Settings.
- Account.
- Runtime instances.
- Containers.
- MCPs.
- Apps and app monetization.
- Admin-only infrastructure, metrics, moderation, and redemptions.

Remove from primary dashboard navigation:

- Generation Studio.
- Character chat as a dashboard tab.
- Image/video/voice/gallery as consumer creation tabs.

Keep as redirects or API docs where needed:

- Legacy dashboard media routes should redirect to API Explorer.
- Public API media docs may remain if they are still supported API products.

### 6. Docs

Acceptance criteria:

- Docs reflect Cloud as runtime/API/billing/agent management.
- Quickstart starts with login, dashboard, API keys, CLI/cloud deploy, and App connection.
- Media generation docs are API reference pages, not top-level product tabs.
- Docs use the same light glass design and remain readable.

### 7. Release And Deployment

For Cloud:

- Build Cloud frontend successfully.
- Browser-check `/`, `/login`, `/docs`, `/dashboard`, `/dashboard/my-agents`.
- Keep `elizacloud.ai` and `eliza.cloud` ready for hosted runtime/dashboard.

For OS handoff:

- Add a Cloud-side `/os` landing route that can be deployed behind `os.elizacloud.ai`.
- Link it from Cloud as "Install ElizaOS" until `elizaos.ai` is fully connected.

## ElizaOS Handoff Requirements

ElizaOS positioning:

> The agentic operating system for devices that run themselves.

Download targets:

| Target | Artifact |
| --- | --- |
| Linux bare metal | ISO + USB installer |
| Linux VM | VM image + helper GUI + CLI tools |
| Windows host | VM bundle for Windows |
| macOS host | VM bundle for Mac |
| Linux host | VM bundle for Linux |
| Android | APK / AOSP image |
| Mac hardware | Asahi-style Linux build for supported Intel/M1/M2 Macs only |
| Developers | Dockerfiles, install scripts, build docs |

Required wording:

> Supported Mac hardware is limited. Apple Silicon support currently targets selected M1/M2 devices. Newer Macs may not be supported.

Required guardrail:

- Do not market ElizaOS as a normal Mac app. It is a specialized OS build.

## Research Notes

Primary references reviewed:

- Current ElizaOS website and docs.
- Current Eliza Cloud public positioning.
- GitHub org/repo status for `elizaOS/eliza`.
- LangGraph/LangSmith, Mastra Platform, OpenAI traces/evals, Vercel AI Gateway, Dify, and AutoGen Studio patterns.

Useful UX synthesis:

- Cloud should center on `Project -> My Agent -> Runs/Traces -> Deployments -> API Keys -> Billing`.
- The strongest differentiator is portability: Cloud should feel like managed ElizaOS, not a closed builder.
