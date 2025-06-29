# Eliza

A framework for multi-agent development and deployment

## ✨ Features

- 🛠️ Full-featured Discord, Telegram, and Farcaster connectors (and many more!)
- 🔗 Support for every model (Llama, Grok, OpenAI, Anthropic, Gemini, etc.)
- 🎨 Modern and professional UI with a redesigned dashboard for managing agents and groups.
- 💬 Robust real-time communication with enhanced channel and message handling.
- 👥 Multi-agent and group support with intuitive management.
- 📚 Easily ingest and interact with your documents.
- 💾 Retrievable memory and document store.
- 🚀 Highly extensible - create your own actions and clients.
- 📦 Just works!

## 🎯 Use Cases

- 🤖 Chatbots
- 🕵️ Autonomous Agents
- 📈 Business Process Handling
- 🎮 Video Game NPCs
- 🧠 Trading

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) (v23 or higher recommended)
- [bun](https://bun.sh/docs/installation)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required.

### Use the CLI (Recommended)

The ElizaOS CLI provides the fastest and most reliable way to create, configure, and run agents. It handles all the complex setup automatically.

#### 1. Install the CLI

```bash
# Install the ElizaOS CLI globally
bun install -g @elizaos/cli

# Verify installation
elizaos --version

# Get help with available commands
elizaos --help
```

#### 2. Create Your First Project

```bash
# Create a new project with interactive setup
elizaos create my-agent

# Or create with specific options (skips prompts)
elizaos create my-agent --yes --type project
```

**Recommended Options for Beginners:**

- **Database**: `pglite` (lightweight, no setup required)
- **Model Provider**: `openai` (most reliable and well-tested)
- **Project Type**: `project` (full ElizaOS application with runtime and agents)

#### 3. Configure Your Agent

```bash
cd my-agent

# Edit your agent's character file
elizaos env edit-local

# Or manually edit the .env file with your preferred editor
nano .env
```

**Essential Environment Variables:**

```bash
# Required: Your model API key
OPENAI_API_KEY=your_api_key_here

# Optional: Logging level (info, debug, error)
LOG_LEVEL=info

# Optional: Discord bot token (if using Discord)
DISCORD_APPLICATION_ID=your_discord_app_id
DISCORD_API_TOKEN=your_discord_bot_token
```

#### 4. Start Your Agent

```bash
# Build and start your agent
elizaos start

# Or start with debug logging for development
LOG_LEVEL=debug elizaos start
```

After starting, your agent will be available at:

- **Web Interface**: http://localhost:3000
- **API Endpoint**: http://localhost:3000/api

#### 5. Development Workflow

```bash
# Make changes to your agent code
# Then rebuild and restart
bun run build
elizaos start

# Run tests to verify your changes
elizaos test
```

#### Advanced CLI Commands

```bash
# Create specific components
elizaos create my-plugin --type plugin    # Create a new plugin
elizaos create my-agent --type agent      # Create a new agent character
elizaos create my-tee --type tee          # Create a TEE project

# Environment management
elizaos env list            # Show all environment variables
elizaos env reset           # Reset to default .env.example

# Testing options
elizaos test --name "my-test"    # Run specific tests
elizaos test e2e                 # Run end-to-end tests only
elizaos test component           # Run component tests only

# Agent management
elizaos agent list                      # List all available agents
elizaos agent start --name "Agent"     # Start a specific agent by name
elizaos agent stop --name "Agent"      # Stop a running agent
elizaos agent get --name "Agent"       # Get agent details
elizaos agent set --name "Agent" --file config.json  # Update agent configuration
```

#### Debugging and Logging

ElizaOS uses comprehensive logging to help you understand what your agent is doing:

```bash
# Different log levels
LOG_LEVEL=error elizaos start    # Only errors
LOG_LEVEL=info elizaos start     # General information (default)
LOG_LEVEL=debug elizaos start    # Detailed debugging info
LOG_LEVEL=verbose elizaos start  # Everything (very detailed)

# Advanced debugging (combine with LOG_LEVEL=debug)
ELIZA_DEBUG=true elizaos start          # Enable ElizaOS debug output
NODE_ENV=development elizaos start      # Development mode with extra logging
```

**Pro Tips:**

- Use `elizaos --help` to see all available commands and global options
- Use `elizaos <command> --help` for detailed help on any specific command
- Use `LOG_LEVEL=debug` during development to see detailed execution flow
- Check the web interface at http://localhost:3000 for real-time agent status
- Use `elizaos test` frequently to catch issues early
- Keep your `.env` file secure and never commit it to version control

#### Available Commands Reference

**All CLI Commands:**

```bash
elizaos create     # Create new projects, plugins, agents, or TEE projects
elizaos start      # Start the agent server with character profiles
elizaos agent      # Manage agents (list, start, stop, get, set)
elizaos test       # Run tests (component, e2e, or all)
elizaos env        # Manage environment variables and configuration
elizaos dev        # Start in development mode with auto-rebuild
elizaos update     # Update CLI and project dependencies
# To stop agents, use Ctrl+C in the terminal where elizaos start is running
elizaos publish    # Publish plugins to registry
elizaos plugins    # Manage and discover plugins
elizaos monorepo   # Monorepo development utilities
elizaos tee        # Trusted Execution Environment commands

# Get help for any specific command
elizaos <command> --help    # e.g., elizaos create --help, elizaos agent --help
```

### Manually Start Eliza (Only recommended if you know what you are doing)

#### Prerequisites

- **Node.js** (v18+ recommended)
- **bun** (for CLI and dependencies)
- **git** (for project/plugin tests)

#### Checkout the latest release

```bash
# Clone the repository
git clone https://github.com/elizaos/eliza.git

# This project iterates fast, so we recommend checking out the latest release
git checkout $(git describe --tags --abbrev=0)
# If the above doesn't checkout the latest release, this should work:
# git checkout $(git describe --tags `git rev-list --tags --max-count=1`)
```

#### Edit the .env file

Copy .env.example to .env and fill in the appropriate values.

```
cp .env.example .env
```

Note: .env is optional. If you're planning to run multiple distinct agents, you can pass secrets through the character JSON

#### Start Eliza

Important! We now use Bun. If you are using npm, you will need to install Bun:
https://bun.sh/docs/installation

```bash
bun install
bun run build
bun start
```

### Interact via Browser

Once Eliza is running, access the modern web interface at http://localhost:3000. It has been professionally redesigned and features:

- A welcoming dashboard with a gradient hero section and clear calls-to-action for creating agents and groups.
- Visually enhanced cards for managing agents and groups, including status indicators and member counts.
- Real-time chat capabilities with your agents.
- Character configuration options.
- Plugin management.
- Comprehensive memory and conversation history.
- Responsive design for an optimal experience on various screen sizes.

## Citation

We now have a [paper](https://arxiv.org/pdf/2501.06781) you can cite for the Eliza OS:

```bibtex
@article{walters2025eliza,
  title={Eliza: A Web3 friendly AI Agent Operating System},
  author={Walters, Shaw and Gao, Sam and Nerd, Shakker and Da, Feng and Williams, Warren and Meng, Ting-Chien and Han, Hunter and He, Frank and Zhang, Allen and Wu, Ming and others},
  journal={arXiv preprint arXiv:2501.06781},
  year={2025}
}
```

## Contributors

<a href="https://github.com/elizaos/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=elizaos/eliza" alt="Eliza project contributors" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=elizaos/eliza&type=Date)](https://star-history.com/#elizaos/eliza&Date)

## Git Hooks

This project uses git hooks to ensure code quality:

- **pre-commit**: Automatically formats staged files using Prettier before committing

To run the pre-commit hook manually:

```bash
bun run pre-commit
```

## 📂 Repository Structure

Eliza is organized as a monorepo using Bun, Lerna, and Turbo for efficient package management and build orchestration. Here's a detailed overview of the project structure:

- **`/` (Root)**:

  - `.github/`: GitHub Actions workflows for CI/CD pipelines and issue templates
  - `.husky/`: Git hooks configuration, including pre-commit formatting
  - `.devcontainer/`: Development container configurations for consistent environments
  - `packages/`: Core packages and modules (detailed below)
  - `scripts/`: Build, development, and utility scripts
  - `data/`: Application and user data storage
  - `AGENTS.md`: Comprehensive agent documentation and specifications
  - `CHANGELOG.md`: Detailed version history and changes
  - `Dockerfile`, `docker-compose.yaml`: Container configurations for deployment
  - `lerna.json`, `package.json`, `turbo.json`: Monorepo configuration and workspace definitions

- **`/packages/`**: Core components of the Eliza framework:
  - `core/`: The foundational package (@elizaos/core) implementing:
    - LangChain integration for AI model interactions
    - PDF processing capabilities
    - Logging and error handling infrastructure
  - `app/`: Tauri-based cross-platform application (@elizaos/app)
    - React-based UI implementation
    - Tauri plugins for system integration
    - Desktop and mobile builds support
  - `autodoc/`: Documentation automation tool (@elizaos/autodoc)
    - LangChain-powered documentation generation
    - TypeScript parsing and analysis
    - GitHub integration via Octokit
  - `cli/`: Command-line interface for Eliza management
  - `client/`: Client libraries for web interfaces
  - `create-eliza/`: Project scaffolding tool
  - `docs/`: Official documentation source files
  - `plugin-bootstrap/`: **Essential communication core** (@elizaos/plugin-bootstrap)
    - **Required for basic agent functionality** - handles all message processing
    - Provides critical event handlers (MESSAGE_RECEIVED, VOICE_MESSAGE_RECEIVED, etc.)
    - Implements fundamental agent actions (reply, follow/unfollow, mute/unmute)
    - Contains core evaluators and providers for agent cognition
    - Manages message processing pipeline and response generation
    - **Mandatory unless building custom event handling system**
  - `plugin-sql/`: Database integration (@elizaos/plugin-sql)
    - PostgreSQL integration with PGLite support
    - Drizzle ORM for type-safe queries
    - Migration management tools
    - Integration testing support
  - `plugin-starter/`: Template for creating new plugins
  - `project-starter/`, `project-tee-starter/`: Project templates

This architecture enables modular development, clear separation of concerns, and scalable feature implementation across the Eliza ecosystem.

## Tauri Application CI/CD and Signing

The Eliza application, built with Tauri and located in `packages/app`, is configured for cross-platform continuous integration and deployment. This setup automates the building and releasing of the application for various operating systems.

### Overview

The Tauri application is designed to be built for:

- Desktop: Linux, macOS, and Windows.
- Mobile: Android and iOS.

### CI/CD Workflows

Two main GitHub Actions workflows handle the CI/CD process for the Tauri application:

- **`tauri-ci.yml`**:

  - Triggered on pushes to `main` and `develop` branches.
  - Performs debug builds of the desktop application (Linux, macOS, Windows) to ensure code integrity and catch build issues early.

- **`tauri-release.yml`**:
  - Triggered when new tags (e.g., `v*`) are pushed or when a new release is created/published on GitHub.
  - Builds release-ready versions of the application for all supported desktop platforms (Linux AppImage & .deb, macOS .dmg, Windows .exe NSIS installer).
  - Builds release versions for mobile platforms (Android .apk, iOS .ipa).
  - Uploads all generated binaries and installers as artifacts to the corresponding GitHub Release.

### Mobile Application Backend

The mobile versions of the Eliza Tauri application (Android and iOS) are configured to connect to an external backend service hosted at `https://api.eliza.how`. This connection is essential for certain functionalities of the mobile app.

The Content Security Policy (CSP) in `packages/app/src-tauri/tauri.conf.json` has been updated to allow `connect-src` directives to this specific domain, ensuring that the mobile app can securely communicate with its backend.

### Application Signing (Important for Releases)

For the `tauri-release.yml` workflow to produce _signed_ and deployable mobile applications suitable for app stores or distribution, specific secrets must be configured in the GitHub repository settings (`Settings > Secrets and variables > Actions`).

**Android Signing Secrets:**

- `ANDROID_KEYSTORE_BASE64`: Base64 encoded content of your Java Keystore file (`.jks` or `.keystore`).
- `ANDROID_KEYSTORE_ALIAS`: The alias of your key within the keystore.
- `ANDROID_KEYSTORE_PRIVATE_KEY_PASSWORD`: The password for the private key associated with the alias.
- `ANDROID_KEYSTORE_PASSWORD`: The password for the keystore file itself.

> **Note**: The CI workflow currently includes a step to generate a dummy, unsigned keystore for Android if these secrets are not provided. This allows the release build to complete and produce an unsigned APK, but this APK cannot be published to app stores. For official releases, providing the actual signing credentials via these secrets is crucial.

**iOS Signing Secrets:**

- `APPLE_DEVELOPMENT_CERTIFICATE_P12_BASE64`: Base64 encoded content of your Apple Distribution Certificate (`.p12` file).
- `APPLE_CERTIFICATE_PASSWORD`: The password used to encrypt the `.p12` certificate file.
- `APPLE_PROVISIONING_PROFILE_BASE64`: Base64 encoded content of your Distribution Provisioning Profile (`.mobileprovision` file).
- `APPLE_DEVELOPMENT_TEAM`: Your Apple Developer Team ID (e.g., `A1B2C3D4E5`).

> **Note**: The CI workflow currently includes placeholder steps for setting up the Apple development environment and signing for iOS. These steps will require the above secrets to be populated. If these secrets are not provided and the signing steps are made active (by uncommenting them in the workflow), the iOS build will likely fail.

### Artifacts

Upon successful completion of the `tauri-release.yml` workflow (triggered by a new tag/release), all compiled application installers and mobile packages will be available as downloadable artifacts on the GitHub Releases page for that specific tag. This includes:

- Linux: `.AppImage` and `.deb` files.
- macOS: `.dmg` file.
- Windows: `.exe` NSIS installer.
- Android: `.apk` file.
- iOS: `.ipa` file.
