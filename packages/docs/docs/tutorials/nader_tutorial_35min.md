# How to Build an API Plugin

This guide walks you through creating a custom plugin for the Eliza AI framework that integrates with NASA's API to fetch space photos. You'll learn how to set up the project structure, implement the required components, and test your plugin across different interfaces.

## Video Tutorial

<div className="responsive-iframe">                                                                                               
  <iframe                                                                                                                         
    src="https://www.youtube.com/embed/25FxjscBHuo" 
    title="YouTube video player"                                                                                                  
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"                              
    allowFullScreen                                                                                                               
  />                                                                                                                              
</div> 
Code: https://github.com/dabit3/eliza-nasa-plugin


**Key Timestamps**

- **0:00** - Introduction to Eliza plugins and their importance
- **3:36** - Overview of the NASA API plugin we'll be building
- **6:40** - Setting up the project structure
- **12:26** - Creating the basic plugin files
- **18:64** - Understanding plugin components
- **32:84** - Implementing the NASA API service
- **43:22** - Setting up environment variables
- **59:12** - Testing the plugin in web interface
- **1:15:00** - Testing the plugin with Twitter integration

## Why Build Plugins?

Plugins are powerful extensions to the Eliza framework that allow you to:
- Integrate custom functionality into agent workflows
- Share reusable components with other developers
- Expand the capabilities of your AI agents
- Distribute your software products to developers
- Take advantage of growing opportunities in the agent space

## Development Approaches

You have two options for developing an Eliza plugin:

### Option 1: Using the Starter Template

:::warning
Untested in over a month, this might not work!
:::

```
git clone https://github.com/elizaOS/eliza-plugin-starter.git
cd eliza-plugin-starter
pnpm install
pnpm tsc
pnpm mock-eliza --characters=./characters/eternalai.character.json
```

### Option 2: Building from Scratch

If you prefer to understand every component by building from scratch (as shown in the video tutorial), follow the manual setup process below.

### Project Structure

For building from scratch, your project structure will look like this:

```
plugin-name/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts          # Main plugin entry
    ├── types.ts          # Type definitions
    ├── environment.ts    # Environment config
    ├── services/         # API services
    ├── actions/          # Plugin actions
    └── examples/         # Usage examples
```

> When using the starter template, you'll find additional directories like `common/` for shared utilities and mocked client capabilities for testing.


## Setup Steps

1. **Create and Initialize Project**
```bash
# Create project directory
mkdir eliza-plugin-nasa
cd eliza-plugin-nasa

# Clone Eliza repository
git clone git@github.com:elizaOS/eliza.git
cd eliza
git checkout $(git describe --tags --abbrev=0)
```

2. **Create Project Directory**
```bash
cd packages
mkdir eliza-plugin-nasa
cd eliza-plugin-nasa
```

3. **Create Base Configuration Files**

Create `package.json`:
```json
{
  "name": "@elizaos/plugin-nasa",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@elizaos/core": "latest"
  },
  "peerDependencies": {
    "@elizaos/core": "^1.0.0"
  }
}
```

Create `tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

Create `tsup.config.ts`:
```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
})
```

4. **Create Project Structure**

```bash
# Create directories
mkdir src
mkdir src/actions

# Create essential files
touch package.json tsconfig.json tsup.config.ts
touch src/index.ts src/types.ts src/examples.ts
touch src/services.ts src/environment.ts
touch src/actions/getMarsRoverPhoto.ts src/actions/getApod.ts
```

4. **Configure Character File**

Create `src/characters/natter.character.ts`:

```typescript
import { ModelProviderName, Clients } from "@elizaos/core";
import { nasaPlugin } from '@elizaos/plugin-nasa'

export const mainCharacter = {
    name: "sound_craft_",
    clients: [Clients.TWITTER],
    modelProvider: ModelProviderName.HYPERBOLIC,
    plugins: [nasaPlugin],
    // ... rest of character configuration
};
```

See example: https://github.com/dabit3/eliza-nasa-plugin/blob/main/agent/src/nader.character.ts

---

## Core Components

### Types

Source: `src/types.ts`

```typescript
interface ApodResponse {
    url: string;
    title: string;
    explanation: string;
    date: string;
}

interface MarsRoverResponse {
    photos: Array<{
        img_src: string;
        earth_date: string;
        camera: {
            name: string;
        }
    }>;
}
```

### Plugin Entry

Source: `src/index.ts`

```typescript
import type { Plugin } from "@elizaos/core";
import { getMarsRoverPhoto } from './actions/getMarsRoverPhoto';
import { getApod } from './actions/getApod';

export const nasaPlugin: Plugin = {
    name: "nasa-plugin",
    description: "NASA API integration for space photos",
    actions: [getMarsRoverPhoto, getApod]
};
```

### Actions
Actions define how your plugin responds to messages:

```typescript
import { Action, IAgentRuntime } from "@elizaos/core";

export const getMarsRoverPhoto: Action = {
    name: "NASA_GET_MARS_PHOTO",
    similes: ["SHOW_MARS_PICTURE"],
    description: "Fetches a photo from Mars rovers",
    
    validate: async (runtime: IAgentRuntime) => {
        return validateNasaConfig(runtime);
    },
    
    handler: async (runtime: IAgentRuntime, state: any, callback: any) => {
        const data = await getNasaService(runtime).getMarsRoverPhoto();
        await callback(`Here's a photo from Mars rover ${data.rover}...`);
        return true;
    }
};
```

Source: `src/actions/getMarsRoverPhoto.ts`

### Services
Services handle API interactions:

```typescript
const nasaService = (config: NasaConfig) => ({
    getMarsRoverPhoto: async () => {
        const response = await fetch(
            `https://api.nasa.gov/mars-photos/api/v1/rovers/curiosity/photos?api_key=${config.apiKey}`
        );
        return response.json();
    }
});
```

### Environment Configuration

Create `.env` in the root directory:
```bash
NASA_API_KEY=your_api_key_here
TWITTER_USERNAME=your_twitter_username
TWITTER_PASSWORD=your_twitter_password
TWITTER_EMAIL=your_twitter_email
```

```typescript
const validateNasaConfig = (runtime: IAgentRuntime) => {
    const config = {
        apiKey: runtime.getSetting("NASA_API_KEY")
    };
    if (!config.apiKey) {
        throw new Error("NASA API key not configured");
    }
    return config;
};
```

## Testing Your Plugin

> See 00:12:39 in the video

### Development Testing
```bash
# Using mock client
pnpm mock-eliza --characters=./characters/eternalai.character.json
```

### Production Testing
```bash
# Web interface
pnpm start client
# Visit localhost:5173

# Twitter integration
# Ensure Twitter credentials are configured in .env
pnpm start
```


---

## FAQ

### How should I handle errors in my plugin?
Validate environment variables before making API calls and provide meaningful error messages. Implement retry logic for failed requests to improve reliability.

### What's the best way to ensure type safety?
Define interfaces for API responses and use TypeScript throughout your plugin to maintain type consistency and get better development experience.

### How should I organize my plugin code?
Separate concerns into distinct files, follow consistent naming conventions, and thoroughly document your code for maintainability.

### Why isn't my plugin loading?
Verify your package.json configuration, check that the plugin is properly registered in the character file, and ensure all dependencies are installed correctly.

### Why isn't my action triggering? 
Review your action examples for accuracy, check the validate function logic, and verify that the action is properly registered in your plugin.

### What should I do if I have API integration issues?
Confirm your API key is properly configured, verify the API endpoint URLs are correct, and check that responses are being handled appropriately.
