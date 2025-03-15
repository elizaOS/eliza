---
sidebar_position: 2
---

# Quickstart Guide

## Prerequisites

Before getting started with Eliza, ensure you have:

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) (using [nvm](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating) is recommended)
- [pnpm 9+](https://pnpm.io/installation)
- Git for version control
- A code editor ([VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.com/) or [VSCodium](https://vscodium.com) recommended)
- Python (mainly for installing NPM)
- (Optional) FFmpeg (for audio/video handling)
- (Optional) [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) (for GPU acceleration)

> On Windows? See here before continuing to make life easier: [WSL setup guide](/docs/guides/wsl)

---

## Automated Installation

1. Use https://github.com/elizaOS/eliza-starter

```bash
git clone git@github.com:elizaos/eliza-starter.git
cd eliza-starter
cp .env.example .env
pnpm i && pnpm build && pnpm start
```

2. Use the [start script](https://howieduhzit.best/start-sh/)

```bash
git clone git@github.com:elizaOS/eliza.git
cd eliza

# usage start.sh [-v|--verbose] [--skip-nvm]
./scripts/start.sh
```


3. Using Docker

Prerequisites:
- A Linux-based server (Ubuntu/Debian recommended)
- Git installed
- [Docker](https://docs.docker.com/get-started/get-docker/)

```bash
git clone git@github.com:elizaOS/eliza.git
cd eliza
docker-compose build
docker-compose up
```

> Note: If you get permission issues run the docker-compose commands with sudo or add yourself to the docker group

<details>
<summary>Troubleshooting</summary>
#### Common Error
```bash
- "characters not found": Check working directory
- `./scripts/start.sh -v` Run with logging
- Check console output
- [Open an issue](https://github.com/elizaOS/eliza/issues)
```

#### Permission Issues
```
sudo chmod +x scripts/start.sh  # Linux/macOS
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser  # Windows
```

#### Package Issues
> Note: Always verify scripts before running it
```
## Linux
sudo apt update

## MacOS
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew update

## Windows
# Run as admin
```

#### Node.js Issues
- Ensure Node.js 23.3.0 is installed
- Use `node -v` to check version
- Consider using [nvm](https://github.com/nvm-sh/nvm) to manage Node versions
- Use `--skip-nvm` for system Node
- Check PATH configuration

If you see Sharp-related errors, try this:

```bash
pnpm install --include=optional sharp
```

If you see errors about better-sqlite3, try `pnpm rebuild better-sqlite3` or go into `node_modules/better-sqlite3` and run `pnpm i`

You can also add a postinstall script in your `package.json` if you want to automate this:
```json
scripts: {
    "postinstall": "npm rebuild better-sqlite3"
}
```

pnpm may be bundled with a different node version, ignoring nvm. If this is the case, try:

```bash
pnpm env use --global 23.3.0
```

#### Docker issues

Some tips on cleaning your working directory before rebuilding:
- List all docker images: `sudo docker images`
- Reomove all Docker images: `docker rmi -f $(docker images -aq)`
- Remove all build cache: `docker builder prune -a -f`
- Verify cleanup: `docker system df`
</details>

---

## Manual Installation

After installing the prerequisites, clone the repository and enter the directory:

```bash
git clone git@github.com:elizaOS/eliza.git
cd eliza
```

:::tip
If you're planning on doing development, we suggest using the code on the develop branch:
```bash
git checkout develop
```

From the main repo you can also download [sample character files](https://github.com/elizaos/characters) this way:
```bash
git submodule update --init
```
:::

Install the dependencies

```bash
pnpm install
```

> **Note:** you may need to use --no-frozen-lockfile if it gives a message about the frozen lock file being out of date.

Compile the typescript:

```bash
pnpm build
```

---

## Start the Agent

[Character files](./core/characterfile.md) are where you can configure your agent's personality, lore, and capabilities via plugins. Inform eliza which character you want to run:

```bash
pnpm start --character="characters/deep-thought.character.json"
```

You can load multiple characters with a comma-separated list:

```bash
pnpm start --characters="characters/deep-thought.character.json,characters/sbf.character.json"
```

By default the agent will be accessible via the terminal and REST API.

#### Chat Client

If you're using the main [eliza repo](https://github.com/elizaos/eliza) and want to use the chat client, open a new terminal window and run the client's http server:

```bash
pnpm start:client
```

Once the client is running, you'll see a message like this:

```
➜  Local:   http://localhost:5173/
```

Simply click the link or open your browser to `http://localhost:5173/`. You'll see the chat interface connect to the system, and you can begin interacting with your character.

---

## Additional Configuration

You can load plugins or additional client support with your character file to unlock more capabilities for your agent. 

### Add Plugins and Clients

Here's how to import and register plugins in your character file:

```typescript
{
    "name": "Eliza",
    "clients": ["telegram"],
    // ... other config options
    "plugins": ["@elizaos/plugin-image"],
}
```

There are two ways to get a list of available plugins:

1. Web Interface

Go https://elizaos.github.io/registry/ or the [Showcase](/showcase) and search for plugins

2. CLI Interface

```bash
$ npx elizaos plugins list
```

Here's a sample list of plugins you can check out!

| plugin name | Description |
| ----------- | ----------- |
| [`@elizaos/plugin-llama`](https://github.com/elizaos-plugins/plugin-llama) | Run LLM models on your local machine
| [`@elizaos/client-twitter`](https://github.com/elizaos-plugins/client-twitter) | Twitter bot integration
| [`@elizaos/client-discord`](https://github.com/elizaos-plugins/client-discord) | Discord bot integration
| [`@elizaos/client-telegram`](https://github.com/elizaos-plugins/client-telegram) | Telegram integration
| [`@elizaos/plugin-image`](https://github.com/elizaos-plugins/plugin-image) | Image processing and analysis
| [`@elizaos/plugin-video`](https://github.com/elizaos-plugins/plugin-video) | Video processing capabilities
| [`@elizaos/plugin-browser`](https://github.com/elizaos-plugins/plugin-browser) | Web scraping capabilities
| [`@elizaos/plugin-pdf`](https://github.com/elizaos-plugins/plugin-pdf) | PDF processing



### Configure Environment

There are two ways to configure elizaOS

### Option 1: Default .env file

Copying the `.example.env` file and editing is the simpler option especially if you plan to just host one agent:

```bash
cp .env.example .env
nano .env
```

### Option 2: Secrets in the character file

This option allows you finer grain control over which character uses what resources and is required if you want multiple agents but using different keys. For example:


```typescript
{
  "name": "eliza",
  // ... other config options
  "settings": {
    "secrets": {
      "DISCORD_APPLICATION_ID": "1234",
      "DISCORD_API_TOKEN": "xxxx",
      "OPENAI_API_KEY": "sk-proj-xxxxxxxxx-..."
    }
  }
```

Watch the commas to make sure it's valid json! Here's a few more config tips:

<details>
<summary>Discord Bot Setup</summary>

1. Create a new application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a bot and get your token
3. Add bot to your server using OAuth2 URL generator
4. Set `DISCORD_API_TOKEN` and `DISCORD_APPLICATION_ID` in your `.env`
</details>

<details>
<summary>Twitter Integration</summary>

Add to your `.env`:

```bash
TWITTER_USERNAME=  # Account username
TWITTER_PASSWORD=  # Account password
TWITTER_EMAIL=    # Account email
TWITTER_2FA_SECRET=    # In order to avoid X preventing the login, it is better to activate 2fa in the target account, copy the 2fa secret and paste it here
```

**Important:** Log in to the [Twitter Developer Portal](https://developer.twitter.com) and enable the "Automated" label for your account to avoid being flagged as inauthentic.
</details>

<details>
<summary>Telegram Bot</summary>

1. Create a bot
2. Add your bot token to `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_token_here
```
</details>




### GPU Acceleration

If you have a Nvidia GPU you can enable CUDA support. First ensure CUDA Toolkit, cuDNN, and cuBLAS are first installed, then: `npx --no node-llama-cpp source download --gpu cuda`



---

## FAQ

### What's the difference between eliza and eliza-starter?
Eliza-starter is a lightweight version for simpler setups, while the main eliza repository includes all advanced features and a web client.

### How do I fix build/installation issues?
Use Node v23.3.0, run `pnpm clean`, then `pnpm install --no-frozen-lockfile`, followed by `pnpm build`. If issues persist, checkout the latest stable tag.

### What are the minimum system requirements?
8GB RAM recommended for build process. For deployment, a t2.large instance on AWS with 20GB storage running Ubuntu is the minimum tested configuration.

### How do I fix "Exit Status 1" errors?
If you see `triggerUncaughtException` errors, try:
1. Add dependencies to workspace root
2. Add dependencies to specific packages
3. Clean and rebuild

## Next Steps

Once you have your agent running, explore:

1. 🤖 [Understand Agents](./core/agents.md)
2. 📝 [Create Custom Characters](./core/characterfile.md)
3. ⚡ [Add Custom Actions](./core/actions.md)
4. 🔧 [Advanced Configuration](./guides/configuration.md)

Join the [Discord community](https://discord.gg/elizaOS) for support and to share what you're building!
