# @elizaos/plugin-anyone

A plugin for integrating Anyone protocol proxy services into Eliza agents.

## Installation

```bash
pnpm add @elizaos/plugin-anyone
```

## Features

- Start and stop Anyone client services
- Automatic proxy configuration for axios
- SOCKS proxy support (port 9050)
- Clean proxy cleanup and restoration

## Usage

Add the plugin to your agent's configuration:

```typescript
import { anyonePlugin } from "@elizaos/plugin-anyone";

const character = {
    plugins: [anyonePlugin]
};
```

### Available Actions

#### START_ANYONE
Starts the Anyone client and configures proxy settings.

Example commands:
```plaintext
"Can you start Anyone for me?"
"Initialize the Anyone client please"
"Launch Anyone for me"
```

#### STOP_ANYONE
Stops the Anyone client and cleans up proxy settings.

Example commands:
```plaintext
"Can you stop Anyone for me?"
"Please shut down Anyone"
"Close Anyone for me"
```

## Technical Details

The plugin provides two main services:

1. `AnyoneClientService`: Manages the Anyone client instance
    - Singleton pattern implementation
    - Handles client initialization and cleanup
    - Configures SOCKS proxy on port 9050

2. `AnyoneProxyService`: Handles axios proxy configuration
    - Preserves original axios settings
    - Automatically applies proxy settings
    - Provides clean restoration of original config

## Dependencies

- @anyone-protocol/anyone-client: ^0.4.3
- axios: ^1.7.9
