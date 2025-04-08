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

### Project Creation and Management

#### `elizaos create [name]`

Initializes a new ElizaOS project or plugin.

- **`[name]`**: (Optional) The name for the new project or plugin directory
- **Options:**
  - `-d, --dir <dir>`: Specify the directory for creation (default: current directory)
  - `-y, --yes`: Skip confirmation prompts
  - `-t, --type <type>`: Specify 'project' or 'plugin' to create

#### `elizaos project ...`

Manages project-specific configurations and plugins.

- **`list-plugins`**: Lists available plugins
  - `-t, --type <type>`: Filter by plugin type (adapter, client, plugin)
- **`add-plugin <plugin>`**: Adds a plugin to the current project
  - `--no-env-prompt`: Skip prompting for environment variables
- **`remove-plugin <plugin>`**: Removes a plugin from the current project

#### `elizaos setup-monorepo`

Clones the main `elizaOS/eliza` monorepo locally.

- **Options:**
  - `-b, --branch <branch>`: Specify branch (default: 'v2-develop')
  - `-d, --dir <directory>`: Specify destination directory (default: './eliza')

### Plugin Development

#### `elizaos plugin ...`

Manages plugin development workflows.

- **`publish`**: Publishes the plugin to a registry
  - `-r, --registry <registry>`: Target registry (default: 'elizaOS/registry')
  - `-n, --npm`: Publish to npm instead of GitHub registry
  - `-t, --test`: Run in test mode without making changes
  - `-p, --platform <platform>`: Specify platform compatibility

### Agent Management

#### `elizaos agent ...`

Interacts with the ElizaOS Agent Runtime API.

- **`list`** (alias: `ls`): Lists all agents
  - `-j, --json`: Output in JSON format
- **`get`** (alias: `g`): Gets details about a specific agent
  - `-n, --name <name>`: Agent ID, name, or index
  - `-j, --json`: Output in JSON format
  - `-o, --output <file>`: Save configuration to file
- **`start`** (alias: `s`): Starts a new agent instance
  - `-n, --name <name>`: Use pre-defined character name
  - `-j, --json <json>`: Provide character definition as JSON
  - `-p, --path <path>`: Load definition from local file
  - `-r, --remote <url>`: Load definition from remote URL
- **`stop`** (alias: `st`): Stops a specific agent
  - `-n, --name <name>`: Agent to stop
- **`restart`** (alias: `r`): Restarts a specific agent
  - `-n, --name <name>`: Agent to restart

### Server Management

#### `elizaos start`

Starts the main ElizaOS server process.

- **Options:**
  - `--configure`: Force reconfiguration
  - `-p, --port <port>`: Specify server port (default: 3000)
  - `-c, --character <path>`: Start a single agent using specified file
  - `-d, --data-dir <path>`: Specify data directory for persistence

#### `elizaos stop`

Stops all running ElizaOS processes initiated by the CLI.

#### `elizaos dev`

Starts the ElizaOS server in development mode with hot reloading.

- **Options:**
  - `-p, --port <port>`: Specify development server port

### Updates and Maintenance

#### `elizaos update`

Updates all `@elizaos/*` dependencies in the current project.

- **Options:**
  - `--check`: Check for updates without installing
  - `--skip-build`: Skip automatic build after updating

#### `elizaos update-cli`

Updates the globally installed CLI package to the latest version.

### Testing

#### `elizaos test`

Runs tests for the current project or plugin.

- **Options:**
  - `-p, --port <port>`: Specify test server port
  - `--plugin`: Force testing as a plugin
  - `--skip-plugins`: Skip plugin-related tests
  - `--skip-project-tests`: Skip project-specific tests
  - `--skip-build`: Skip build step before testing

### Environment Variables

#### `elizaos env ...`

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
   │   └── plugin.ts      # Custom project plugin implementation
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
