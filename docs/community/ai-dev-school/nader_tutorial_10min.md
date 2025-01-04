---
sidebar_position: 2 
---

# Creating an AI Agent with Your Own Personality

In this tutorial, we'll explore how to create an AI agent that embodies your own personality using data from your Twitter archive, videos, markdown files, and PDFs. We'll leverage the [Characterfile](https://github.com/ai16z/characterfile) repo and [Eliza framework](https://github.com/elizaOS/eliza) to generate and integrate the character data.

Video: https://youtu.be/uouSdtcWXTQ?si=cm13L4T7DQUMXd0C

## Prerequisites
- Twitter Developer account 
- Anthropic API key
- Your Twitter archive (download instructions below)
- (Optional) Videos, markdown files, PDFs about you

## Generating Your Character File

### From Twitter Archive
1. Request your Twitter archive:
   - Go to your Twitter settings
   - Click "Download an archive of your data"
   - Wait to receive the archive (timing depends on your account age/activity)

2. Clone the Characterfile repo:
   ```bash
   git clone https://github.com/ai16z/characterfile.git
   ```

3. Run the `tweets-to-character` script:
   ```bash
   npx tweets-to-character path/to/archive.zip
   ```
   - Select model (e.g. Claude)
   - (Optional) Add any additional user information

4. Script will generate a `character.json` file from your Tweets

### From Other Files
1. Put videos, PDFs, text, markdown, images in a folder

2. Run the `folder-to-knowledge` script:
   ```bash  
   npx folder-to-knowledge path/to/folder
   ```

3. Run `knowledge-to-character` to add knowledge to your character file

## Setting Up the Agent

1. Clone Eliza repo and check out latest version:
   ```bash
   git clone https://github.com/elizaOS/eliza.git
   git checkout <latest-tag>
   ```

2. Install dependencies:
   ```bash
   pnpm install
   pnpm build  
   ```

3. Add your character JSON file to `characters/` 

4. Modify character file:
   - Add `clients`, `modelProvider`, `plugins` fields
   - Remove `voice` field

5. Set up `.env` with Twitter and Anthropic credentials  

## Running the Agent

1. Start agent with your character file:
   ```bash
   pnpm start --character characters/yourcharacter.json
   ```

2. Agent will log in and post an initial tweet

3. Check your Twitter profile to see the agent in action!

## Next Steps  
- Implement dynamic prompting to enhance agent interactions
- Extend agent with additional plugins and integrations
