---
sidebar_position: 2
---

# Quickstart Guide

## Prerequisites

Before getting started with Eliza, ensure you have:

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm 9+](https://pnpm.io/installation)
- Git for version control
- A code editor ([VS Code](https://code.visualstudio.com/) or [VSCodium](https://vscodium.com) recommended)
- [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) (optional, for GPU acceleration)

## Installation

1. **Clone and Install**

    Please be sure to check what the [latest available stable version tag](https://github.com/elizaos/eliza/tags) is.

    Clone the repository

    ```bash
    git clone https://github.com/elizaos/eliza.git
    ```

    Enter directory

    ```bash
    cd eliza
    ```

    Switch to latest tagged release

    ```bash
     # Checkout the latest release
     # This project iterates fast, so we recommend checking out the latest release
     git checkout $(git describe --tags --abbrev=0)
    ```

    Install dependencies (on initial run)

    ```bash
    pnpm install --no-frozen-lockfile
    ```

    # Quickstart Guide Update

**Important Note on pnpm Lockfile Management**

By default, the `pnpm` lockfile will not be updated during installations based off of .npmrc frozen-lockfile=true. To update the lockfile, you need to run the command:

```bash
pnpm install --no-frozen-lockfile
```

Please only use this command when you initially instantiating the repo or are bumping the version of a package or adding a new package to your package.json. This practice helps maintain consistency in your project's dependencies and prevents unintended changes to the lockfile.

Build the local libraries

```bash
pnpm build
```

2. **Configure Environment**

    Copy example environment file

    ```bash
    cp .env.example .env
    ```

    Edit `.env` and add your values:

    ```bash
    # Suggested quickstart environment variables
    DISCORD_APPLICATION_ID=  # For Discord integration
    DISCORD_API_TOKEN=      # Bot token
    HEURIST_API_KEY=       # Heurist API key for LLM and image generation
    OPENAI_API_KEY=        # OpenAI API key
    GROK_API_KEY=          # Grok API key
    ELEVENLABS_XI_API_KEY= # API key from elevenlabs (for voice)
    ```

## Choose Your Model

Eliza supports multiple AI models:

- **Heurist**: Set `modelProvider: "heurist"` in your character file. Most models are uncensored.
    - LLM: Select available LLMs [here](https://docs.heurist.ai/dev-guide/supported-models#large-language-models-llms) and configure `SMALL_HEURIST_MODEL`,`MEDIUM_HEURIST_MODEL`,`LARGE_HEURIST_MODEL`
    - Image Generation: Select available Stable Diffusion or Flux models [here](https://docs.heurist.ai/dev-guide/supported-models#image-generation-models) and configure `HEURIST_IMAGE_MODEL` (default is FLUX.1-dev)
- **Llama**: Set `XAI_MODEL=meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo`
- **Grok**: Set `XAI_MODEL=grok-beta`
- **OpenAI**: Set `XAI_MODEL=gpt-4o-mini` or `gpt-4o`

You set which model to use inside the character JSON file

### Local inference

    #### For llama_local inference:

      1. Set `XAI_MODEL` to your chosen model
      2. Leave `X_SERVER_URL` and `XAI_API_KEY` blank
      3. The system will automatically download the model from Hugging Face
      4. `LOCAL_LLAMA_PROVIDER` can be blank

      Note: llama_local requires a GPU, it currently will not work with CPU inference

    #### For Ollama inference:

      - If `OLLAMA_SERVER_URL` is left blank, it defaults to `localhost:11434`
      - If `OLLAMA_EMBEDDING_MODE` is left blank, it defaults to `mxbai-embed-large`

## Create Your First Agent

1. **Create a Character File**

    Check out `characters/trump.character.json` or `characters/tate.character.json` as a template you can use to copy and customize your agent's personality and behavior.
    Additionally you can read `core/src/core/defaultCharacter.ts` (in 0.0.10 but post-refactor will be in `packages/core/src/defaultCharacter.ts`)

    📝 [Character Documentation](./core/characterfile.md)

2. **Start the Agent**

    Inform it which character you want to run:

    ```bash
    pnpm start --character="characters/trump.character.json"
    ```

    You can also load multiple characters with the characters option with a comma separated list:

    ```bash
    pnpm start --characters="characters/trump.character.json,characters/tate.character.json"
    ```

3. **Interact with the Agent**

    Now you're ready to start a conversation with your agent!
    Open a new terminal window

    ```bash
    pnpm start:client
    ```

    Once the client is running, you'll see a message like this:

```
➜  Local:   http://localhost:5173/
```

Simply click the link or open your browser to `http://localhost:5173/`. You'll see the chat interface connect to the system, and you can begin interacting with your character.

## Platform Integration

### Discord Bot Setup

1. Create a new application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a bot and get your token
3. Add bot to your server using OAuth2 URL generator
4. Set `DISCORD_API_TOKEN` and `DISCORD_APPLICATION_ID` in your `.env`

### Twitter Integration

Add to your `.env`:

```bash
TWITTER_USERNAME=  # Account username
TWITTER_PASSWORD=  # Account password
TWITTER_EMAIL=    # Account email
```

**Important:** Log in to the [Twitter Developer Portal](https://developer.twitter.com) and enable the "Automated" label for your account to avoid being flagged as inauthentic.

### Telegram Bot

1. Create a bot
2. Add your bot token to `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_token_here
```

## Optional: GPU Acceleration

If you have an NVIDIA GPU:

```bash
# Install CUDA support
npx --no node-llama-cpp source download --gpu cuda

# Ensure CUDA Toolkit, cuDNN, and cuBLAS are installed
```

## Basic Usage Examples

### Chat with Your Agent

```bash
# Start chat interface
pnpm start
```

### Run Multiple Agents

```bash
pnpm start --characters="characters/trump.character.json,characters/tate.character.json"
```

## Common Issues & Solutions

1. **Node.js Version**

   - Ensure Node.js 23.3.0 is installed
   - Use `node -v` to check version
   - Consider using [nvm](https://github.com/nvm-sh/nvm) to manage Node versions
   
   NOTE: pnpm may be bundled with a different node version, ignoring nvm. If this is the case, you can use 
   ```bash
   pnpm env use --global 23.3.0
   ```
   to force it to use the correct one.

2. **Sharp Installation**
   If you see Sharp-related errors:

    ```bash
    pnpm install --include=optional sharp
    ```

3. **CUDA Setup**

    - Verify CUDA Toolkit installation
    - Check GPU compatibility with toolkit
    - Ensure proper environment variables are set

4. **Exit Status 1**
   If you see

    ```
    triggerUncaughtException(
    ^
    [Object: null prototype] {
    [Symbol(nodejs.util.inspect.custom)]: [Function: [nodejs.util.inspect.custom]]
    }
    ```

    You can try these steps, which aim to add `@types/node` to various parts of the project

    ```
    # Add dependencies to workspace root
    pnpm add -w -D ts-node typescript @types/node

    # Add dependencies to the agent package specifically
    pnpm add -D ts-node typescript @types/node --filter "@elizaos/agent"

    # Also add to the core package since it's needed there too
    pnpm add -D ts-node typescript @types/node --filter "@elizaos/core"

    # First clean everything
    pnpm clean

    # Install all dependencies recursively
    pnpm install -r

    # Build the project
    pnpm build

    # Then try to start
    pnpm start
    ```

5. **Better sqlite3 was compiled against a different Node.js version**
   If you see

    ```
    Error starting agents: Error: The module '.../eliza-agents/dv/eliza/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    was compiled against a different Node.js version using
    NODE_MODULE_VERSION 131. This version of Node.js requires
    NODE_MODULE_VERSION 127. Please try re-compiling or re-installing
    ```

    You can try this, which will attempt to rebuild better-sqlite3.

    ```bash
    pnpm rebuild better-sqlite3
    ```

    If that doesn't work, try clearing your node_modules in the root folder

    ```bash
    rm -fr node_modules; pnpm store prune
    ```

    Then reinstall the requirements

    ```bash
    pnpm i
    ```

## Next Steps

Once you have your agent running, explore:

1. 🤖 [Understand Agents](./core/agents.md)
2. 📝 [Create Custom Characters](./core/characterfile.md)
3. ⚡ [Add Custom Actions](./core/actions.md)
4. 🔧 [Advanced Configuration](./guides/configuration.md)

For detailed API documentation, troubleshooting, and advanced features, check out our [full documentation](https://elizaos.github.io/eliza/).

Join our [Discord community](https://discord.gg/ai16z) for support and updates!
