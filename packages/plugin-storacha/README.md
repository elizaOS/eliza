# @elizaos/plugin-storacha

A plugin providing distributed storage functionality for ElizaOS agents.

## Description

The Storacha plugin enables agents to interact with a distributed storage network, allowing for file uploads and retrieval.

## Installation

```bash
pnpm install @elizaos/plugin-storacha
```

## Configuration

1. Add the plugin to the Agent configuration, e.g.
    ```typescript
    // eliza/agent/src/defaultCharacter.ts
    import { storagePlugin } from "@elizaos/plugin-storacha";

    export const defaultCharacter: Character = {
        name: "Eliza",
        username: "eliza",
        plugins: [storagePlugin],
        ...
    };
    ```

2. Create the env var file
    ```bash
    cp .env.example agent/.env
    ```

3. Generate and set the Agent Private Key
   ```bash
   w3 key create
   ```
   - Copy the private key (e.g., `MgCYJE...Ig3Kk=`) and set it to the `STORACHA_AGENT_PRIVATE_KEY` env var.
   - Copy the Agent DID key (e.g., `did:key:...`) to create the Agent Delegation.

4. Create the Agent Delegation
   - Replace `AGENT_DID_KEY` with the DID Key you copied in the previous step and execute:
   ```bash
   w3 delegation create AGENT_DID_KEY \
    --can 'store/add' \
    --can 'filecoin/offer' \
    --can 'upload/add' \
    --can 'space/blob/add' \
    --can 'space/index/add' | base64
   ```
   - Copy the base64 encoded content and set it to the `STORACHA_AGENT_DELEGATION` env var.

## Features

### 1. File Upload

- STORAGE_UPLOAD action for uploading files to the Storacha network
- Supports multiple file types and sizes
- Provides a link to access uploaded files

### 2. File Retrieval

- STORAGE_RETRIEVE action for reading files from the IPFS based on a CID.
- Embeds the file in the Agent response as an attachment, so the user can download it.

## Development

1. Clone the repository

2. Install dependencies

```bash
pnpm install
```

3. Build the plugin

```bash
pnpm run build
```

## Dependencies

- @elizaos/core: workspace:*

## Future Enhancements
- Conversation History & Agent Context Backup
- Cross Agent Data Sharing
- Encryption with LIT Protocol

## License

MIT & Apache 2
