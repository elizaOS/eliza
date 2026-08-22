# Eliza App Remaining Launch Work

This is the actionable remainder of the Eliza App plan after the homepage,
release-data fallback, installer-script, and CI-gate work in this branch.

Status terms:

- `Repo-ready`: code or docs exist in this repo and local verification passes.
- `Repo-owned`: implementation can be completed in this repo without external
  accounts, hardware, or production credentials.
- `External blocker`: launch depends on hardware, app-store review, production
  credentials, phone numbers, release signing, or deployed cloud services.

## Product And Brand

| Requirement | Status | Remaining work |
|---|---:|---|
| Eliza App homepage tagline: "Your Eliza, everywhere." | Repo-ready | Keep the first viewport focused on app download and one personal agent. |
| Shared product switcher: ElizaOS, App, Cloud, Docs, GitHub | Repo-ready | Update URLs if final domains differ. |
| One taxonomy: ElizaOS, Eliza App, Eliza Cloud | Repo-ready | Keep docs and public copy aligned when Cloud/OS branches land. |
| One account identity across app, cloud, and OS | Repo-owned | Enforce account/session linking in Cloud and OS onboarding routes; fix identity projection reads/writes before messaging launch. |
| One agent per user | Repo-owned | Add a durable one-agent uniqueness gate at provisioning and make duplicate webhook/onboarding calls idempotent. |

## Downloads And Stores

| Requirement | Status | Remaining work |
|---|---:|---|
| macOS `.dmg` direct download | External blocker | Publish signed/notarized Apple Silicon and Intel DMGs to the GitHub release. |
| Windows `.exe` direct download | External blocker | Publish signed `ElizaOSApp-Setup*.exe` to the GitHub release. |
| Linux `.deb` direct download | External blocker | Publish release `.deb` to the GitHub release. |
| Linux `.rpm`, AppImage, `.tar.gz` | Repo-owned / external blocker | Ensure release jobs actually produce and attach the promised formats. The launch gate now requires all claimed desktop formats. |
| No dead fallback installer URLs | Repo-ready | Fallback cards open the GitHub releases page instead of guessed filenames. |
| Public deploy blocks without release assets | Repo-ready | `bun run check:release-data` fails until required artifacts exist. |
| App Store, Play Store, Mac App Store, Microsoft Store | External blocker | Create store listings, finish review, then replace disabled cards with real URLs and review status. |
| TestFlight first iOS path | External blocker | Configure Apple credentials, upload a beta build, and publish TestFlight status. |
| Android APK bridge | Repo-ready / external blocker | `bun run --cwd packages/app install:android:adb -- --build` handles local ADB installs. Android release CI now produces and attaches a signed QA APK beside the Play AAB when release signing credentials are available. |

## iOS Developer Install

| Requirement | Status | Remaining work |
|---|---:|---|
| Honest sideload copy | Repo-ready | Homepage warns that App Store/TestFlight is the normal path. |
| Developer sideload helper | Repo-ready | `bun run --cwd packages/app install:ios:sideload` checks Xcode/device prerequisites and opens the workspace; pass `-- --build-device` or `-- --build-sim` to build first. |
| Sideload smoke verification | External blocker | CI runs the developer-install preflight, but real install validation still requires a real iPhone or configured simulator with signing credentials. |
| Public iOS installer without Apple review | Not supported | Do not ship this. Use TestFlight/App Store for normal users. |

## Messaging Onboarding

| Requirement | Status | Remaining work |
|---|---:|---|
| Homepage entrypoints for iMessage, Discord, Telegram, WhatsApp | Repo-ready | Cards link into `/get-started?method=...`. |
| Shared stateless onboarding worker | Repo-owned | Finish structural handoff checks and route all unlinked messaging identities through the same worker. |
| Cerebras `gpt-oss-120b` onboarding model | External blocker | Configure production Cerebras credentials and verify worker routing. |
| Discord bot invite/onboarding | Repo-owned / external blocker | `bun run --cwd packages/cloud/shared preflight:messaging-gateways` exposes missing credentials; still need production OAuth/gateway deployment. |
| Telegram bot onboarding | Repo-owned / external blocker | Gateway preflight checks BotFather token and webhook secret; still need signed identity-link completion. |
| WhatsApp onboarding | External blocker | Gateway preflight checks Meta env; still need official WhatsApp Business Platform account, templates, and opt-in compliance. |
| iMessage | External blocker | Verify the native macOS connector on a signed-in Messages.app host and the Blooio hosted gateway with production credentials. |
| Transcript handoff into real agent | Repo-owned | Persist source platform, setup session, target agent, and copied transcript state. |

## Cloud Console And One-Agent Admin

| Requirement | Status | Remaining work |
|---|---:|---|
| "My Agent" tab in Cloud | Consolidated | Cloud agent management is mounted in the normal app shell at `/cloud/agents`; public handoffs use `cloud.eliza.app`. |
| Remove consumer generation studio/character chat from cloud console | Owned by Cloud stream | Verify route removals and sidebar state in Cloud PR. |
| API keys, docs, billing, settings, payment | Owned by Cloud stream | Verify developer dashboard routes after Cloud stream merges. |
| App connects to provisioned Cloud agent | Repo-owned / external blocker | End-to-end provision, auth link, and bridge URL smoke in deployed Cloud. |

## Release And CI

| Requirement | Status | Remaining work |
|---|---:|---|
| Homepage source checks + unified app build | Repo-ready | CI validates homepage source contracts and builds only `packages/app`. |
| Release-data contract | Repo-ready | `check:release-data` blocks deploy when metadata/artifacts are missing. |
| Release publication | Repo-ready | `.github/workflows/release.yaml` is the single manual npm release authority; desktop and store builds are operator-run evidence. |
| Checksums | Repo-ready / external blocker | Android release jobs now attach checksums for AAB/APK outputs. Desktop release assets still need consistently published checksums before `check:release-data` can require them globally. |
| Actual GitHub release assets | External blocker | Cut a release tag and run signed desktop/mobile jobs. |
| Store rollout metadata in homepage | Repo-ready / external blocker | Generated release data now carries store target status/review fields. Add real URLs only after store review approves them. |

## Verification Before Public Launch

Run these locally and in CI:

```bash
bun run --cwd packages/homepage typecheck
bun run --cwd packages/homepage test:e2e
bun run --cwd packages/homepage check:release-data
bun run --cwd packages/app build:web
```

Expected current state: the source checks pass; `check:release-data` fails until
real release assets exist. That failure is the correct public-launch blocker.
