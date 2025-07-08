# ElizaOS CLI

The ElizaOS CLI provides a comprehensive set of commands to manage your ElizaOS projects and plugins, from local development to cloud deployment.

## Installation

```bash
bun install -g @elizaos/cli
```

### Automatic Bun Installation

The ElizaOS CLI requires [Bun](https://bun.sh) as its package manager. If Bun is not installed when you run the CLI, it will attempt to automatically install it for you.

**Auto-installation features:**

- ✅ Detects when Bun is missing
- ✅ Downloads and installs Bun automatically on Windows, macOS, and Linux
- ✅ Updates PATH for the current session
- ✅ Falls back to manual installation instructions if auto-install fails
- ✅ Skips auto-installation in CI environments
- ✅ Can be disabled with `--no-auto-install` flag

**To disable auto-installation:**

```bash
# Global flag (applies to all commands)
elizaos --no-auto-install create my-project

# Environment variable
ELIZA_NO_AUTO_INSTALL=true elizaos create my-project
```

## Global Options

The following options are available for all ElizaOS CLI commands:

- `--no-emoji`: Disable emoji output for better compatibility with certain terminals or scripts
- `--no-auto-install`: Disable automatic Bun installation (useful in CI environments or when you prefer manual control)
- `-v, --version`: Show the CLI version number
- `-h, --help`: Display help information

**Example usage:**

```bash
# Disable auto-installation and emojis
elizaos --no-auto-install --no-emoji create my-project

# Just show version
elizaos --version
```

## Commands

Below is a comprehensive reference for all ElizaOS CLI commands, including their options, arguments, and subcommands. For the most up-to-date usage, run `elizaos [command] --help`.

### `elizaos create [name]`

Initialize a new project, plugin, or agent.

- **Arguments:**
  - `[name]`: Name for the project, plugin, or agent (optional)
- **Options:**
  - `-y, --yes`: Skip confirmation and use defaults (default: `false`)
  - `-t, --type <type>`: Type to create: 'project', 'plugin', 'agent', or 'tee' (default: 'project')

**Important notes:**

- Projects include a knowledge directory and a prompt for database selection (sqlite or postgres)
- Plugins are automatically prefixed with "plugin-" if the prefix is missing
- Agents are created as JSON character definition files in the current directory

### Development

#### `elizaos dev`

Start the project or plugin in development mode with auto-rebuild, detailed logging, and file change detection.

- **Options:**
  - `-c, --configure`: Reconfigure services and AI models (skips using saved configuration)
  - `--character [paths...]`: Character file(s) to use - accepts paths or URLs
  - `-b, --build`: Build the project before starting
  - `-p, --port <port>`: Port to listen on

**Character Handling:**

The `dev` command supports flexible character specification:

```bash
# Space-separated paths
elizaos dev --character file1.json file2.json

# Comma-separated paths
elizaos dev --character "file1.json,file2.json"

# Mixed formats with optional quotes
elizaos dev --character "'file1.json'" "file2.json"

# With or without .json extension
elizaos dev --character assistant     # .json extension added automatically

# URLs are also supported
elizaos dev --character https://example.com/characters/assistant.json
```

### Environment Management

#### `elizaos env <subcommand>`

Manage environment variables and secrets.

- **Subcommands:**
  - `list`: List all environment variables
    - Options: `--local`
  - `edit-local`: Edit local environment variables
    - Options: `-y, --yes`
  - `reset`: Reset all environment variables
    - Options: `-y, --yes`
  - `interactive`: Interactive environment variable management
    - Options: `-y, --yes`

### Monorepo Setup

#### `elizaos monorepo`

Clone ElizaOS monorepo from a specific branch (defaults to develop).

- **Options:**
  - `-b, --branch <branch>`: Branch to install (default: `develop`)
  - `-d, --dir <directory>`: Destination directory (default: `./eliza`)

**Notes:**

- The destination directory must be empty or non-existent
- After cloning, follow the displayed instructions to install dependencies and build the project

### Plugin Management

#### `elizaos plugins <subcommand>`

Manage an ElizaOS plugin.

- **Subcommands:**
  - `list` (alias: `l`): List available plugins (shows v1.x plugins by default)
  - `add <plugin>` (alias: `install`): Add a plugin to the project
    - Arguments: `<plugin>` (plugin name)
    - Options: `-n, --no-env-prompt`, `-b, --branch <branchName>`, `-T, --tag <tagname>`
  - `update` (alias: `refresh`): Fetch the latest plugin registry and update local cache
  - `installed-plugins`: List plugins found in the project dependencies
  - `remove <plugin>` (alias: `delete`): Remove a plugin from the project
    - Arguments: `<plugin>` (plugin name)
  - `upgrade <path>`: Upgrade a plugin from v0.x to v1.x using AI
    - Arguments: `<path>` (GitHub URL or local path)
    - Options: `--api-key <key>`, `--skip-tests`, `--skip-validation`
    - See [Plugin Upgrade Documentation](./docs/PLUGIN_UPGRADE.md) for details

### Agent Management

#### `elizaos agent <subcommand>`

Manage ElizaOS agents.

- **Subcommands:**
  - `list` (alias: `ls`): List available agents
    - Options:
      - `-j, --json`: Output as JSON
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on
  - `get` (alias: `g`): Get agent details
    - Options:
      - `-n, --name <name>`: Agent id, name, or index number from list
      - `-j, --json`: Display JSON output in terminal
      - `-o, --output <file>`: Save agent data to file
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on
  - `start` (alias: `s`): Start an agent
    - Options:
      - `-n, --name <name>`: Name of an existing agent to start
      - `--path <path>`: Local path to character JSON file
      - `--remote-character <url>`: URL to remote character JSON file
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on
  - `stop` (alias: `st`): Stop an agent
    - Options:
      - `-n, --name <name>`: Agent id, name, or index number from list
      - `--all`: Stop all running ElizaOS agents locally
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on
  - `remove` (alias: `rm`): Remove an agent
    - Options:
      - `-n, --name <name>`: Agent id, name, or index number from list
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on
  - `set`: Update agent configuration
    - Options:
      - `-n, --name <name>`: Agent id, name, or index number from list
      - `-c, --config <json>`: Agent configuration as JSON string
      - `-f, --file <path>`: Path to agent configuration JSON file
      - `-r, --remote-url <url>`: URL of the remote agent runtime
      - `-p, --port <port>`: Port to listen on

**Note:** All agent commands support interactive mode when run without key parameters.

### Publishing

#### `elizaos publish`

Publish a plugin to the registry.

- **Options:**
  - `-t, --test`: Test publish process without making changes
  - `--npm`: Publish to npm instead of GitHub
  - `--skip-registry`: Skip publishing to the registry
  - `-d, --dry-run`: Generate registry files locally without publishing

**Default behavior:**

- Publishes to npm
- Creates/updates GitHub repository
- Submits to ElizaOS registry

**npm-only mode:**

- Use `--npm` flag to publish only to npm
- Skips GitHub repository creation and registry submission

**Important for continuous development:**

The `elizaos publish` command is designed for **initial plugin publishing only**. After initial publishing, use standard npm and git workflows for updates:

- `bun version patch|minor|major` to update version (or `npm version` if preferred)
- `npm publish` to publish to npm
- `git push origin main && git push --tags` to update GitHub

The ElizaOS registry automatically syncs with npm updates.

### Agent/Server Management

#### `elizaos start`

Start the Eliza agent with configurable plugins and services.

- **Options:**
  - `-c, --configure`: Force reconfiguration of services and AI models (bypasses saved configuration)
  - `--character [paths...]`: Character file(s) to use - accepts paths or URLs
  - `-b, --build`: Build the project before starting
  - `-p, --port <port>`: Port to listen on (default: 3000)

**Character Handling:**

The `start` command accepts characters in various formats:

```bash
# Multiple character files (space-separated)
elizaos start --character file1.json file2.json

# Comma-separated format
elizaos start --character "file1.json,file2.json"

# With or without quotes
elizaos start --character "'file1.json'" "file2.json"

# Extension-optional (.json added automatically if missing)
elizaos start --character character1

# URLs are supported
elizaos start --character https://example.com/characters/assistant.json
```

If any character files fail to load, ElizaOS will:

- Log errors for the failed characters
- Continue starting with any successfully loaded characters
- Fall back to the default Eliza character if no characters loaded successfully

### Testing

#### `elizaos test`

Run tests for Eliza agent plugins and projects.

- **Subcommands:**
  - `component`: Run component tests (via Vitest)
  - `e2e`: Run end-to-end runtime tests
  - `all`: Run both component and e2e tests (default)
- **Options:**
  - `-p, --port <port>`: Port to listen on for e2e tests
  - `-n, --name <n>`: Filter tests by name (matches file names or test suite names)
  - `--skip-build`: Skip building before running tests

### Trusted Execution Environment (TEE) Management

#### `elizaos tee phala <subcommand>`

Manage TEE deployments using the official [Phala Cloud CLI](https://docs.phala.network/phala-cloud/references/tee-cloud-cli). This integration provides seamless access to Phala's decentralized TEE cloud infrastructure directly through the ElizaOS CLI.

All Phala Cloud CLI commands are passed through transparently, allowing you to use the full functionality of Phala's TEE platform.

```bash
elizaos tee phala <command> [options]
```

##### Main Commands

- **`elizaos tee phala help`** - Display help for all commands
- **`elizaos tee phala join` (alias: `free`)** - Join Phala Cloud! Get an account and deploy a CVM for FREE
- **`elizaos tee phala demo`** - Launch demo applications on Phala Cloud (Jupyter Notebook, HTTPBin)

##### Authentication Commands (`elizaos tee phala auth`)

- **`elizaos tee phala auth login [api-key]`** - Set the API key for authentication

  - Store your Phala Cloud API key securely for subsequent operations
  - Get your API key from [Phala Cloud Dashboard](https://cloud.phala.network)

- **`elizaos tee phala auth logout`** - Remove the stored API key

- **`elizaos tee phala auth status`** - Check authentication status
  - Displays whether you're logged in and which account is active

##### Cloud Virtual Machine Management (`elizaos tee phala cvms`)

- **`elizaos tee phala cvms list` (alias: `ls`)** - List all CVMs

  - Options:
    - `-j, --json` - Output in JSON format

- **`elizaos tee phala cvms create`** - Create a new CVM

  - Options:
    - `-n, --name <name>` - Name of the CVM
    - `-c, --compose <compose>` - Path to Docker Compose file
    - `--vcpu <vcpu>` - Number of vCPUs (default: 2)
    - `--memory <memory>` - Memory in MB (default: 4096)
    - `--disk-size <diskSize>` - Disk size in GB (default: 40)
    - `--teepod-id <teepodId>` - TEEPod ID to use (will prompt if not provided)
    - `--image <image>` - Version of dstack image to use (will prompt if not provided)
    - `-e, --env-file <envFile>` - Path to environment file
    - `--skip-env` - Skip environment variable prompt (default: false)
    - `--debug` - Enable debug mode (default: false)

- **`elizaos tee phala cvms get [app-id]`** - Get details of a CVM

  - Options:
    - `-j, --json` - Output in JSON format

- **`elizaos tee phala cvms start [app-id]`** - Start a stopped CVM

  - Interactive selection if app-id not provided

- **`elizaos tee phala cvms stop [app-id]`** - Stop a running CVM

  - Interactive selection if app-id not provided

- **`elizaos tee phala cvms restart [app-id]`** - Restart a CVM

  - Interactive selection if app-id not provided

- **`elizaos tee phala cvms delete [app-id]`** - Delete a CVM

  - Options:
    - `-f, --force` - Skip confirmation prompt

- **`elizaos tee phala cvms upgrade [app-id]`** - Upgrade a CVM to a new version

  - Options:
    - `-c, --compose <compose>` - Path to new Docker Compose file
    - `--env-file <envFile>` - Path to environment file
    - `--debug` - Enable debug mode

- **`elizaos tee phala cvms resize [app-id]`** - Resize resources for a CVM

  - Options:
    - `-v, --vcpu <vcpu>` - Number of virtual CPUs
    - `-m, --memory <memory>` - Memory size in MB
    - `-d, --disk-size <diskSize>` - Disk size in GB
    - `-r, --allow-restart <allowRestart>` - Allow restart of the CVM if needed
    - `-y, --yes` - Automatically confirm the resize operation

- **`elizaos tee phala cvms attestation [app-id]`** - Get attestation information for a CVM
  - Provides cryptographic proof that your application is running in a secure TEE
  - Interactive selection if app-id not provided

##### Docker Management (`elizaos tee phala docker`)

- **`elizaos tee phala docker login`** - Login to Docker Hub

  - Configure Docker Hub credentials for pushing images

- **`elizaos tee phala docker build`** - Build a Docker image

  - Options:
    - `--image <image>` - Docker image name
    - `--tag <tag>` - Tag for the Docker image

- **`elizaos tee phala docker push`** - Push a Docker image to Docker Hub

  - Options:
    - `--image <image>` - Docker image name
    - `--tag <tag>` - Tag to push

- **`elizaos tee phala docker generate`** - Generate a Docker Compose file
  - Options:
    - `-i, --image <imageName>` - Docker image name to use in the compose file
    - `-e, --env-file <envFile>` - Path to environment variables file
    - `-o, --output <output>` - Output path for generated docker-compose.yml
    - `--template <template>` - Template to use for the generated docker-compose.yml

##### TEE Simulator (`elizaos tee phala simulator`)

- **`elizaos tee phala simulator start`** - Start the TEE simulator

  - Options:
    - `-i, --image <image>` - Simulator image to use
    - `-p, --port <port>` - Simulator port (default: 8090) (default: "8090")
    - `-t, --type <type>` - Simulator type (docker, native) (default: "docker")

- **`elizaos tee phala simulator stop`** - Stop the TEE simulator
  - Stops the running TEE simulator container

##### Getting Started

1. **Sign up for Phala Cloud**:

   ```bash
   elizaos tee phala free
   # Or visit https://cloud.phala.network to create an account
   ```

2. **Authenticate**:

   ```bash
   elizaos tee phala auth login <your-api-key>
   elizaos tee phala auth status
   ```

3. **Deploy your first Eliza Agent**:

   ```bash
   # Create a TEE project starter template
   elizaos create -t tee tee-agent

   # cd into directory and authenticate your Phala Cloud API Key
   cd tee-agent
   elizaos tee phala auth login

   # Log into Docker and ensure docker is running
   elizaos tee phala docker build

   # Publish the Docker image you built
   elizaos tee phala docker push

   # Generate a Docker Compose file or update the image in the existing docker compose file
   elizaos tee phala docker generate --template eliza

   # Create and deploy a CVM
   elizaos tee phala cvms create --name elizaos -c <docker-compose file> -e <path to .env>

   # Check deployment status
   elizaos tee phala cvms list

   # Upgrade existing deployment
   elizaos tee phala cvms upgrade -c <docker-compose file> -e <path to .env (optional)>
   ```

4. **Verify TEE attestation**:

   ```bash
   elizaos tee phala cvms attestation <app-id>
   ```

##### Private Registry Support

For private Docker images, set these environment variables before deployment and add them to your docker-compose file:

**DockerHub**:

- `DSTACK_DOCKER_USERNAME` - Your DockerHub username
- `DSTACK_DOCKER_PASSWORD` - Your DockerHub password or access token
- `DSTACK_DOCKER_REGISTRY` - Registry URL (optional, defaults to DockerHub)

**AWS ECR**:

- `DSTACK_AWS_ACCESS_KEY_ID` - AWS access key
- `DSTACK_AWS_SECRET_ACCESS_KEY` - AWS secret key
- `DSTACK_AWS_REGION` - AWS region
- `DSTACK_AWS_ECR_REGISTRY` - Full ECR registry URL

##### Additional Resources

- **Command Help**: `elizaos tee phala help` or `elizaos tee phala <command> --help`
- **Official Documentation**: [Phala Cloud Docs](https://docs.phala.network/phala-cloud)
- **Dashboard**: [Phala Cloud Dashboard](https://cloud.phala.network)
- **NPM Package**: [phala on npm](https://www.npmjs.com/package/phala)
- **Support**: [Phala Network Discord](https://discord.gg/phala-network)

All commands support the full range of options available in the official Phala CLI. For the most current command reference, run `npx phala help`.

### Updates

#### `elizaos update`

Update ElizaOS CLI and project dependencies to the latest versions.

- **Options:**
  - `-c, --check`: Check for available updates without applying them - shows what packages would be updated
  - `--skip-build`: Skip building after updating
  - `--cli`: Update only the global CLI installation (without updating packages)
  - `--packages`: Update only packages (without updating the CLI)

### Environment Configuration

#### `elizaos env`

Manage environment variables and secrets.

- **Subcommands:**
  - `list`: List all environment variables
    - Options: `--system`, `--local`
  - `edit-local`: Edit local environment variables
    - Options: `-y, --yes`
  - `reset`: Reset environment variables and clean up database/cache files
    - Options: `-y, --yes`
  - `interactive`: Start interactive environment variable manager
    - Options: `-y, --yes`

### Process Management

To stop all running ElizaOS agents locally, use:

```bash
elizaos agent stop --all
```

This command uses `pkill` to terminate all ElizaOS processes. For stopping individual agents, see the [Agent Management](#elizaos-agent-subcommand) section.

## Development Guide

### Developing Agents

Agents are character definitions for ElizaOS bots.

1. **Create a new agent character**:

   ```bash
   elizaos create my-assistant --type agent
   ```

   This creates a JSON file (my-assistant.json) with the character definition.

2. **Start an agent with the character**:

   ```bash
   elizaos agent start --path my-assistant.json
   ```

### Developing Plugins

Plugins extend the functionality of ElizaOS agents by providing additional capabilities or integrations.

1. **Create a new plugin**:

   ```bash
   elizaos create my-plugin --type plugin
   cd plugin-my-plugin  # Note: CLI automatically adds plugin- prefix if not present
   ```

2. **Structure of a plugin**:

   ```
   plugin-my-plugin/
   ├── src/               # Source code
   │   └── index.ts       # Main entry point defining the plugin
   ├── images/            # Required for publishing to registry
   │   ├── logo.jpg       # 400x400px square (<500KB)
   │   └── banner.jpg     # 1280x640px (<1MB)
   ├── package.json       # Package configuration with agentConfig section
   ├── tsconfig.json      # TypeScript configuration
   └── README.md          # Documentation
   ```

3. **Implement your plugin**:

   Your plugin's main file (src/index.ts) should export a plugin object:

   ```typescript
   import { type Plugin, type IAgentRuntime } from '@elizaos/core';
   import { z } from 'zod';

   // Define config schema for validation
   const configSchema = z.object({
     API_KEY: z.string().min(1, 'API key is required'),
   });

   // Export the plugin object
   export const myPlugin: Plugin = {
     name: 'plugin-my-plugin',
     description: 'My custom plugin description',

     // Config section maps environment variables to plugin settings
     config: {
       API_KEY: process.env.MY_PLUGIN_API_KEY,
     },

     // Initialization function
     async init(config: Record<string, string>) {
       // Validate config
       const validatedConfig = await configSchema.parseAsync(config);

       // Plugin setup
       return {
         // Plugin methods and handlers
         // ...
       };
     },
   };

   // Default export
   export default myPlugin;
   ```

4. **Configure package.json**:

   Add an `agentConfig` section to describe your plugin parameters:

   ```json
   "agentConfig": {
     "pluginType": "elizaos:plugin:1.0.0",
     "pluginParameters": {
       "API_KEY": {
         "type": "string",
         "description": "API key for the service"
       }
     }
   }
   ```

5. **Test your plugin**:

   ```bash
   # Run tests during development
   elizaos test
   # Or with the CLI directly:
   elizaos test

   # Test specific components
   elizaos test component

   # Test end-to-end functionality
   elizaos test e2e
   ```

6. **Publish your plugin**:

   ```bash
   # Login to npm first (still needed for publishing)
   npm login

   # Test your plugin thoroughly
   elizaos test

   # Test publishing process
   elizaos publish --test

   # Publish to npm + GitHub + registry (recommended)
   elizaos publish
   ```

7. **Continuous development workflow**:

   ```bash
   # Make changes to your plugin
   elizaos dev  # Test locally

   # Test your changes
   elizaos test

   # Update version and publish updates
   bun version patch  # or minor/major
   npm publish  # Note: npm publish is still required for registry
   git push origin main && git push --tags
   ```

### Developing Projects (Agents)

Projects contain agent configurations and code for building agent-based applications.

1. **Create a new project**:

   ```bash
   elizaos create my-agent-project
   cd my-agent-project
   ```

2. **Project structure**:

   ```
   my-agent-project/
   ├── src/               # Source code
   │   ├── index.ts       # Main entry point with character definition
   │   └── plugins.ts      # Custom project plugin implementation
   ├── data/              # Data storage directory
   │   └── uploads/       # For uploaded files
   ├── package.json       # Package configuration
   ├── tsconfig.json      # TypeScript configuration
   └── README.md          # Documentation
   ```

3. **Configure your agent**:

   The main character definition is in src/index.ts:

   ```typescript
   import { type Character } from '@elizaos/core';

   export const character: Character = {
     name: 'My Assistant',
     plugins: [
       '@elizaos/plugin-openai',
       // Add other plugins here
     ],
     system: 'You are a helpful assistant...',
     bio: [
       'Helpful and knowledgeable',
       'Communicates clearly and concisely',
       // Other character traits
     ],
     messageExamples: [
       // Example conversations
     ],
   };
   ```

4. **Add plugins to your project**:

   ```bash
   elizaos plugins add @elizaos/plugin-openai
   ```

5. **Run your project in development mode**:

   ```bash
   elizaos dev
   ```

6. **Build and start your project**:

   ```bash
   elizaos start
   ```

7. **Test your project**:

   ```bash
   # Run all tests
   elizaos test

   # Run component tests only
   elizaos test component

   # Run e2e tests only
   elizaos test e2e

   # Test with specific options
   elizaos test --port 4000 --name specific-test
   ```

8. **Development workflow**:

   ```bash
   # Make changes to your project
   elizaos dev  # Development mode with hot-reload

   # Test your changes
   elizaos test

   # Build and start in production mode
   elizaos start
   ```

## Contributing

For contributing to the ElizaOS CLI, please clone the monorepo using:

```bash
elizaos monorepo
```
