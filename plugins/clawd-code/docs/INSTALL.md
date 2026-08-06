# Install and Smoke Test

This checkout is the Clawd Code package root. The installer supports three
paths:

1. Local/source install from a package directory.
2. Published npm package install.
3. Git clone fallback for the upstream repository.

## Local Smoke Test

Run the installer against this checkout without linking a global binary:

```bash
CLAWD_CODE_SOURCE_DIR=/Users/8bit/clawd-code \
CLAWD_CODE_CONFIG_DIR=/tmp/clawd-code-smoke-home/.clawd-code \
CLAWD_CODE_SMOKE_TEST=true \
sh /Users/8bit/clawd-code/install.sh
```

Smoke mode still runs `npm install`, `npm run build`, and writes a fresh
`.env` into the configured test config directory. It skips `npm link` so it
does not mutate the global npm environment.

The generated env includes Imperial router keys. Keep `IMPERIAL_LIVE=false`
until `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, `PERPS_SIM_ONLY=false`,
`IMPERIAL_WALLET`, `IMPERIAL_JWT`, and `IMPERIAL_PROFILE_INDEX` are all set.
`IMPERIAL_JWT` is a delegated trading credential and must stay out of git.
After creating a local wallet with `clawd-code wallet create imperial`, use
`clawd-code imperial register imperial --profile 0 --write-env` to activate the
Phoenix profile and persist the wallet/profile settings. Then use
`clawd-code imperial auth imperial --write-env` to persist the Imperial session,
or `clawd-code imperial auth imperial --arm-live` to persist the session and
live gates in one step.

## One-Shot Local Install

Run from the package root:

```bash
./install.sh
```

When `install.sh` is executed from this checkout, it detects the local package
root and installs from source in one shot.

## Web Box

The web UI talks to the Clawd Code API on port `3001` and serves the Next.js
operator interface on port `3000`.

Local dev, from `/Users/8bit/clawd-code`:

```bash
npm run box:dev
```

This starts:

- `npm run api:dev` at `http://localhost:3001`
- `npm --prefix web run dev` at `http://localhost:3000`

Useful checks:

```bash
curl -fsS http://localhost:3001/health
curl -fsS http://localhost:3001/.well-known/agent-auth.json
```

Container box:

```bash
docker compose up --build
```

The compose setup passes root `.env` into the API service. Keep provider keys
and trading credentials in `.env`; it is ignored by git. In containers, the web
service uses `CLAWD_API_URL=http://clawd-api:3001` for server-side proxying and
`NEXT_PUBLIC_API_URL=http://localhost:3001` for browser health checks.

## Layout Notes

- `src/` contains the CLI and provider adapters.
- `src/server.ts` contains the HTTP/SSE API used by the web UI.
- `clawd-plugin/` contains the plugin manifest, MCP config, skills, and
  reference docs.
- `spinners/` contains bundled themed spinner verb packs and is included in
  the npm package for offline `clawd-code spinner install <pack>` usage.
- `web/` contains the web client package.
- Clawd Code is always NemoClaw-enabled: OpenRouter Nemo/Fable routing is built
  into `src/openrouter.ts`.
- Imperial routing is built into `src/imperial.ts` and `src/modes/trade.ts`.
  Phoenix remains the default Imperial underwriter (`2`) unless the operator
  explicitly configures another venue.
- If an optional `NemoClaw/` sidecar package is present, keep `NemoClaw/src/`
  aligned with `src/openrouter.ts`.
- Root `.github/`, `docker/`, `scripts/`, `prompts/`, and `outputs/`
  directories are optional workspace folders and are not required by the
  installer.
