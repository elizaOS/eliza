# Mockoon coverage for LifeOps scenarios

This directory contains optional standalone Mockoon environments for external
HTTP boundaries that still use local fixture servers. `start-all.mjs` starts
the JSON environments in parallel; `stop-all.mjs` stops the recorded processes.
See `INVENTORY.md` for endpoint and environment-variable details.

## Personal Google Workspace boundary

Personal Gmail and Google Calendar are intentionally not part of this fleet.
Those account-scoped capabilities use the cloud-managed Google Workspace MCP,
and `../environments/cloud-managed.json` retains the deterministic OAuth
connection and agent-binding inventory used to test that control plane.

This retirement does not apply to Google Chat service-account delivery,
Maps/GenAI, or Google Fit. They remain explicit, independently owned Google
integrations and must not be routed through a personal Workspace REST mock.

Calendar scenarios that exercise durable cached events continue to seed the
repository cache directly through the scenario helpers. They do not require a
Google Calendar HTTP environment.

## Environments

| Environment | Port | Covered surface |
| --- | ---: | --- |
| `slack` | 18803 | Slack Web API messaging and lookup fixtures |
| `discord` | 18804 | Discord REST guild, channel, and message fixtures |
| `telegram` | 18805 | Telegram Bot API send, update, and identity fixtures |
| `github` | 18806 | GitHub REST repository, issue, pull request, and search fixtures |
| `notion` | 18807 | Notion search, page, block, and database fixtures |
| `twilio` | 18808 | Programmable Messaging and Voice fixtures |
| `plaid` | 18809 | Eliza Cloud-shaped Plaid relay fixtures |
| `apple-reminders` | 18810 | Local reminders bridge fixtures |
| `bluebubbles` | 18811 | BlueBubbles chat and text-message fixtures |
| `ntfy` | 18812 | Push publish fixture |
| `duffel` | 18813 | Air search, offer, and order fixtures |
| `anthropic` | 18814 | Anthropic failure-injection fixtures |
| `cerebras` | 18815 | OpenAI-compatible model and embedding fixtures |
| `eliza-cloud` | 18816 | Cloud auth, agent, billing, and relay fixtures |
| `spotify` | 18817 | Spotify profile and playback fixtures |
| `signal` | 18818 | signal-cli REST send and receive fixtures |

## Failure injection

Generated environments expose provider-shaped failure variants selected by
`X-Mockoon-Fault` or the `_fault` query parameter:

- `rate_limit`
- `auth_expired`
- `server_error`

Some environments add provider-specific variants. Inspect the JSON contract
before asserting an error body or retry header.

## Run the fleet

```sh
node packages/scenario-runner/test/mocks/mockoon/start-all.mjs
node packages/scenario-runner/test/mocks/mockoon/stop-all.mjs
```

The launcher deliberately excludes the retired `gmail.json` and
`calendar.json` names even if a stale local copy is present.

## Add an environment

1. Add its definition to `_generate.mjs` unless the environment requires a
   hand-authored contract.
2. Give it a unique loopback port and add it to the table above and
   `INVENTORY.md`.
3. Run `node packages/scenario-runner/test/mocks/mockoon/_generate.mjs`.
4. Start the environment and verify its happy path and each documented fault.
5. Add a focused contract test for any behavior consumed by repository code.

Do not add a Gmail or Google Calendar REST environment. Extend the
cloud-managed MCP boundary fixtures when personal Workspace coverage is needed.
