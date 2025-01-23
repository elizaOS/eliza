# @elizaos/plugin-dkg

A plugin enabling integration with the OriginTrail Decentralized Knowledge Graph (DKG) for enhanced search and knowledge management capabilities in ElizaOS agents.

## Description

The DKG plugin extends ElizaOS functionality by allowing agents to interact with the OriginTrail Decentralized Knowledge Graph. This plugin enables SPARQL-based searches on the DKG and combines these results with Eliza's regular search results. Additionally, it creates a memory as a Knowledge Asset on the DKG after a response, making it available for future SPARQL queries.

## Installation

```bash
pnpm install @elizaos/plugin-dkg
```

## Features

### 1. DKG Integration

- Perform SPARQL queries on the DKG for knowledge extraction.
- Combine DKG query results with Eliza's internal search capabilities.
- Enhance responses with decentralized and trusted knowledge.

### 2. Knowledge Asset Creation

- Automatically generate Knowledge Assets based on interactions.
- Publish memory Knowledge Assets to the DKG for future retrieval.

## Providers

### 1. DKG Search Provider

- Executes SPARQL queries on the OriginTrail DKG.
- Retrieves and formats relevant results.
- Integrates DKG data with Eliza’s response system.

## Plugins

### 1. Memory Creation Plugin

- Creates Knowledge Assets from agent interactions.
- Publishes assets to the DKG with contextual metadata.

## Development

1. Clone the repository
2. Install dependencies:

```bash
pnpm install
```

3. Build the plugin:

```bash
pnpm run build
```

4. Run linting:

```bash
pnpm run lint
```

## Usage

### 1. Set Up Environment Variables

- Copy the `.env.example` file and rename it to `.env`.
- Fill in the necessary details:
    - Node information.
    - LLM key.
    - Twitter credentials.

### 2. Customize DKG Knowledge Asset & Query Templates

- Modify the templates in `plugin-dkg/constants.ts` if you need to change the ontology or data format used in the Knowledge Graph.
- Check if the graph search provider is passing context to the agent (packages/client-twitter/src/interactions.ts, twitterMessageHandlerTemplate)

### 3. Create a Character and Run the Agent

- Create a character file in the `characters` folder.
- Run the character using the following command:
    ```bash
    pnpm start --characters="characters/chatdkg.character.json"
    ```

### Notes

- Ensure you configure the Twitter client and select your LLM provider in the character settings, also include the plugin in your agent.

## Dependencies

- @elizaos/core: workspace:\*
- SPARQL query library: workspace:\*
- DKG JavaScript SDK: dkg.js > ^8.0.4

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](CONTRIBUTING.md) file for more information.

## License

This plugin is part of the Eliza project. See the main project repository for license information.
