# @elizaos/plugin-obsidian

An Obsidian plugin for ELIZA OS that provides seamless integration with Obsidian vaults, enabling powerful file and note management capabilities.

## Features

1. Deep traversal of Obsidian notes:
   - Implementing hierarchical note structure analysis
   - Enabling traversal of note links and backlinks
   - Storing hierarchy data in memory for efficient access

2. Advanced search functionality:
   - Full-text search across all vault files
   - Support for regex patterns and context-aware searches
   - Integration with Obsidian's native search capabilities using Obsidian's Rest API

3. Obsidian memory store integration:
   - Building and maintaining a knowledge base from vault notes
   - Implementing efficient data structures for quick retrieval

4. Naval database integration as an example:
   - Demonstrating how to import and structure obsidian notes in the agent memory
   - Showcasing integration of Naval's wisdom and quotes
   - Creating a knowledge base from Naval's vault notes for the agent
   - Naval's character json file is included in the PR for reference (found in the example directory)

### Vault Operations

- **List Files**
  - Get all files in the vault

  ```typescript
  // List all files
  const files = await obsidian.listFiles(); // Example: "List all files"
  ```

- **Directory Management**
  - List directory contents

  ```typescript
  // List directory contents
  const contents = await obsidian.listDirectory("path/to/dir"); // Example: "List directory PATH" or "ls PATH"
  ```

### Note Management

- **Note Retrieval**
  - Get note content and metadata
  - Support for frontmatter parsing

  ```typescript
  // Get a note with its content
  const note = await obsidian.getNote("path/to/note.md"); // Example: "Get note PATH"
  ```

- **Deep Traversal**
  - Build hierarchical note structures
  - Store hierarchy data in memory
  - Traverse note links and backlinks

  ```typescript
  // Traverse notes links
  const hierarchy = buildLinkHierarchy("path/to/start-note.md"); // Example: "Map links in PATH"
  ```

- **Create Knowledge Bases**
  - Build memory knowledge base from vault notes

  ```typescript
  // Build knowledge base
  const knowledgeBase = await obsidian.createMemoriesFromFiles(); // Example: "Create knowledge base"
  ```

### Search Capabilities

- **Full-Text Search**
  - Search across all vault files
  - Support for regex patterns
  - Support for context search
  - Support for frontmatter search

  ```typescript
  // Search in vault
  const results = await obsidian.search("query");
  // Examples: "Search QUERY" or "find notes with 'YOUR QUERY'" or "search notes named 'FILENAME'"
  ```

### File Operations

- **Read Files**
  - Read files in the Obsidian Vault

  ```typescript
  // Open a file in Obsidian
  await obsidian.readFile("DOCUMENTS/report.txt"); // Example: "Read DOCUMENTS/report.txt"
  ```

- **Create/Save Files**
  - Create new files with automatic directory creation
  - Save content to existing files
  - Support for various file types

  ```typescript
  // Create or update a file
  await obsidian.saveFile("DOCUMENTS/report.txt", "Content", true); // Example: "Save DOCUMENTS/report.txt"
  ```

- **Open Files**
  - Open files in the Obsidian Vault
  - Seamless integration with Obsidian's Rest API

  ```typescript
  // Open a file in Obsidian
  await obsidian.openFile("DOCUMENTS/report.txt"); // Example: "Open DOCUMENTS/report.txt"
  ```

- **Update Files**
  - Update existing files without creating new ones
  - Line-specific updates supported

  ```typescript
  // Update an existing file
  await obsidian.patchFile("DOCUMENTS/report.txt", "New content"); // Example: "Update DOCUMENTS/report.txt"
  ```

## Installation

```bash
npm install @elizaos/plugin-obsidian
# or
yarn add @elizaos/plugin-obsidian
# or
pnpm add @elizaos/plugin-obsidian
```

## Configuration

The plugin requires the following character secret settings:

```json
{
    "settings": {
        "secrets": {
            "OBSIDIAN_API_TOKEN": "your-obsidian-api-token",
            "OBSIDIAN_API_PORT": "your-obsidian-api-port", // Optional (default: 27123)
            "OBSIDIAN_API_URL": "https://your-obsidian-api-url" , // Optional (default: "http://127.0.0.1:27123")
        },
        // other settings...
    }
}
```

## Usage

Import and register the plugin in your Eliza agent configuration:

```typescript
import { obsidianPlugin } from '@elizaos/plugin-obsidian';

export default {
  plugins: [
    // other plugins...
    getSecret(character, "OBSIDIAN_API_TOKEN") ? obsidianPlugin : null,
    // other plugins...
  ]
};
```

## Development

```bash
# Build the plugin
pnpm build

# Run in development mode
pnpm dev

# Run tests
pnpm test

# Run linting
pnpm lint
```

## Actions

The plugin provides several actions that can be used with ELIZA OS:

- `SAVE_FILE`: Create or update files
- `OPEN_FILE`: Open files in Obsidian
- `UPDATE_FILE`: Update existing files
- `GET_NOTE`: Retrieve note content
- `NOTE_TRAVERSAL`: Build note hierarchies
- `SEARCH`: Search vault contents
- `LIST_FILES`: List vault files
- `LIST_DIRECTORY`: List directory contents
- `CREATE_KNOWLEDGE`: Generate knowledge bases
- `GET_ACTIVE_NOTE`: Get current note
- `SUMMARIZE_ACTIVE_NOTE`: Summarize current note

## Error Handling

The plugin provides detailed error messages and proper error handling:

```typescript
try {
  await obsidian.saveFile("path/to/file", "content");
} catch (error) {
  if (error.code === 'FILE_NOT_FOUND') {
    // Handle file not found
  }
  // Handle other errors
}
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, please:

1. Check the [documentation](https://elizaos.github.io/eliza/)
2. Open an issue in the repository
3. Join our [Discord community](https://discord.gg/elizaos)
