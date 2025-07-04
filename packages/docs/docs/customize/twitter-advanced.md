
# Twitter Integration (Deprecated)

**⚠️ Important Notice**: Twitter integration in ElizaOS is currently deprecated. Due to changes in Twitter's API policies and authentication requirements, we recommend using alternative platforms like Discord or Telegram for your agents.

## Current Status

The Twitter client has been marked as deprecated in the ElizaOS codebase. While the integration code still exists, it is no longer actively maintained or recommended for production use.

### Why Deprecated?

1. **API Changes** - Twitter's API has undergone significant changes
2. **Authentication Issues** - Increased restrictions on bot accounts
3. **Rate Limiting** - Stricter limits on automated interactions
4. **Cost** - API access now requires paid tiers for most use cases

## Alternative Platforms

We recommend using these actively supported platforms:

### Discord
- Full-featured integration
- Rich embeds and interactions
- Active community support
- Free tier available

See: [Discord Setup Guide](/docs/customize/discord-setup)

### Telegram
- Reliable bot API
- Group chat support
- Inline keyboards
- Free to use

See: [Telegram Setup Guide](/docs/customize/telegram-setup)

### Direct API
- REST API interface
- Custom integrations
- Full control

See: [API Reference](/docs/api)

## Legacy Configuration (Not Recommended)

If you must use Twitter integration for testing or development:

```bash
# Basic credentials (deprecated)
TWITTER_USERNAME=your_username
TWITTER_PASSWORD=your_password
TWITTER_EMAIL=your_email@example.com

# Additional settings
TWITTER_DRY_RUN=true  # Test without posting
```

**Note**: Even with correct credentials, the Twitter integration may not function due to API changes.

## Migration Guide

### Moving from Twitter to Discord

1. **Create Discord Bot**
   ```bash
   # Set up Discord credentials
   DISCORD_APPLICATION_ID=your_app_id
   DISCORD_API_TOKEN=your_bot_token
   ```

2. **Update Character File**
   ```json
   {
     "clients": ["discord"],  // Remove "twitter"
     "settings": {
       "discord": {
         "shouldRespondInChannels": true
       }
     }
   }
   ```

3. **Adjust Content Strategy**
   - Discord supports longer messages
   - Rich embeds available
   - Different engagement patterns

### Moving from Twitter to Telegram

1. **Create Telegram Bot**
   ```bash
   # Set up Telegram credentials
   TELEGRAM_BOT_TOKEN=your_bot_token
   ```

2. **Update Configuration**
   ```json
   {
     "clients": ["telegram"],  // Remove "twitter"
     "settings": {
       "telegram": {
         "enableGroupChat": true
       }
     }
   }
   ```

## Community Alternatives

Some community members have created unofficial Twitter integrations:

- Check the Discord community for updates
- Look for third-party plugins
- Consider contributing to a community solution

**Disclaimer**: Third-party integrations are not officially supported by ElizaOS.

## Future Plans

The ElizaOS team is monitoring Twitter's API developments. If conditions improve, we may revisit Twitter integration in the future. For now, we recommend focusing on the well-supported platforms.

## Need Help?

If you're migrating from Twitter to another platform:

1. Join our [Discord community](https://discord.gg/elizaos)
2. Check the [migration guide](/docs/migration)
3. Ask questions in the #help channel

---

**💡 Pro Tip**: Discord and Telegram offer more reliable, feature-rich integrations for AI agents. Most users find these platforms provide better engagement and more flexibility than Twitter's current API limitations allow.