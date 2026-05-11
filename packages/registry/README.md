# elizaOS Registry

<img src="static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

## Intro

elizaOS supports dynamic plugin loading directly from the package registry. This registry serves as the central directory for all elizaOS plugins, rendered in the elizaOS CLI and the registry web page at [docs.elizaos.ai](https://docs.elizaos.ai/plugins/registry).

## Registry Format

The `index.json` file contains plugin mappings in the following format:

```json
{
  "@npm-package-name": "github:organization/repository-name"
}
```

**Format Requirements:**
- **Left side (key)**: NPM package name (e.g., `@elizaos/plugin-solana`)
- **Right side (value)**: GitHub repository reference (e.g., `github:elizaos-plugins/plugin-solana`)
- Each plugin must be on its own line with proper JSON formatting
- Entries should be alphabetically sorted by package name

**Example entries:**
```json
{
  "@elizaos/plugin-discord": "github:elizaos-plugins/plugin-discord",
  "@elizaos/plugin-solana": "github:elizaos-plugins/plugin-solana",
  "@elizaos/plugin-twitter": "github:elizaos-plugins/plugin-twitter"
}
```

### Available Plugins

All official plugins are hosted at [github.com/elizaos-plugins](https://github.com/elizaos-plugins/). Currently available plugins include:

- [@elizaos/plugin-solana](https://github.com/elizaos-plugins/plugin-solana) - Solana blockchain integration
- [@elizaos/plugin-discord](https://github.com/elizaos-plugins/plugin-discord) - Discord bot integration
- [@elizaos/plugin-twitter](https://github.com/elizaos-plugins/plugin-twitter) - Twitter bot integration
- [@elizaos/plugin-whatsapp](https://github.com/elizaos-plugins/plugin-whatsapp) - WhatsApp integration
- [@elizaos/plugin-browser](https://github.com/elizaos-plugins/plugin-browser) - Web scraping capabilities
- [@elizaos/plugin-pdf](https://github.com/elizaos-plugins/plugin-pdf) - PDF processing
- [@elizaos/plugin-image](https://github.com/elizaos-plugins/plugin-image) - Image processing and analysis
- [@elizaos/plugin-video](https://github.com/elizaos-plugins/plugin-video) - Video processing capabilities
- [@elizaos/plugin-local-ai](https://github.com/elizaos-plugins/plugin-local-ai) - Local LLaMA model integration

Visit the our [Registry Hub](https://eliza.how/packages)

## Contributing to the Registry

To add your plugin to the elizaOS Registry, follow these steps:

### 1. Prepare Your Plugin
Ensure your plugin follows the [Plugin Development Guidelines](#plugin-development-guidelines) and includes:
- Proper plugin structure and interface implementation
- Complete documentation in your repository
- Working demo evidence
- Required branding assets (logo.png, banner.png)
- GitHub topics including `elizaos-plugins`

### 2. Submit Your Plugin
Create a Pull Request that **ONLY modifies the `index.json` file**:

1. Fork this repository
2. Edit the `index.json` file to add your plugin entry:
   ```json
   {
     "@your-org/plugin-name": "github:your-org/your-plugin-repo"
   }
   ```
3. Ensure your entry follows the alphabetical sorting
4. **Important**: Do not modify any other files - PRs that change files other than `index.json` will be rejected
5. Create a Pull Request with a clear description of your plugin

### 3. Automated Review Process
- Our Claude Code review workflow will automatically check that only `index.json` is modified
- The review will verify the JSON format and contribution guidelines
- If other files are modified, you'll receive feedback to remove those changes
- Once approved, your plugin will be automatically processed and added to the generated registry

### 4. Registry Generation
After your PR is merged:
- A GitHub Action automatically processes your plugin entry
- The `generated-registry.json` file is updated with your plugin's metadata
- Your plugin becomes available in the elizaOS CLI and web registry

**Remember**: Only contribute plugins you own or have permission to register. The registry serves the entire elizaOS community.

### Adding Plugins on eliza

1. **package.json:**

```json
{
  "dependencies": {
    "@elizaos/plugin-solana": "github:elizaos-plugins/plugin-solana",
    "@elizaos/plugin-twitter": "github:elizaos-plugins/plugin-twitter"
  }
}
```

2. **Character configuration:**

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-solana", "@elizaos/plugin-twitter"]
}
```

## Plugin Architecture

### Plugin Development

elizaOS uses a unified plugin architecture where everything is a plugin - including clients, adapters, actions, evaluators, and services. This approach ensures consistent behavior and better extensibility. Here's how the architecture works:

1. **Plugin Types**: Each plugin can provide one or more of the following:

   - Clients (e.g., Discord, Twitter, WhatsApp integrations)
   - Adapters (e.g., database adapters, caching systems)
   - Bootstrap (e.g., how the bot responds to events)
   - Model Providers (e.g., OpenAI-compatible, local-ai, ollama, etc)

2. **Plugin Interface**: All plugins implement the core Plugin interface:
   1.x (https://github.com/elizaOS/plugin-specification/blob/f800a4340e95123838c594528fa26ddff7ec9ecd/core-plugin-v2/src/types.ts#L569)

   ```typescript
   type Plugin = {
     name: string;
     description: string;
     init?: (
       config: Record<string, string>,
       runtime: IAgentRuntime
     ) => Promise<void>;
     config?: { [key: string]: any };
     services?: Service[];
     componentTypes?: {
       name: string;
       schema: Record<string, unknown>;
       validator?: (data: any) => boolean;
     }[];
     actions?: Action[];
     providers?: Provider[];
     evaluators?: Evaluator[];
     adapter?: IDatabaseAdapter;
     models?: {
       [key: string]: (...args: any[]) => Promise<any>;
     };
     events?: {
       [K in keyof EventPayloadMap]?: EventHandler<K>[];
     } & {
       [key: string]: ((params: EventPayload) => Promise<any>)[];
     };
     routes?: Route[];
     tests?: TestSuite[];
   };
   ```

   0.x (https://github.com/elizaOS/plugin-specification/blob/f800a4340e95123838c594528fa26ddff7ec9ecd/core-plugin-v1/src/types.ts#L664)

   ```typescript
   type Plugin = {
     name: string;
     description: string;
     config?: { [key: string]: any };
     actions?: Action[];
     providers?: Provider[];
     evaluators?: Evaluator[];
     services?: Service[];
     clients?: Client[];
     adapters?: Adapter[];
   };
   ```

3. **Independent Repositories**: Each plugin lives in its own repository, allowing:

   - Independent versioning and releases
   - Focused issue tracking and documentation
   - Easier maintenance and contribution
   - Separate CI/CD pipelines

4. **Plugin Structure**: Each plugin repository should follow this structure:

   ```
   plugin-name/
   ├── images/
   │   ├── logo.jpg        # Plugin branding logo
   │   ├── banner.jpg      # Plugin banner image
   ├── src/
   │   ├── index.ts        # Main plugin entry point
   │   ├── actions/        # Plugin-specific actions
   │   ├── clients/        # Client implementations
   │   ├── adapters/       # Adapter implementations
   │   └── types.ts        # Type definitions
   │   └── environment.ts  # runtime.getSetting, zod validation
   ├── package.json        # Plugin dependencies
   └── README.md          # Plugin documentation
   ```

5. **Package Configuration**: Your plugin's `package.json` must include an `agentConfig` section:

   ```json
   {
     "name": "@elizaos/plugin-example",
     "version": "1.0.0",
     "agentConfig": {
       "pluginType": "elizaos:plugin:1.0.0",
       "pluginParameters": {
         "API_KEY": {
           "type": "string",
           "description": "API key for the service"
         }
       }
     }
   }
   ```

6. **Plugin Loading**: Plugins are dynamically loaded at runtime through the `handlePluginImporting` function, which:

   - Imports the plugin module
   - Reads the plugin configuration
   - Validates plugin parameters
   - Registers the plugin's components (clients, adapters, actions, etc.)

7. **Client and Adapter Implementation**: When implementing clients or adapters:

0.x

```typescript
// Client example
const discordPlugin: Plugin = {
  name: "discord",
  description: "Discord client plugin",
  clients: [DiscordClientInterface],
};

// Adapter example
const postgresPlugin: Plugin = {
  name: "postgres",
  description: "PostgreSQL database adapter",
  adapters: [PostgresDatabaseAdapter],
};

// Adapter example
export const browserPlugin = {
  name: "default",
  description: "Pdf",
  services: [PdfService],
  actions: [],
};
```

### Environment Variables and Secrets

Plugins can access environment variables and secrets in two ways:

1. **Character Configuration**: Through `agent.json.secret` or character settings:

   ```json
   {
     "name": "MyAgent",
     "settings": {
       "secrets": {
         "PLUGIN_API_KEY": "your-api-key",
         "PLUGIN_SECRET": "your-secret"
       }
     }
   }
   ```

2. **Runtime Access**: Plugins can access their configuration through the runtime:
   ```typescript
   class MyPlugin implements Plugin {
     async initialize(runtime: AgentRuntime) {
       const apiKey = runtime.getSetting("PLUGIN_API_KEY");
       const secret = runtime.getSetting("PLUGIN_SECRET");
     }
   }
   ```

The `getSetting` method follows this precedence:

1. Character settings secrets
2. Character settings
3. Global settings

### Plugin Registration

1. Add it to your agent's character configuration:

   ```json
   {
     "name": "MyAgent",
     "plugins": ["@elizaos/plugin-example"]
   }
   ```

2. Include it in your package.json:
   ```json
   {
     "dependencies": {
       "@elizaos/plugin-example": "github:elizaos-plugins/plugin-example"
     }
   }
   ```

### Creating a New Plugin

1. Use any of the already mentioned list plugins, such as [web-search](https://github.com/elizaos-plugins/plugin-web-search) as a starting point
2. Implement the Plugin interface:
   ```typescript
   interface Plugin {
     actions?: Action[];
     evaluators?: Evaluator[];
     services?: Service[];
     providers?: Provider[];
     initialize?(runtime: AgentRuntime): Promise<void>;
   }
   ```
3. Create a plugin.json file with metadata and configuration schema
4. Document your plugin's functionality and required environment variables

### Plugin Development Guidelines

1. **Minimal Dependencies**: Only include necessary dependencies
2. **Clear Documentation**: Document all required environment variables
3. **Error Handling**: Gracefully handle missing or invalid configuration
4. **Type Safety**: Use TypeScript for better developer experience
5. **Testing**: Include tests for core functionality
6. **GitHub Topics**: Add `elizaos-plugins` as a topic to your repository along with relevant tags like `ai`, `crypto`, `social`, etc. to help with discovery and categorization

### Pull Request Requirements

When submitting a plugin to the elizaOS Registry, your PR must include:

1. **Working Demo Evidence:**

   - Screenshots or video demonstrations of the plugin working with elizaOS
   - Test results showing successful integration
   - Example agent configuration using your plugin
   - Documentation of any specific setup requirements

2. **Integration Testing:**

   - Proof of successful dynamic loading with elizaOS
   - Test cases covering main functionality
   - Error handling demonstrations
   - Performance metrics (if applicable)

3. **Configuration Examples:**

   ```json
   {
     "name": "MyAgent",
     "plugins": ["@elizaos/your-plugin"],
     "settings": {
       "your-plugin": {
         // Your plugin's configuration
       }
     }
   }
   ```

4. **Quality Checklist:**
   - [ ] Plugin follows the standard structure
   - [ ] All required branding assets are included
   - [ ] Documentation is complete and clear
   - [ ] GitHub topics are properly set
   - [ ] Tests are passing
   - [ ] Demo evidence is provided

Visit the [elizaOS Plugin Development Guide]([https://github.com/elizaos-plugins/plugin-image](https://github.com/elizaOS/eliza/blob/main/docs/docs/packages/plugins.md) for detailed information on creating new plugins.

### Plugin Branding and Images

To maintain a consistent and professional appearance across the elizaOS ecosystem, we recommend including the following assets in your plugin repository:

1. **Required Images:**

   - `logo.png` (400x400px) - Your plugin's square logo
   - `banner.png` (1280x640px) - A banner image for your plugin
   - `screenshot.png` - At least one screenshot demonstrating your plugin's functionality

2. **Image Location:**
   ```
   plugin-name/
   ├── assets/
   │   ├── logo.png
   │   ├── banner.png
   │   └── screenshots/
   │       ├── screenshot1.png
   │       └── screenshot2.png
   ```
3. **Image Guidelines:**
   - Use clear, high-resolution images
   - Keep file sizes optimized (< 500KB for logos, < 1MB for banners)
   - [Image example](https://github.com/elizaos-plugins/client-twitter/blob/main/images/banner.jpg)
   - Include alt text for accessibility

## Automated Registry Generation

This repository includes an automated system that generates a processed `generated-registry.json` file whenever the `index.json` file is updated on the main branch.

### How it works:

1. **Source Data**: The `index.json` file contains the raw registry mappings from plugin names to GitHub repositories
2. **GitHub Action**: When `index.json` is pushed to the main branch, a GitHub Action automatically runs
3. **Processing**: The action processes each plugin entry to gather:
   - Version information from Git tags
   - NPM package metadata
   - Branch information for different ElizaOS versions (v0.x and v1.x)
   - Compatibility information
4. **Output**: A comprehensive `generated-registry.json` file is generated and committed back to the repository

### Using the Generated Registry

The CLI and other tools can fetch the processed registry data directly from the raw GitHub URL:

```bash
# Fetch the processed registry data
curl https://raw.githubusercontent.com/elizaos-plugins/registry/main/generated-registry.json
```

This provides:

- Real-time version information
- Compatibility details
- Installation guidance
- Complete plugin metadata

### Manual Generation

You can also generate the registry manually:

```bash
# Install dependencies
npm install

# Generate registry.json (requires GITHUB_TOKEN environment variable)
npm run generate-registry
```

The generated file will be `generated-registry.json` and contains the same format as served by the Next.js API, making it easy to switch between the API and static file approaches.
