# Trigger Schema Capture Guide

This guide explains how to add new trigger output schemas to the plugin. Trigger schemas tell the LLM what fields a trigger node outputs (e.g., `$json.body.repository.name` for a GitHub push event), so it can generate correct `$json` expressions in downstream nodes.

## How It Works

The trigger schema pipeline has two parts:

1. **Manual setup (you do this once per integration)**: create credentials on n8n, complete OAuth in the UI, create a `[Schema Capture]` workflow, and trigger one successful execution.
2. **CI automation (runs automatically after that)**: every Monday (and on every push/publish), CI re-captures schemas from existing workflows and publishes updates if anything changed.

You only need to do the manual setup when adding a **new** integration. Everything after that is handled by CI.

## CI Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `schema-update.yml` | Every Monday 3 AM UTC + manual dispatch | Runs `bun run crawl` (including `crawl-triggers-live.ts --from-existing`). If schemas changed vs. latest npm release, auto-bumps version and triggers publish. |
| `ci.yml` | Every push / PR | Runs `bun run crawl` + tests + build |
| `npm-deploy.yml` | Push to main (if version changed) + manual dispatch | Runs `bun run crawl` + build + publish to npm |

All CI workflows use `WORKFLOW_HOST` and `WORKFLOW_API_KEY` from GitHub Secrets, pointing to the `service-n8n@elizalabs.ai` n8n account.

---

## Manual Setup: Adding a New Trigger Integration

### Prerequisites

| Requirement | Where to find it |
|---|---|
| `WORKFLOW_HOST` | `https://elizaapp.app.n8n.cloud` |
| `WORKFLOW_API_KEY` | 1Password — search for the `service-n8n@elizalabs.ai` n8n API key |
| OAuth credentials | Pull from Vercel (see below) or 1Password |
| [Bun](https://bun.sh) | Runtime for running scripts locally |

### Step 0: Set up `.env`

The script needs `WORKFLOW_HOST` + `WORKFLOW_API_KEY` to talk to n8n, and optionally OAuth client ID/secret per platform (so credentials are pre-populated instead of using n8n defaults).

The easiest way to get all env vars is to pull them from Vercel (eliza-cloud-v2 has all OAuth credentials):

```bash
cd /path/to/eliza-cloud-v2
vercel env pull /path/to/plugin-workflow/.env --yes
```

Or manually create `.env` at the project root:

```bash
# Required
WORKFLOW_HOST=https://elizaapp.app.n8n.cloud
WORKFLOW_API_KEY=xxx

# Optional — OAuth credentials (script falls back to n8n cloud defaults if missing)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
# ... etc for each platform
```

Bun auto-loads `.env` from the project root.

### Step 1: Create Credentials on n8n

```bash
bun run scripts/create-credentials.ts
```

The script:
- Auto-discovers OAuth2 trigger credential types from `defaultNodes.json`
- Only creates credentials for eliza-cloud supported platforms (Google, Microsoft, GitHub, Linear, Slack, Notion, Twitter, Asana, Salesforce, Airtable, Jira, Dropbox, Zoom, LinkedIn)
- Uses OAuth client ID/secret from `.env` if available, otherwise falls back to n8n cloud defaults
- **Persists credential IDs to `.credentials-map.json`** (git-ignored, used by `crawl-triggers-live.ts`)
- Idempotent — skips credentials that already exist in the local map

Useful flags:

```bash
bun run scripts/create-credentials.ts --list         # list credentials from local map
bun run scripts/create-credentials.ts --delete-all   # delete all credentials from n8n + local map
bun run scripts/create-credentials.ts --dry-run      # show what would be created
bun run scripts/create-credentials.ts --filter=gmail  # only create credentials matching "gmail"
```

### Step 2: Connect in the n8n UI

For each created credential, go to the n8n UI and click "Connect":

1. Open `https://elizaapp.app.n8n.cloud` (log in as `service-n8n@elizalabs.ai`)
2. Go to **Credentials** (left sidebar)
3. Click on the `[Auto]` credential
4. Click **Sign in with [Service]** / **Connect**
5. Verify it shows "Connected"

The script prints direct URLs to each credential after creation.

### Step 3: Create the Capture Workflow and Trigger an Event

Create the `[Schema Capture]` workflow on n8n:

```bash
bun run scripts/crawl-triggers-live.ts --trigger=linear --create-only --keep
```

This creates a test workflow (Trigger → NoOp) on n8n using the credential IDs from `.credentials-map.json`. Open the n8n UI and verify it looks correct.

Activate and wait for an event:

```bash
bun run scripts/crawl-triggers-live.ts --trigger=linear --keep --timeout=60
```

While the script is waiting:
- For **webhook triggers** (GitHub, Linear, Slack): trigger an event NOW from the service (push a commit, create an issue, send a message, etc.)
- For **polling triggers** (Gmail, Google Calendar, Google Drive): the data just needs to exist or change within the poll interval

The script captures the output schema from the first successful execution.

### That's It

After this, CI handles everything automatically:
- Weekly schema recapture from existing `[Schema Capture]` workflows
- Auto-publish if schemas change

No code changes needed — `.credentials-map.json` is git-ignored and CI discovers workflows by name.

---

## Currently Captured Triggers

| Trigger | Status |
|---|---|
| `githubTrigger` | Captured |
| `gmailTrigger` | Captured |
| `googleCalendarTrigger` | Captured |
| `googleDriveTrigger` | Captured |
| `googleSheetsTrigger` | Captured |
| `googleBusinessProfileTrigger` | Workflow created |
| `airtableTrigger` | Workflow created |
| `asanaTrigger` | Workflow created |
| `linearTrigger` | Workflow created |
| `microsoftOneDriveTrigger` | Workflow created |
| `microsoftOutlookTrigger` | Workflow created |
| `microsoftTeamsTrigger` | Workflow created |
| `salesforceTrigger` | Workflow created |

---

## Script Reference

### `scripts/create-credentials.ts`

Auto-discovers trigger credential types from `defaultNodes.json`, creates them on n8n with OAuth client ID/secret from `.env` (or n8n defaults), and persists IDs to `.credentials-map.json`.

```bash
bun run scripts/create-credentials.ts
```

| Flag | Description |
|---|---|
| `--list` | List credentials from local `.credentials-map.json` |
| `--delete-all` | Delete all credentials from n8n and local map |
| `--dry-run` | Show what would be created without creating |
| `--filter=xxx` | Only create credentials matching this name |

### `scripts/crawl-triggers-live.ts`

Captures trigger output schemas from real n8n executions. Reads credential IDs from `.credentials-map.json`.

```bash
WORKFLOW_HOST=... WORKFLOW_API_KEY=... bun run scripts/crawl-triggers-live.ts [options]
```

| Flag | Description |
|---|---|
| `--trigger=name` | Only capture triggers matching this name |
| `--timeout=60` | Max seconds to wait per trigger (default: 30) |
| `--keep` | Don't delete test workflows after capture |
| `--create-only` | Create workflows but don't activate them |
| `--from-existing` | Only capture from existing `[Schema Capture]` workflows (used by CI) |

### `bun run crawl`

Master script that runs all three crawl steps:
1. `crawl-nodes.ts` → `src/data/defaultNodes.json`
2. `crawl-output-schemas.ts` → `src/data/schemaIndex.json`
3. `crawl-triggers-live.ts --from-existing` → `src/data/triggerSchemaIndex.json`

---

## Troubleshooting

### "No execution data (timeout)"
The trigger didn't fire within the timeout. For webhook triggers, make sure you trigger an event **after** the workflow is activated. Increase with `--timeout=120`.

### "ERROR creating: 400"
Credential not found or missing trigger parameters. Check `.credentials-map.json` has the right IDs. Use `--create-only` to create the workflow, then inspect it in the n8n UI.

### OAuth2 credential shows "Not connected"
Complete the OAuth flow in the n8n UI. Make sure the callback URL (`https://oauth.n8n.cloud/oauth2/callback`) is configured in the service's developer console.

### "No credentials in .credentials-map.json"
Run `create-credentials.ts` first to create credentials and populate the local map.

### Schema has very few fields
Some triggers simplify their output. The captured schema reflects actual output after transformations — this is correct.
