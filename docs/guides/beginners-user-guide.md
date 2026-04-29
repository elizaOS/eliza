---
title: Beginner User Guide
sidebarTitle: Beginner User Guide
summary: Step-by-step onboarding for first-time Milady operators, from installation through safe daily operation.
description: A complete beginner walkthrough for installing Milady, choosing a server target, configuring providers, and operating the runtime safely.
---

If you're brand new to running Milady yourself, this guide is for you.

<Info>
If you only need the consumer-facing product walkthrough, use
[milady.ai/docs](https://milady.ai/docs). This page is for people installing,
operating, or hosting Milady via the developer docs at
[docs.milady.ai](https://docs.milady.ai).
</Info>

You do **not** need to be a developer to use Milady. The core model is:

1. Milady is a client that can create or connect to a server.
2. The server target and the active model provider are separate choices.
3. You control how local, connected, or cloud-assisted your setup is.

---

## 1) What Milady is (plain English)

Milady is a personal AI assistant that can run from your terminal and dashboard.

You can use it for:

- Conversations and task support
- Connected workflows (Discord, Telegram, etc.)
- Plugin-based capabilities and custom behavior

Main interfaces:

- `milady` command (CLI)
- Dashboard in browser
- Desktop/mobile app builds (platform dependent)

---

## 2) Before you install

### What you need

- Internet access (for installation and cloud providers)
- A terminal (or PowerShell on Windows)
- Optional API key from your preferred provider (Anthropic, OpenAI, etc.)

### Recommended mindset

Start simple:

- First choose the server you want to use
- Then add one chat provider
- Then optionally add connectors/plugins

---

## 3) Install Milady

### macOS / Linux / WSL (recommended)

```bash
curl -fsSL https://get.milady.ai | bash
milady setup
```

### Windows (PowerShell)

```powershell
irm https://get.milady.ai/install.ps1 | iex
milady setup
```

### Bun global alternative

```bash
bun install -g miladyai
milady setup
```

If `milady` is not found after install, restart your terminal and run `milady --version`.

---

## 4) First start and server selection

Start Milady:

```bash
milady
```

On first launch, Milady should start with a chooser-first flow:

1. **Create one** to start a local server on this machine
2. **Pick a LAN server** if Milady finds one on your network
3. **Use Eliza Cloud** if you want a hosted Milady server
4. **Manually connect** if you already know the remote server URL

After you choose a server, Milady checks whether that server is already
configured. If not, it continues setup for that server only.

### Important rule

Server target and provider target are different things:

- A local server can still use OpenAI, Anthropic, OpenRouter, Ollama, or Eliza Cloud inference
- An Eliza Cloud server can still use direct OpenAI or Anthropic inference
- Linking an Eliza Cloud account does not force cloud inference

---

## 5) Your first 10-minute success plan

Use this exact path:

1. Run `milady`
2. Choose a server target
3. Open the dashboard for that server
4. Send a basic prompt (e.g., "hello")
5. Confirm a response is returned
6. Run `milady models` and check provider status

If these work, your base install is healthy.

---

## 6) Commands you'll use most

```bash
milady                    # start interactive mode (default)
milady start              # run server-only, headless
milady dashboard          # open dashboard in browser
milady configure          # configuration guidance
milady config get <key>   # read config value
milady models             # show model provider status
milady plugins installed   # list installed plugins
milady plugins list       # browse registry plugins
```

Tip: Use `milady <command> --help` any time you feel stuck.

---

## 7) Understanding server target vs provider

### Server target

This answers **where the Milady server lives**:

- Local
- LAN
- Remote
- Eliza Cloud

### Provider route

This answers **who handles chat inference and other capabilities**:

- Local models such as Ollama or llama.cpp-based stacks
- Direct providers such as OpenAI, Anthropic, OpenRouter, Groq, and Mistral
- Eliza Cloud inference when you explicitly select it

If something feels confusing, check these in order:

1. Which server am I connected to?
2. Which provider is active for chat on that server?
3. Which accounts are merely linked but not active?

---

## 8) Where files live on your machine

Local runtime state is stored under `~/.milady/`:

- `~/.milady/milady.json` → main configuration
- `~/.milady/logs/` → runtime logs
- `~/.milady/workspace/` → agent workspace files

This is essential for backup, troubleshooting, and migration to another machine.

---

## 9) Safety and privacy basics (must-read)

### Keep API local by default

Milady binds to loopback by default (`127.0.0.1`) on port `2138`, meaning only your machine can access it. Open your dashboard at `http://localhost:2138`.

### If exposing to network, set a token

If you bind to `0.0.0.0` or expose ports publicly, set an API token first:

```bash
# Add to your project root .env or ~/.milady/.env
echo "MILADY_API_TOKEN=$(openssl rand -hex 32)" >> ~/.milady/.env
```

### Protect secrets

- Keep API keys in env/config, not screenshots
- Never post real keys in issues/chats
- Rotate keys if you think they leaked

---

## 10) Connecting model providers

Typical flow:

1. Connect to the server you want to use
2. Get a key from your provider dashboard if needed
3. Configure the provider through setup, settings, or `milady models`
4. Verify with `milady models`
5. Send a test prompt

If responses fail, verify:

- Key is valid and active
- Provider quota/billing is healthy
- Model name/provider pairing is correct

---

## 11) Plugins and connectors (beginner version)

Plugins add capabilities (tools, integrations, actions).

Start with a minimal strategy:

1. Install only what you need
2. Test one plugin at a time
3. Restart and re-check behavior

Useful commands:

```bash
milady plugins list
milady plugins install <name>
milady plugins uninstall <name>
```

---

## 12) Troubleshooting first-week issues

### A) "Milady command not found"

- Restart terminal
- Check PATH and install method
- Run `milady --version`

### B) "Dashboard won’t load"

- Ensure Milady is running
- Check for port conflicts
- Check logs in `~/.milady/logs/`

### C) "No responses"

- Check provider configuration (`milady models`)
- Check logs in `~/.milady/logs/`
- Restart and retry

### D) "Plugin seems broken"

- Confirm plugin is installed (`plugins list`)
- Check provider/env dependencies for plugin
- Restart Milady

---

## 13) Updating and maintenance

Good routine:

- Update regularly
- Re-run `milady setup` after major updates
- Keep backups of `~/.milady/milady.json`
- Review logs when behavior changes unexpectedly

---

## 14) Beginner glossary

- **Provider**: the LLM backend (Anthropic/OpenAI/Ollama/etc.)
- **Plugin**: adds capabilities/integrations
- **Headless**: no interactive UI; service-style runtime
- **Workspace**: local files Milady uses for agent context and tasks
- **Gateway**: service layer used by dashboard and interfaces

---

## 15) What to learn next (complete learning roadmap)

Use this staged path so you do not get overwhelmed.

### Stage A — Beginner foundations (first week)

1. **Quickstart + installation refresh**
   - `/installation`
   - `/quickstart`
2. **Core configuration**
   - `/configuration`
   - `/config-schema`
   - `/runtime/models`
3. **Everyday commands and interfaces**
   - `/chat-commands`
   - `/apps/dashboard`
4. **Safety basics**
   - `/guides/sandbox`

### Stage B — Intermediate usage (weeks 2–3)

1. **Dashboard depth**
   - `/dashboard/chat`
   - `/dashboard/stream`
   - `/apps/dashboard/settings`
   - `/apps/dashboard/talk-mode`
2. **Knowledge and memory features**
   - `/guides/knowledge`
   - `/agents/memory-and-state`
3. **Connectors and channels**
   - `/guides/connectors`
   - `/connectors/discord`
   - `/connectors/telegram`
   - `/connectors/slack`
4. **Wallet and autonomous workflows**
   - `/guides/wallet`
   - `/guides/autonomous-mode`

### Stage C — Advanced user path (month 1+)

1. **Plugin ecosystem mastery**
   - `/plugins/overview`
   - `/plugins/registry`
   - `/plugins/local-plugins`
   - `/plugins/patterns`
2. **Skills and custom behavior**
   - `/plugins/skills`
   - `/guides/custom-actions`
   - `/guides/triggers`
3. **App/platform specialization**
   - `/apps/desktop`
   - `/apps/mobile`
   - Browser Relay release-status documentation when browser automation is relevant
4. **Cloud and deployment**
   - `/guides/cloud`
   - `/deployment`

### Stage D — Expert/operator track

1. **Runtime internals**
   - `/agents/runtime-and-lifecycle`
   - `/runtime/core`
   - `/runtime/services`
2. **Operational troubleshooting**
   - `/advanced/logs`
   - `/advanced/database`
3. **REST API control surface**
   - `/api-reference`
   - `/rest/system`
   - `/rest/agents`
   - `/rest/models`

### Suggested weekly plan (simple)

- **Week 1:** Stage A only
- **Week 2:** Stage B + one connector
- **Week 3:** Stage C plugin/skills basics
- **Week 4+:** Stage D only if you need ops-level control

This progression keeps your setup stable while your capability grows.

## 16) Confidence checklist

If all of these are true, you're in great shape:

- [ ] `milady` starts successfully
- [ ] Dashboard opens locally
- [ ] A provider is configured and returns responses
- [ ] You know where `~/.milady/` files live

You are now ready to move from complete beginner to regular user.
