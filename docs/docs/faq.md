# Frequently Asked Questions

## Eliza FAQ

### What is Eliza?

**Eliza is an open-source, multi-agent simulation framework for creating and managing autonomous AI agents.** The project aims to empower developers and users to build unique AI personalities that can interact across various platforms, such as Discord, Twitter, and Telegram.

### Who is behind Eliza?

The Eliza project is led by [Shaw](https://x.com/shawmakesmagic). The project is open source, and its code is available on GitHub: https://github.com/elizaos/eliza

### How can I get started with Eliza?

To begin building your own AI agents with Eliza, follow these steps:

1.  **Install Python, Node.js and pnpm**: Ensure you have the necessary software prerequisites installed on your system. We use node v23.
2.  **Set up your environment**: Create a `.env` file and populate it with the required API keys, database configuration, and platform-specific tokens.
3.  **Install Eliza**: Use the command `npm install @elizaos/core` or `pnpm add @elizaos/core` to install the Eliza package.
4.  **Configure your database**: Eliza currently relies on Supabase for local development. Follow the instructions in the documentation to set up your Supabase project and database.
5.  **Define your agent's character**: Create a character file using the provided JSON format to specify your agent's personality, knowledge, and behavior.
6.  **Run Eliza locally**: Use the provided commands to start the Eliza framework and interact with your agent.

### What are the key components of Eliza?

Eliza's architecture consists of several interconnected components:

- **Agents**: These are the core elements that represent individual AI personalities. Agents operate within a runtime environment and interact with various platforms.
- **Actions**: Actions are predefined behaviors that agents can execute in response to messages, enabling them to perform tasks and interact with external systems.
- **Clients**: Clients act as interfaces between agents and specific platforms, such as Discord, Twitter, and Telegram. They handle platform-specific message formats and communication protocols.
- **Plugins**: Plugins are modular way to extend the core functionality with additional features, actions, evaluators, and providers. They are self-contained modules that can be easily added or removed to customize your agent's capabilities
- **Providers**: Providers supply agents with contextual information, including time awareness, user relationships, and data from external sources.
- **Evaluators**: These modules assess and extract information from conversations, helping agents track goals, build memory, and maintain context awareness.
- **Character Files**: These JSON files define the personality, knowledge, and behavior of each AI agent.
- **Memory System**: Eliza features a sophisticated memory management system that utilizes vector embeddings and relational database storage to store and retrieve information for agents.

### How can I contribute to the Eliza project?

Eliza welcomes contributions from individuals with a wide range of skills:

#### Technical Contributions

- **Develop new actions, clients, providers, and evaluators**: Extend Eliza's functionality by creating new modules or enhancing existing ones.
- **Contribute to database management**: Improve or expand Eliza's database capabilities using PostgreSQL, SQLite, or SQL.js.
- **Enhance local development workflows**: Improve documentation and tools for local development using SQLite and VS Code.
- **Fine-tune models**: Optimize existing models or implement new models for specific tasks and personalities.
- **Contribute to the autonomous trading system and trust engine**: Leverage expertise in market analysis, technical analysis, and risk management to enhance these features.

#### Non-Technical Contributions

- **Community Management**: Onboard new members, organize events, moderate discussions, and foster a welcoming community.
- **Content Creation**: Create memes, tutorials, documentation, and videos to share project updates.
- **Translation**: Translate documentation and other materials to make Eliza accessible to a global audience.
- **Domain Expertise**: Provide insights and feedback on specific applications of Eliza in various fields.

### What are the future plans for Eliza?

The Eliza project is continuously evolving, with ongoing development and community contributions. The team is actively working on:

- **Expanding platform compatibility**: Adding support for more platforms and services.
- **Improving model capabilities**: Enhance agent performance and capabilities with existing and new models.
- **Enhancing the trust engine**: Provide robust and secure recommendations within decentralized networks.
- **Fostering community growth**: Rewarding contributions to expand the project's reach and impact.

### How can I contribute to Eliza?

There are several ways to contribute to the Eliza project:

- **Participate in community discussions**: Share your memecoin insights, propose new ideas, and engage with other community members.
- **Contribute to the development of the Eliza platform**: https://github.com/orgs/elizaos/projects/1/views/3
- **Help build the Eliza ecosystem**: Create applicatoins / tools, resources, and memes. Give feedback, and spread the word
