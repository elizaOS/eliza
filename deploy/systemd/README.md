# Eliza bare-metal systemd bundle

Run Eliza directly on a Linux host as **systemd user services** — no Docker,
no container-in-container. Best for **one bot on one VPS** (or a local Linux
box) against a personal Claude Max subscription, where you want PTY subagents
and OAuth to use the same `~/.claude` credentials the `claude` CLI created.

Full guide: **[`/deployment-bare-metal`](../../packages/docs/deployment-bare-metal.mdx)**.
For Docker / multi-tenant / API-key-first deployments, use the
[Deployment Guide](../../packages/docs/deployment.mdx) instead.

## Layout

```
deploy/systemd/
  install.sh                  idempotent installer (user services)
  eliza.env.example           env template -> ~/.config/eliza/env on first install
  units/
    eliza.service             the bot: Restart=always, OAuth refresh before launch
    eliza-refresh.{service,timer}   roll the OAuth token every 6h
    eliza-probe.{service,timer}     health probe every 5 min (restart on failure)
  bin/
    eliza-refresh-oauth.sh    refresh only when the token is near expiry; never runs a model
    eliza-health-probe.sh     /api/health + agentState + auth-log check; restart-on-failure
```

## Prerequisites

- Linux host with systemd (user sessions + linger). Any modern distro.
- `bun` on the installing user's `PATH`.
- `claude` CLI installed and logged in once (`claude auth login`).
- Run as your normal user — **not** root.

## Install

```bash
git clone https://github.com/elizaOS/eliza.git
cd eliza
./deploy/systemd/install.sh            # or: ./deploy/systemd/install.sh /opt/eliza
```

The installer substitutes the resolved workdir, your `bun` path, and the log
path into the unit templates, writes them to `~/.config/systemd/user/`, copies
the helper scripts to `~/bin/`, seeds `~/.config/eliza/env` on first run,
enables linger, and starts the service + timers.

## Uninstall

```bash
systemctl --user disable --now eliza.service eliza-refresh.timer eliza-probe.timer
rm -f ~/.config/systemd/user/eliza{,-refresh,-probe}.{service,timer}
rm -f ~/bin/eliza-refresh-oauth.sh ~/bin/eliza-health-probe.sh
systemctl --user daemon-reload
loginctl disable-linger "$USER"   # optional
```

> **Not yet smoke-tested on a fresh host in CI.** The unit/script contract is
> verified against the running agent (`/api/health` returns
> `"agentState":"running"`, API on `ELIZA_API_PORT`, OAuth creds at
> `~/.claude/.credentials.json`), but a first-boot run on a clean VPS should be
> exercised before this is relied on for production.
