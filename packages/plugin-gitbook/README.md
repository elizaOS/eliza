# @elizaos/plugin-gitbook

A plugin for querying and retrieving information from GitBook documentation within the ElizaOS ecosystem.

## Description

This plugin enables seamless integration with GitBook documentation, allowing natural language queries to retrieve relevant documentation content. It features intelligent query validation, keyword-based filtering, and clean response formatting to provide accurate documentation answers.

## Installation

```bash
pnpm install @elizaos/plugin-gitbook
```

## Configuration

### Environment Variables
```typescript
GITBOOK_SPACE_ID=<Your GitBook Space ID>
```

### Client Configuration (Optional)
You can customize the plugin's behavior by adding the following configuration to your character.json file:
```json
{
    "name": "YourCharacter",
    "plugins": ["gitbook"],
    "settings": {
        "gitbook": {
            "keywords": {
                "projectTerms": ["term1", "term2"],         // Optional: Project-specific terms to match
                "generalQueries": ["custom1", "custom2"]    // Optional: Additional query keywords
            },
            "documentTriggers": ["docs", "documentation"]   // Optional: Trigger words for documentation
        }
    }
}
```

The plugin will work with default settings if no configuration is provided, but adding custom configuration can help tailor the responses to your specific documentation needs.

## Usage

### Basic Integration

```typescript
import { gitbookPlugin } from '@elizaos/plugin-gitbook';
```

### Example Usage

The plugin automatically processes natural language queries:

```typescript
"How do I get started with the project?"
"What are the main features?"
"Explain how to configure the system"
```

## API Reference

### Providers

#### GitBook Provider

Handles documentation queries and returns relevant information.

**Response Type:**
```typescript
interface GitBookResponse {
    answer?: {
        text: string;
    };
    error?: string;
}
```

**Configuration Types:**
```typescript
interface GitBookKeywords {
    projectTerms?: string[];      // Project-specific terms
    generalQueries?: string[];    // Additional query keywords
}

interface GitBookClientConfig {
    keywords?: GitBookKeywords;
    documentTriggers?: string[];  // Trigger words for documentation
}
```

## Common Issues & Troubleshooting

1. **Connection Issues**
   - Verify GitBook Space ID is correct
   - Check API endpoint accessibility
   - Ensure proper network connectivity

2. **Query Issues**
   - Verify query contains valid keywords
   - Check if query matches project terms
   - Ensure proper query formatting

3. **Response Issues**
   - Validate GitBook API response format
   - Check for rate limiting
   - Verify content accessibility

## Security Best Practices

1. **API Configuration**
   - Store Space ID securely
   - Use environment variables
   - Implement proper error handling

2. **Query Validation**
   - Sanitize input queries
   - Validate keywords and triggers
   - Clean response content

3. **Response Handling**
   - Implement proper error handling
   - Validate response format
   - Handle sensitive information appropriately

## Development Guide

### Setting Up Development Environment

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run tests:

```bash
pnpm test
```

## Future Enhancements

- Enhanced query validation
- Support for multiple GitBook spaces
- Advanced search capabilities
- Custom response formatting
- Caching mechanism for frequent queries
- Support for authenticated endpoints

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## Credits

This plugin integrates with and builds upon several key technologies:

- [GitBook](https://www.gitbook.com/): Documentation and knowledge base platform
- [GitBook API](https://developer.gitbook.com/): Official GitBook REST API
- [Axios](https://axios-http.com/): Promise-based HTTP client
- [js-tiktoken](https://github.com/dqbd/tiktoken): Token counting for API responses

Special thanks to:
- The GitBook team for their documentation platform
- The GitBook Developer Relations team
- The Axios maintainers for reliable HTTP requests
- The Eliza community for their contributions and feedback

For more information about GitBook capabilities:
- [GitBook Documentation](https://docs.gitbook.com/)
- [GitBook API Reference](https://developer.gitbook.com/reference)
- [GitBook Integrations](https://docs.gitbook.com/integrations/git-sync)
- [GitBook Space Management](https://docs.gitbook.com/space/space-management)

## License

This plugin is part of the Eliza project. See the main project repository for license information.
