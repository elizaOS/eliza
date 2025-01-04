---
sidebar_position: 1
---

# Building a Social AI Agent in 15 Minutes

In this tutorial, you'll learn how to quickly build your own social media AI agent that can autonomously post tweets, respond to interactions, and maintain its own unique personality. We'll be using the [Eliza framework](https://ai16z.github.io/eliza/) by a16z and TypeScript.

Video: https://youtu.be/6PZVwNTl5hI?si=0zB3OvYU4KiRQTxI

## Prerequisites
- Basic TypeScript knowledge 
- Twitter Developer account
- (Optional) Anthropic API key

## Project Setup

1. Clone the Eliza repo and check out the latest version:

   ```bash
   git clone https://github.com/elizaOS/eliza.git
   cd eliza
   git checkout <latest-tag>
   ```

2. Install dependencies:

   ```bash 
   pnpm install
   pnpm build
   ```

## Environment Variables

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` and set your Twitter credentials. You can use username/password or cookies.

3. (Optional) Set your Anthropic API key for the Claude model.

4. For Gaia, set:

   ```
   MODEL_LLM_API_URL=https://modelserverurl/
   MODEL_EMBEDDING_MODEL=embeddingmodel
   MODEL_EMBEDDING_ENABLED=true
   ```

## Customizing Your Character 

1. Create `agent/mainCharacter.ts`:

   ```typescript
   import { DefaultCharacter } from "./defaultCharacter";
   import { clients } from "../globalClients";

   export const mainCharacter = {
      ...DefaultCharacter,
      clients: { twitter: clients.twitter },
      modelProvider: modelProviders.anthropic 
   };
   ```

2. Extend the character by overriding properties like `name`, `bio`, `systemPrompt` etc.

3. In `src/index.ts`, import `mainCharacter` and replace instances of `DefaultCharacter` with it.

## Running the Agent

1. Run `pnpm start` 

2. The agent will post a tweet and start listening for replies. Test it out by replying to the tweet.

## Gaia Model Setup

1. In `mainCharacter.ts`, change the model provider:

   ```typescript 
      modelProvider: modelProviders.gaiaNet
   ```

2. Customize the `systemPrompt` and `bio` for the new personality.

3. Delete the SQLite DB at `data/sqlite.db` to reset tweet history.

4. Run `pnpm start` again to see the updated agent in action!

## Next Steps

- Try integrating other extensions like databases, Discord, Telegram
- Add on-chain capabilities with EVM, Solana, StarkNet adapters
- Chat with your agent directly in the terminal

## Resources
- [Code Repo](https://github.com/dabit3/ai-agent-cognitivedriftt) 
- [Eliza Docs](https://ai16z.github.io/eliza/)
- [Example Character File](https://github.com/ai16z/characterfile/blob/main/examples/example.character.json)
- [Default Character](https://github.com/elizaOS/eliza/blob/8f4e2643dcb1a5aafb25267e80d22e7e12fd044a/packages/core/src/defaultCharacter.ts#L4)
- [Environment Variables](https://gist.github.com/dabit3/7602e97f3abe0a93bdd84dc250f23021)

