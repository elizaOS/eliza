# ElizaOS CLI

The ElizaOS CLI provides a comprehensive set of commands to manage your ElizaOS projects and plugins, from local development to cloud deployment.

## Installation

```bash
bun install -g @elizaos/cli@beta
```

### Alternative usage with npx

You can also run the CLI directly without installation using npx:

```bash
npx @elizaos/cli@beta [command]
```

This is useful for trying out commands without installing the CLI globally.

## Commands

Below is a comprehensive reference for all ElizaOS CLI commands, including their options, arguments, and subcommands. For the most up-to-date usage, run `elizaos [command] --help`.

### Project Creation

#### `elizaos create [name]`

Initialize a new project, plugin, or agent.

- **Arguments:**
  - `[name]`: Name for the project, plugin, or agent (optional)
- **Options:**
  - `-d, --dir <dir>`: Installation directory (default: `.`)
  - `-y, --yes`: Skip confirmation and use defaults (default: `false`)
  - `-t, --type <type>`: Type to create: 'project', 'plugin', or 'agent' (default: 'project')

**Important notes:**

- Projects include a knowledge directory and a prompt for database selection (pglite or postgres)
- Plugins are automatically prefixed with "plugin-" if the prefix is missing
- Agents are created as JSON character definition files in the current directory

### Development

#### `elizaos dev`

Start the project or plugin in development mode and rebuild on file changes.

- **Options:**
  - `-c, --configure`: Reconfigure services and AI models
  - `-char, --character [paths...]`: Character file(s) to use - accepts paths or URLs
  - `-b, --build`: Build the project before starting
  - `-p, --port <port>`: Port number to run the server on

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

#### `elizaos setup-monorepo`

Clone ElizaOS monorepo from a specific branch (defaults to v2-develop).

- **Options:**
  - `-b, --branch <branch>`: Branch to install (default: `v2-develop`)
  - `-d, --dir <directory>`: Destination directory (default: `./eliza`)

**Notes:**

- The destination directory must be empty or non-existent
- After cloning, follow the displayed instructions to install dependencies and build the project

### Plugin Management

#### `elizaos plugins <subcommand>`

Manage an ElizaOS plugin.

- **Subcommands:**
  - `list` (aliases: `l`, `ls`): List all available plugins
  - `add <plugin>` (alias: `install`): Add a plugin to the project
    - Arguments: `<plugin>` (plugin name)
    - Options: `-n, --no-env-prompt`, `-b, --branch <branchName>`
  - `installed-plugins`: List plugins found in the project dependencies
  - `remove <plugin>` (aliases: `delete`, `del`, `rm`): Remove a plugin from the project
    - Arguments: `<plugin>` (plugin name)

### Agent Management

#### `elizaos agent <subcommand>`

Manage ElizaOS agents.

- **Subcommands:**
  - `list` (alias: `ls`): List available agents
    - Options: `-j, --json` (output as JSON)
  - `get` (alias: `g`): Get agent details
    - Options:
      - `-n, --name <n>`: Agent id, name, or index number from list
      - `-j, --json`: Display JSON output in terminal
      - `-o, --output <file>`: Save agent data to file
  - `start` (alias: `s`): Start an agent
    - Options:
      - `-n, --name <n>`: Name of an existing agent to start
      - `-j, --json <json>`: Character JSON configuration string
      - `--path <path>`: Local path to character JSON file
      - `--remote-character <url>`: URL to remote character JSON file
  - `stop` (alias: `st`): Stop an agent
    - Options:
      - `-n, --name <n>`: Agent id, name, or index number from list
  - `remove` (alias: `rm`): Remove an agent
    - Options:
      - `-n, --name <n>`: Agent id, name, or index number from list
  - `set`: Update agent configuration
    - Options:
      - `-n, --name <n>`: Agent id, name, or index number from list
      - `-c, --config <json>`: Agent configuration as JSON string
      - `-f, --file <path>`: Path to agent configuration JSON file

**Note:** All agent commands support interactive mode when run without key parameters.

### Publishing

#### `elizaos publish`

Publish a plugin or project to the registry, GitHub, or npm.

- **Options:**
  - `-t, --test`: Run publish tests without actually publishing
  - `-n, --npm`: Publish to npm
  - `-s, --skip-registry`: Skip publishing to the registry

### Agent/Server Management

#### `elizaos start`

Start the Eliza agent with configurable plugins and services.

- **Options:**
  - `-c, --configure`: Force reconfiguration of services and AI models
  - `-char, --character [paths...]`: Character file(s) to use - accepts paths or URLs
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

Run tests for Eliza agent plugins.

- **Options:**
  - `-p, --port <port>`: Port to listen on
  - `-pl, --plugin <n>`: Name of plugin to test
  - `-sp, --skip-plugins`: Skip plugin tests
  - `-spt, --skip-project-tests`: Skip project tests
  - `-sb, --skip-build`: Skip building before running tests

### Trusted Execution Environment (TEE) Management

#### `elizaos tee phala <subcommand>`

Manage TEE deployments with Phala vendor.

- **Subcommands:**
  - `deploy`: Deploy to TEE cloud
    - Options: `-t, --type <type>`, `-m, --mode <mode>`, `-n, --name <n>`, `-c, --compose <compose>`, `-e, --env <env...>`, `--env-file <envFile>`, `--debug`
  - `teepods`: Query the teepods
  - `images`: Query the images
    - Options: `--teepod-id <teepodId>`
  - `upgrade`: Upgrade the TEE CLI
    - Options: `-m, --mode <mode>`, `--app-id <appId>`, `-e, --env <env...>`, `--env-file <envFile>`, `-c, --compose <compose>`
  - `build-compose`: Build a docker-compose file for Eliza Agent
    - Options: `-i, --image <n>`, `-u, --username <n>`, `-t, --tag <tag>`, `-c, --character <path>`, `-e, --env-file <path>`, `-v, --version <version>`
  - `publish`: Publish Docker image to Docker Hub
    - Options: `-i, --image <n>`, `-u, --username <n>`, `-t, --tag <tag>`

### Updates

#### `elizaos update`

Update ElizaOS CLI and project dependencies to the latest versions.

- **Options:**
  - `-c, --check`: Check for available updates without applying them - shows what packages would be updated
  - `-sb, --skip-build`: Skip building after updating
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


### Publishing

#### `elizaos publish`

Publishes the current project or plugin.

- **Options:**
  - `--dry-run`: Test run without publishing
  - `--registry <repo>`: Specify target registry (default: 'elizaOS/registry')

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
   bun run test
   # Or with the CLI directly:
   elizaos test --plugin
   ```

6. **Publish your plugin**:

   ```bash
   # Test publishing process
   elizaos plugins publish --test

   # Publish to registry
   elizaos plugins publish

   # Or publish to npm
   elizaos plugins publish --npm
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
   elizaos project add-plugin @elizaos/plugin-openai
   ```

5. **Run your project in development mode**:

   ```bash
   bun run dev
   # Or with the CLI directly:
   elizaos dev
   ```

6. **Build and start your project**:

   ```bash
   bun run build
   bun run start
   # Or with the CLI directly:
   elizaos start
   ```

7. **Test your project**:
   ```bash
   bun run test
   # Or with the CLI directly:
   elizaos test
   ```

## Contributing

For contributing to the ElizaOS CLI, please clone the monorepo using:

```bash
elizaos setup-monorepo
```
