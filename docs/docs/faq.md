# Frequently Asked Questions


### What is Eliza?
Eliza is an open-source framework for building AI agents that can interact on platforms like Twitter, Discord, and Telegram. It was created by Shaw and is maintained by the community.

### What are the key components of Eliza?

Eliza consists of these core components:
- **Agents**: AI personalities that interact with users and platforms
- **Actions**: Executable behaviors that agents can perform in response to messages
- **Clients**: Platform connectors for services like Discord, Twitter, and Telegram 
- **Plugins**: Modular extensions that add new features and capabilities
- **Providers**: Services that supply contextual information to agents
- **Evaluators**: Modules that analyze conversations and track agent goals
- **Character Files**: JSON configurations that define agent personalities
- **Memory System**: Database that stores and manages agent information using vector embeddings

### What's the difference between v1 and v2?

Note: It's recommended for devs to keep working with v1, v2 will be mostly backwards compatible

**What's Wrong with V1:**
1. Cluttered: Too many packages directly in the core codebase
2. Message Handling: Isolated and limited message routing between platforms
3. Wallet Confusion: Separate wallets for different chains adds friction
4. Limited Planning: Limited action planning abilities

**What's New in V2:**
1. Better Organization
- New package registry system to submit packages without core code changes
- More modular and maintainable architecture
- CLI tool for package management

2. Smarter Communication
- Agents can more easily route messages across different platforms
- Better support for autonomous actions

3. Simplified Wallet System
- One unified wallet system (like a video game inventory)
- Better at handling transactions across different blockchains
- Each "inventory provider" can have its own unique actions

4. Character Improvements
- Characters can now evolve and learn over time
- All character data stored in a database instead of static files
- Can grow and change based on community interactions

5. Advanced Planning
- Agents can now plan out a series of actions in advance
- More strategic and autonomous behavior

---

## Installation and Setup

### What are the system requirements for running Eliza?
- Node.js version 23+ (specifically 23.3.0 is recommended)
- pnpm package manager
- At least 2GB RAM
- For Windows users: WSL2 (Windows Subsystem for Linux)

### How do I get started with Eliza?
1. Follow the [quick start guide](docs/quickstart.md) in the README
3. Watch the AI Agent Dev School videos on YouTube for step-by-step guidance
4. Join the Discord community for support

### How do I fix common installation issues?
If you encounter build failures or dependency errors:
1. Ensure you're using Node.js v23.3.0: `nvm install 23.3.0 && nvm use 23.3.0`
2. Clean your environment: `pnpm clean`
3. Install dependencies: `pnpm install --no-frozen-lockfile`
4. Rebuild: `pnpm build`
5. If issues persist, try checking out the latest release:
   ```bash
   git checkout $(git describe --tags --abbrev=0)
   ```
   
### How do I use local models with Eliza?
Use **Ollama** for local models. Install Ollama, download the desired model (e.g., `llama3.1`), set `modelProvider` to `"ollama"` in the character file, and configure `OLLAMA` settings in `.env`.

### How do I update Eliza to the latest version?
1. Pull the latest changes
2. Clean your environment: `pnpm clean`
3. Reinstall dependencies: `pnpm install --no-frozen-lockfile`
4. Rebuild: `pnpm build`

---

## Running Multiple Agents

### How do I run multiple agents simultaneously?
You have several options:
1. Use the command line:
   ```bash
   pnpm start --characters="characters/agent1.json,characters/agent2.json"
   ```
2. Create separate projects for each agent with their own configurations
3. For production, use separate Docker containers for each agent

### Can I run multiple agents on one machine?
Yes, but consider:
- Each agent needs its own port configuration
- Separate the .env files or use character-specific secrets
- Monitor memory usage (2-4GB RAM per agent recommended)



---

## Twitter/X Integration

### How do I prevent my agent from spamming or posting duplicates?
Configure your .env file:
```
ENABLE_ACTION_PROCESSING=false
POST_INTERVAL_MIN=900  # 15 minutes minimum
POST_INTERVAL_MAX=1200 # 20 minutes maximum
TWITTER_DRY_RUN=true   # Test mode
```

### How do I control which tweets my agent responds to?
1. Configure target users in .env:
   ```
   TWITTER_TARGET_USERS="user1,user2,user3"
   ```
2. Control specific actions:
   ```
   TWITTER_LIKES_ENABLE=false
   TWITTER_RETWEETS_ENABLE=false
   TWITTER_REPLY_ENABLE=true
   TWITTER_FOLLOW_ENABLE=false
   ```

### How do I fix Twitter authentication issues?
1. Mark your account as "Automated" in Twitter settings
2. Ensure proper credentials in .env file
3. Consider using a residential IP or VPN as Twitter may block cloud IPs
4. Set up proper rate limiting to avoid suspensions

### How do I prevent unwanted Twitter interactions?
To better control what tweets your agent responds to, configure `TWITTER_TARGET_USERS` in `.env` and set specific action flags like `TWITTER_LIKES_ENABLE=false` to control interaction types.

### How do I troubleshoot Twitter authentication issues?
Ensure correct credentials in `.env`, mark account as "Automated" in Twitter settings, and consider using a residential IP to avoid blocks.

### How do I make my agent respond to Twitter replies?
Set `ENABLE_ACTION_PROCESSING=true` and configure `TWITTER_POLL_INTERVAL`. Target specific users for guaranteed responses.

### How do I avoid Twitter bot suspensions?
- Mark account as automated in Twitter settings
- Space out posts (15-20 minutes between interactions)
- Avoid using proxies

### How do I fix Twitter authentication issues?
- Ensure correct credentials in .env file
- Use valid TWITTER_COOKIES format
- Turn on "Automated" in Twitter profile settings

---

## Model Configuration

### How do I switch between different AI models?
In your character.json file:
```json
{
  "modelProvider": "openai",  // or "anthropic", "deepseek", etc.
  "settings": {
    "model": "gpt-4",
    "maxInputTokens": 200000,
    "maxOutputTokens": 8192
  }
}
```

### How do I manage API keys and secrets?
Two options:
1. Global .env file for shared settings
2. Character-specific secrets in character.json:
   ```json
   {
     "settings": {
       "secrets": {
         "OPENAI_API_KEY": "your-key-here"
       }
     }
   }
   ```

---

## Memory and Knowledge Management

### How does memory management work in ElizaOS?
ElizaOS uses RAG (Retrieval-Augmented Generation) to convert prompts into vector embeddings for efficient context retrieval and memory storage.

### How do I fix "Cannot generate embedding: Memory content is empty"?
Check your database for null memory entries and ensure proper content formatting when storing new memories.

### How do I manage my agent's memory?
- To reset memory: Delete the db.sqlite file and restart
- To add documents: Specify path to file / folder in the characterfile
- For large datasets: Consider using a vector database

### How much does it cost to run an agent?
- OpenAI API: Approximately 500 simple replies for $1
- Server hosting: $5-20/month depending on provider
- Optional: Twitter API costs if using premium features
- Local deployment can reduce costs but requires 24/7 uptime

### How do I clear or reset my agent's memory?
1. Delete the db.sqlite file in the agent/data directory
2. Restart your agent
3. Alternatively, use `pnpm cleanstart`

### How do I add custom knowledge or use RAG with my agent?
1. Convert documents to txt/md format
2. Use the [folder2knowledge](https://github.com/elizaOS/characterfile/tree/main/scripts) tool
3. Add to the knowledge section in your character file, [see docs](docs/core/characterfile.md) via `"ragKnowledge": true`


---

## Plugins and Extensions

### How do I add plugins to my agent?
1. Add the plugin to your character.json:
   ```json
   {
     "plugins": ["@elizaos/plugin-name"]
   }
   ```
2. Install the plugin: `pnpm install @elizaos/plugin-name`
3. Rebuild: `pnpm build`
4. Configure any required plugin settings in .env or character file

### How do I create custom plugins?
1. Create a new directory in packages/plugins
2. Implement required interfaces (actions, providers, evaluators)
3. Add to your character's plugins array
4. Test locally before deployment

---

## Production Deployment

### What's the recommended way to deploy Eliza?
1. Use a VPS or cloud provider (DigitalOcean, AWS, Hetzner)
2. Requirements:
   - Minimum 2GB RAM
   - 20GB storage
   - Ubuntu or Debian recommended
3. Use PM2 or Docker for process management
4. Consider using residential IPs for Twitter bots

### How do I ensure my agent runs continuously?
1. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start "pnpm start" --name eliza
   pm2 save
   ```
2. Set up monitoring and automatic restarts
3. Use proper error handling and logging

---

## Troubleshooting

### How do I fix database connection issues?
1. For SQLite:
   - Delete db.sqlite and restart
   - Check file permissions
2. For PostgreSQL:
   - Verify connection string
   - Check database exists
   - Ensure proper credentials

### How do I debug when my agent isn't responding?
1. Enable debug logging in .env:
   ```
   DEBUG=eliza:*
   ```
2. Check the database for saved messages
3. Verify API keys and model provider status
4. Check client-specific settings (Twitter, Discord, etc.)

### How do I resolve embedding dimension mismatch errors?
1. Set `USE_OPENAI_EMBEDDING=true` in .env
2. Delete db.sqlite to reset embeddings
3. Ensure consistent embedding models across your setup

### Why does my agent post in JSON format sometimes?
This usually happens due to incorrect output formatting or template issues. Check your character file's templates and ensure the text formatting is correct without raw JSON objects.

### How do I make my agent only respond to mentions?
Add a mention filter to your character's configuration and set `ENABLE_ACTION_PROCESSING=false` in your .env file.

---

## How can I contribute?

Eliza welcomes contributions from individuals with a wide range of skills:

- **Participate in community discussions**: Share your memecoin insights, propose new ideas, and engage with other community members.
- **Contribute to the development of the Eliza platform**: https://github.com/elizaOS/eliza
- **Help build the Eliza ecosystem**: Create applications / tools, resources, and memes. Give feedback, and spread the word

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
