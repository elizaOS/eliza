# ElizaOS CLI

The ElizaOS CLI provides a comprehensive set of commands to manage your ElizaOS projects and plugins, from local development to cloud deployment.

## Installation

```bash
bun install -g @elizaos/cli
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

Initialize a new project or plugin.

- **Arguments:**
  - `[name]`: Name for the project or plugin (optional)
- **Options:**
  - `-d, --dir <dir>`: Installation directory (default: `.`)
  - `-y, --yes`: Skip confirmation (default: `false`)
  - `-t, --type <type>`: Type of template to use (project or plugin)

### Development

#### `elizaos dev`

Start the project or plugin in development mode and rebuild on file changes.

- **Options:**
  - `-c, --configure`: Reconfigure services and AI models
  - `-char, --character <character>`: Path or URL to character file
  - `-b, --build`: Build the project before starting

### Environment Management

#### `elizaos env <subcommand>`

Manage environment variables and secrets.

- **Subcommands:**
  - `list`: List all environment variables
    - Options: `--global`, `--local`
  - `edit-global`: Edit global environment variables
    - Options: `-y, --yes`
  - `edit-local`: Edit local environment variables
    - Options: `-y, --yes`
  - `reset`: Reset all environment variables
    - Options: `-y, --yes`
  - `set-path <path>`: Set a custom path for the global environment file
    - Options: `-y, --yes`
  - `interactive`: Interactive environment variable management
    - Options: `-y, --yes`

### Monorepo Setup

#### `elizaos setup-monorepo`

Clone ElizaOS monorepo from a specific branch (defaults to v2-develop).

- **Options:**
  - `-b, --branch <branch>`: Branch to install (default: `v2-develop`)
  - `-d, --dir <directory>`: Destination directory (default: `./eliza`)

### Plugin Management

#### `elizaos plugin <subcommand>`

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
      - `-n, --name <name>` (required): Agent id, name, or index number from list
      - `-j, --json`: Output as JSON
      - `-o, --output <file>`: Output to file (default: {name}.json)
  - `start` (alias: `s`): Start an agent
    - Options:
      - `-n, --name <n>`: Character name to start the agent with
      - `-j, --json <json>`: Character JSON string
      - `--path <path>`: Local path to character JSON file
      - `--remote-character <url>`: Remote URL to character JSON file
  - `stop` (alias: `st`): Stop an agent
    - Options:
      - `-n, --name <name>` (required): Agent id, name, or index number from list
  - `remove` (alias: `rm`): Remove an agent
    - Options:
      - `-n, --name <name>` (required): Agent id, name, or index number from list
  - `set`: Update agent configuration
    - Options:
      - `-n, --name <name>` (required): Agent id, name, or index number from list
      - `-c, --config <json>`: Agent configuration as JSON string
      - `-f, --file <path>`: Path to agent configuration JSON file

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
  - `-c, --configure`: Reconfigure services and AI models
  - `-char, --character <character>`: Path or URL to character file
  - `-b, --build`: Build the project before starting
  - `-chars, --characters <paths>`: Multiple character configuration files

### Testing

#### `elizaos test`

Run tests for Eliza agent plugins.

- **Options:**
  - `-p, --port <port>`: Port to listen on
  - `-pl, --plugin <name>`: Name of plugin to test
  - `-sp, --skip-plugins`: Skip plugin tests
  - `-spt, --skip-project-tests`: Skip project tests
  - `-sb, --skip-build`: Skip building before running tests

### Trusted Execution Environment (TEE) Management

#### `elizaos tee phala <subcommand>`

Manage TEE deployments with Phala vendor.

- **Subcommands:**
  - `deploy`: Deploy to TEE cloud
    - Options: `-t, --type <type>`, `-m, --mode <mode>`, `-n, --name <name>`, `-c, --compose <compose>`, `-e, --env <env...>`, `--env-file <envFile>`, `--debug`
  - `teepods`: Query the teepods
  - `images`: Query the images
    - Options: `--teepod-id <teepodId>`
  - `upgrade`: Upgrade the TEE CLI
    - Options: `-m, --mode <mode>`, `--app-id <appId>`, `-e, --env <env...>`, `--env-file <envFile>`, `-c, --compose <compose>`
  - `build-compose`: Build a docker-compose file for Eliza Agent
    - Options: `-i, --image <name>`, `-u, --username <name>`, `-t, --tag <tag>`, `-c, --character <path>`, `-e, --env-file <path>`, `-v, --version <version>`
  - `publish`: Publish Docker image to Docker Hub
    - Options: `-i, --image <name>`, `-u, --username <name>`, `-t, --tag <tag>`

### Updates

#### `elizaos update`

Update ElizaOS packages to the latest versions.

- **Options:**
  - `-c, --check`: Check for available updates without applying them
  - `-sb, --skip-build`: Skip building after updating

Manages environment variables in global and local scopes.

- **`list`**: Shows variables from both scopes
- **`edit`**: Interactively edit variables
- **`set <key> <value>`**: Sets/updates a variable
  - `--global` or `--local`: Specify scope
- **`unset <key>`**: Removes a variable
  - `--global` or `--local`: Specify scope
- **`reset`**: Clears all variables (requires confirmation)
  - `--global` or `--local`: Specify scope
- **`set-path <path>`**: Sets custom path for global environment file

### Publishing

#### `elizaos publish`

Publishes the current project or plugin.

- **Options:**
  - `--dry-run`: Test run without publishing
  - `--registry <repo>`: Specify target registry (default: 'elizaOS/registry')

## Development Guide

### Developing Plugins

Plugins extend the functionality of ElizaOS agents by providing additional capabilities or integrations.

1. **Create a new plugin**:

   ```bash
   elizaos create my-plugin --type plugin
   cd plugin-my-plugin
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
   elizaos plugin publish --test

   # Publish to registry
   elizaos plugin publish

   # Or publish to npm
   elizaos plugin publish --npm
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
