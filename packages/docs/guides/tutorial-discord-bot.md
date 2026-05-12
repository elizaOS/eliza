---
title: "Tutorial: Discord Bot"
sidebarTitle: "Discord Bot Setup"
description: "Set up Eliza as a Discord bot with step-by-step instructions for creating the app, configuring permissions, and deploying your AI assistant."
---

# Setting Up Eliza as a Discord Bot

This tutorial walks you through creating and configuring Eliza to run as a Discord bot. By the end, you'll have a fully functional AI assistant responding to messages in your Discord server.

<Info>
Eliza uses the `@elizaos/plugin-discord` connector to interact with Discord servers. This guide assumes you have Eliza installed locally and basic familiarity with Discord's developer portal.
</Info>

## Prerequisites

Before starting, ensure you have:
- A Discord account with a server where you have admin permissions
- Eliza installed on your system (see [Installation](/installation))
- Node.js 22+ installed
- A code editor for modifying configuration files

## Step-by-Step Setup

<Steps>

<Step title="Create a Discord Application">
1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** in the top right
3. Enter a name for your bot (e.g., "Eliza AI Assistant")
4. Click **Create**
5. Go to the **Bot** tab on the left sidebar
6. Click **Add Bot**

<Tip>
You can customize your bot's avatar and username on the Bot page. Changes take effect immediately.
</Tip>

</Step>

<Step title="Get Your Bot Token and Enable Intents">
1. In the **Bot** section, locate the **TOKEN** field
2. Click **Copy** to copy your bot token to your clipboard
3. Store this token securely—never share it publicly or commit it to version control
4. Scroll down to **Privileged Gateway Intents**
5. Toggle **Message Content Intent** to **ON** — this is required for the bot to read message text
6. Click **Save Changes**

<Warning>
If your token is ever exposed, regenerate it immediately by clicking **Regenerate** in the Discord Developer Portal.
</Warning>

</Step>

<Step title="Configure eliza.json">
1. Open your Eliza config file (run `eliza config path` to find it, typically `~/.eliza/eliza.json`)
2. Add the Discord connector configuration:

```json
{
  "connectors": {
    "discord": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN_HERE",
      "dm": {
        "enabled": true,
        "policy": "pairing"
      }
    }
  }
}
```

3. Replace `YOUR_BOT_TOKEN_HERE` with the token you copied in Step 2
4. Replace `YOUR_SERVER_ID` and `YOUR_CHANNEL_ID` with the IDs from your Discord server (enable Developer Mode in Discord settings to copy IDs)
5. Save the file

<Info>
The Discord connector auto-enables when `token` is present in the config. Make sure to enable the `MESSAGE_CONTENT` intent in the Discord Developer Portal under **Bot > Privileged Gateway Intents**.
</Info>

</Step>

<Step title="Verify the Discord Plugin">
1. Open your terminal and run the following command to verify the plugin is recognized:

```bash
eliza plugins installed
```

2. Confirm that `discord` appears in the list of installed plugins
3. Check `eliza.json` to ensure the `token` field is set under `connectors.discord`

</Step>

<Step title="Set Permissions and Invite Your Bot">
1. In the Discord Developer Portal, go to the **OAuth2** tab
2. Select **URL Generator** from the left sidebar
3. Under **Scopes**, check:
   - `bot`
4. Under **Permissions**, check:
   - `Send Messages`
   - `Read Messages/View Channels`
   - `Read Message History`
   - `Use Slash Commands` (if using slash commands)

5. Copy the generated URL from the bottom
6. Open the URL in your browser to invite the bot to your server
7. Select your server from the dropdown and click **Authorize**

<Tip>
For a production bot, you may want to add additional permissions like `Manage Messages` or `Embed Links`. Only grant permissions your bot actually needs.
</Tip>

</Step>

<Step title="Start Eliza and Test Your Bot">
1. In your terminal, start Eliza:

```bash
eliza start
```

2. You should see output confirming the Discord connector has connected
3. In your Discord server, send a message to your bot:
   - Direct message: `Hello bot`
   - In a channel: `@YourBotName hello bot` (mention the bot)

4. Your bot should respond with an AI-generated message
5. Test a few more interactions to confirm everything is working

</Step>

</Steps>

## Verification Checklist

Before considering your setup complete:

- [ ] Bot token is securely stored in `eliza.json` under `connectors.discord.token`
- [ ] Discord connector shows as connected in the console output
- [ ] Bot appears online in your Discord server
- [ ] Bot responds to direct messages
- [ ] Bot responds to channel messages (if configured)
- [ ] No errors in the Eliza console output

## Troubleshooting

<AccordionGroup>

<Accordion title="Bot appears offline in Discord">
This usually means the Discord connector didn't connect successfully.

**Solutions:**
1. Verify your bot token is correct and hasn't expired
2. Check that `token` is set under `connectors.discord` in `eliza.json`
3. Ensure the `MESSAGE_CONTENT` privileged intent is enabled in the Discord Developer Portal
4. Run `eliza start` and look for error messages in the console
5. Regenerate your bot token if it's been compromised or auto-revoked
</Accordion>

<Accordion title="Bot doesn't respond to messages">
If your bot is online but not responding:

**Solutions:**
1. Check that `MESSAGE_CONTENT` intent is enabled in the Discord Developer Portal under **Bot > Privileged Gateway Intents**
2. Verify the bot has permission to see and send messages in the channel
3. Check the Eliza console for error messages
4. If using `groupPolicy: "allowlist"`, ensure the server/channel IDs are listed in the `guilds` config
5. Try restarting Eliza with `Ctrl+C` followed by `eliza start`
</Accordion>

<Accordion title="Permission denied errors">
Your bot is responding but encountering permission issues:

**Solutions:**
1. Go to your Discord server settings → Roles
2. Move the "Eliza" role higher in the hierarchy (above other roles it needs to interact with)
3. In the Developer Portal, add missing permissions under the URL Generator
4. Re-invite your bot using the new authorization URL
5. Restart Eliza after making permission changes
</Accordion>

<Accordion title="Rate limiting warnings">
Discord limits how many messages bots can send:

**Solutions:**
1. Reduce the frequency of bot responses if testing rapidly
2. Implement longer delays between test messages
3. Add rate limiting configuration to `eliza.json` if available in your version
4. Avoid @mentioning the bot excessively
5. Check the Eliza documentation for rate limiting best practices
</Accordion>

<Accordion title="Slash commands not showing up">
If slash commands aren't appearing:

**Solutions:**
1. Ensure the `Use Slash Commands` scope is included in your bot's OAuth2 invite URL
2. Restart Eliza after making any configuration changes
3. In Discord, type `/` in a message box and wait 1-2 seconds for commands to appear
4. If still missing, re-invite the bot using an updated authorization URL with the `applications.commands` scope
</Accordion>

</AccordionGroup>

## Next Steps

Now that your Discord bot is running, explore these guides:

- **[Telegram Bot Setup](/guides/tutorial-telegram-bot)** - Add Eliza to Telegram
- **[Autonomous Agents](/guides/tutorial-autonomous-agent)** - Create self-managing AI agents
- **[Discord Connector Reference](/connectors/discord)** - Advanced Discord plugin configuration

## Additional Resources

<Tabs>
<Tab title="Discord Developer Portal">
Visit the [Discord Developer Portal](https://discord.com/developers/applications) to manage your bot's settings, permissions, and webhooks.
</Tab>
<Tab title="Eliza Configuration">
See the [Configuration Guide](/configuration) for detailed options in `eliza.json`.
</Tab>
<Tab title="elizaOS Documentation">
Learn more about elizaOS at the [elizaOS GitHub](https://github.com/elizaOS/eliza).
</Tab>
</Tabs>

## Getting Help

If you encounter issues:

1. Check the troubleshooting section above
2. Review Eliza's console output for error messages
3. Visit the [Eliza Community Discord](https://discord.gg/eliza)
4. Open an issue on the [Eliza GitHub repository](https://github.com/eliza-ai/eliza)
