---
title: "Tutorial: Telegram Bot"
sidebarTitle: "Telegram Bot Setup"
description: "Learn how to create and configure a Telegram bot with Eliza in just a few minutes"
---

# Tutorial: Telegram Bot

Get started with Eliza's Telegram bot integration. This tutorial walks you through creating your first bot, configuring it, and testing it end-to-end.

<Info>
  This tutorial assumes you have Eliza installed. If you haven't already, check out the [Installation Guide](/installation).
</Info>

## Prerequisites

Before you begin, make sure you have:

- A Telegram account
- Eliza installed and running (`eliza` or `eliza start`)
- Access to the Eliza dashboard (default: http://localhost:2138)

## Quick Setup via Dashboard

The fastest way to set up the Telegram connector is through the Eliza dashboard:

1. Open **http://localhost:2138** in your browser
2. Navigate to **Connectors** in the top navigation
3. Find **Telegram** in the connector list and toggle it **ON**
4. Paste your **Bot Token** (see below for how to get one)
5. Click **Save Settings** — the agent will automatically restart
6. Click **Test Connection** to verify — you should see "Connected as @yourbotname"
7. Open Telegram, find your bot by username, and send `/start`

That's it — your bot is live.

## Getting a Bot Token from BotFather

<Steps>
  <Step title="Create a Bot with BotFather">
    Open Telegram and search for **@BotFather**, the official bot for creating Telegram bots.

    1. Start a conversation with @BotFather by clicking the "Start" button
    2. Send the command: `/newbot`
    3. BotFather will ask you to choose a name for your bot (this is the display name)
    4. Choose a unique username for your bot (must end with "bot")
    5. BotFather will respond with your **bot token** — save this somewhere safe

    <Warning>
      Never share your bot token publicly or commit it to version control. It grants full access to your bot.
    </Warning>

    Your token will look something like: `123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI`
  </Step>

  <Step title="Retrieve an Existing Token">
    If you already have a bot, you can retrieve the token anytime:

    1. Message @BotFather with `/mybots`
    2. Select your bot from the list
    3. Select "API Token"

    To regenerate a compromised token, select "Revoke current token" in the same menu. This immediately invalidates the old token.
  </Step>
</Steps>

## Dashboard Features

### Test Connection

After saving your bot token, click **Test Connection** in the connector settings. This calls the Telegram `getMe` API and verifies your token is valid. You'll see either:

- **"Connected as @yourbotname"** — your bot is ready
- **"Telegram API error: ..."** — check your token

### Chat Access Toggle

By default, your bot is set to **Allow all chats** — anyone who messages it will get a response. To restrict access:

1. Click the **Allow all chats** toggle to switch to **Allow only specific chats**
2. An input field will appear — enter a JSON array of allowed chat IDs, e.g.:
   ```json
   ["123456789", "-1001234567890"]
   ```
3. Click **Save Settings**

To switch back, click the toggle again to return to **Allow all chats** — your previously saved chat IDs will be restored if you toggle back to specific chats.

Chat ID formats:
- **Positive numbers** (e.g. `123456789`) — private chats with individual users
- **Negative numbers starting with -100** (e.g. `-1001234567890`) — groups and supergroups

To find your chat ID, use [@userinfobot](https://t.me/userinfobot) on Telegram.

Changes to allowed chats take effect immediately — no restart needed.

### Show / Hide Token

Click the **Show** button next to the Bot Token field to reveal the saved token value. Click **Hide** to mask it again.

### Reset

Click **Reset** to clear all saved Telegram settings (token, allowed chats, etc.). This will prompt for confirmation and restart the agent. You'll need to reconfigure the connector afterward.

### Advanced Settings

Click **Advanced** to expand additional settings:

- **API Root** — Custom Telegram Bot API endpoint (default: `https://api.telegram.org`). Only needed if you run a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) or use a proxy.
- **Test Chat ID** — Chat ID used by the automated test suite. Not needed for production use.

## Configuration via eliza.json

You can also configure the Telegram connector directly in `~/.eliza/eliza.json`. The recommended approach uses the `connectors` config, which triggers auto-enable:

```json
{
  "connectors": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI"
    }
  }
}
```

Alternatively, set the token as an environment variable (via `env` in eliza.json or a `.env` file). Note that environment variables alone do not trigger auto-enable — you would also need to add `@elizaos/plugin-telegram` to `plugins.allow`.

```json
{
  "env": {
    "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklmNOpqrsTUVwxyzABC-defGHI"
  }
}
```

Then start Eliza:

```bash
eliza start
```

## Configuration Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| **Bot Token** (`TELEGRAM_BOT_TOKEN`) | Yes | Authentication token from @BotFather. This is the only parameter needed to get started. |
| **Allowed Chats** (`TELEGRAM_ALLOWED_CHATS`) | No | JSON array of chat IDs the bot is allowed to interact with. If not set, the bot responds to all chats. |
| **API Root** (`TELEGRAM_API_ROOT`) | No | Custom Telegram Bot API endpoint. Defaults to `https://api.telegram.org`. |
| **Test Chat ID** (`TELEGRAM_TEST_CHAT_ID`) | No | Chat ID used by the E2E test suite. Not needed for production. |

## Troubleshooting

<AccordionGroup>
  <Accordion title="Bot token is invalid or not working">
    **Problem:** You get an error like "Unauthorized" or the Test Connection button shows "Telegram API error"

    **Solutions:**
    1. Double-check that you copied the entire token correctly
    2. Verify the token hasn't been revoked — check `/mybots` in BotFather
    3. Ensure there are no extra spaces or newlines
    4. Regenerate the token in BotFather if needed (this invalidates the old one)
    5. After pasting a new token, click **Save Settings** then **Test Connection**
  </Accordion>

  <Accordion title="NEEDS SETUP badge won't go away">
    **Problem:** The Telegram connector shows "Needs setup" even though the token is saved

    **Solutions:**
    1. Only the **Bot Token** is required — other fields are optional
    2. Click **Save Settings** to persist your token
    3. Refresh the page — the badge should update to "Ready"
    4. If the badge persists, check the terminal for error messages
  </Accordion>

  <Accordion title="Bot is not receiving messages">
    **Problem:** You send messages but the bot doesn't respond

    **Solutions:**
    1. Verify the connector is toggled **ON** in the dashboard
    2. Check that the Test Connection shows "Connected as @yourbotname"
    3. Look for error messages in the terminal where Eliza is running
    4. If Chat Access is restricted, verify your chat ID is in the allowed list
    5. Make sure you sent `/start` to the bot first
    6. Try restarting Eliza — the connector may need a fresh start
  </Accordion>

  <Accordion title="Bot responds slowly">
    **Problem:** Messages are delayed or the bot seems unresponsive

    **Solutions:**
    1. Check your internet connection
    2. Monitor system resources — RAM or CPU might be maxed out
    3. Check Eliza logs for errors or hanging processes
    4. For production, consider webhook mode instead of polling
  </Accordion>

  <Accordion title="409 Conflict error in logs">
    **Problem:** Logs show "409: Conflict: terminated by other getUpdates request"

    **Solutions:**
    1. Make sure only one instance of Eliza is running
    2. Check for stale bot processes: `tasklist | grep bun` (Windows) or `ps aux | grep bun` (Linux/Mac)
    3. Wait 30 seconds and restart — Telegram needs time to release the polling slot
  </Accordion>
</AccordionGroup>

## Next Steps

- **[Connectors Guide](/guides/connectors)** — Overview of all available connectors
- **[Telegram Connector Reference](/connectors/telegram)** — Advanced Telegram configuration options
- **[Deployment Guide](/deployment)** — Deploy your bot to production

## Need Help?

- Join the [Eliza Community Discord](https://discord.gg/eliza)
- Report issues on [GitHub](https://github.com/eliza-ai/eliza/issues)
