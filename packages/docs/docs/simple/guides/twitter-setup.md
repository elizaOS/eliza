# Twitter/X Agent Setup Guide

Set up your ElizaOS agent to post and interact on Twitter/X platform.

## Prerequisites

- Twitter/X account
- ElizaOS installed and configured
- Basic understanding of environment variables

## Step 1: Twitter Account Setup

### Account Requirements

- **Active Twitter/X account** with email verification
- **Two-factor authentication enabled** (recommended for security)
- **Account in good standing** (not suspended or limited)

### Security Considerations

- Use a dedicated account for your agent if possible
- Enable 2FA for additional security
- Monitor your account for unusual activity

## Step 2: Environment Configuration

Create or update your `.env` file with the following Twitter-specific variables:

### Basic Twitter Configuration

```bash
# Twitter/X Configuration
TWITTER_DRY_RUN=false               # Set to true for testing without posting
TWITTER_USERNAME=your_username      # Your Twitter username (without @)
TWITTER_PASSWORD=your_password      # Your Twitter account password
TWITTER_EMAIL=your_email@domain.com # Your Twitter account email
```

### Two-Factor Authentication (Recommended)

```bash
# Two-Factor Authentication
TWITTER_2FA_SECRET=your_2fa_secret  # Get from your authenticator app
```

To get your 2FA secret:

1. Go to Twitter Settings > Security and account access > Two-factor authentication
2. If not enabled, enable it using an authenticator app
3. When setting up, scan the QR code with your authenticator app
4. The secret key shown is what goes in `TWITTER_2FA_SECRET`

### Interaction Settings

```bash
# Interaction Configuration
TWITTER_POLL_INTERVAL=120           # Check for mentions/replies every 120 seconds
TWITTER_TARGET_USERS=user1,user2    # Specific users to interact with (optional)
TWITTER_SEARCH_ENABLE=FALSE         # WARNING: Increases ban risk, keep FALSE
TWITTER_SPACES_ENABLE=false         # Enable Twitter Spaces features
TWITTER_RETRY_LIMIT=3               # Maximum login retry attempts
```

### Posting Behavior

```bash
# Post Timing (in minutes)
POST_INTERVAL_MIN=90                # Minimum time between posts
POST_INTERVAL_MAX=180               # Maximum time between posts
POST_IMMEDIATELY=false              # Don't post immediately on startup

# Action Processing
ACTION_INTERVAL=5                   # Minutes between processing actions
ENABLE_ACTION_PROCESSING=false      # Enable automatic actions (likes, retweets)
MAX_ACTIONS_PROCESSING=1            # Max actions per cycle (keep low to avoid bans)
ACTION_TIMELINE_TYPE=foryou         # Timeline type: "foryou" or "following"
```

### Approval Workflow (Optional)

```bash
# Tweet Approval via Discord (optional)
TWITTER_APPROVAL_ENABLED=false                    # Enable manual approval
TWITTER_APPROVAL_DISCORD_CHANNEL_ID=123456789    # Discord channel ID
TWITTER_APPROVAL_DISCORD_BOT_TOKEN=discord_token # Discord bot token
TWITTER_APPROVAL_CHECK_INTERVAL=60000            # Check every 60 seconds
```

## Step 3: Character Configuration

Update your character file to enable Twitter:

```json
{
  "name": "YourAgent",
  "clients": ["twitter"],
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-twitter"],
  "settings": {
    "secrets": {},
    "voice": {
      "model": "en_US-female-medium"
    }
  },
  "bio": ["I'm an AI agent that posts interesting content on Twitter"],
  "style": {
    "all": [
      "concise and engaging",
      "uses relevant hashtags sparingly",
      "authentic and conversational"
    ],
    "post": [
      "keeps tweets under 280 characters",
      "asks engaging questions",
      "shares valuable insights"
    ]
  },
  "topics": ["AI", "technology", "innovation"],
  "postExamples": [
    "Just discovered an amazing new AI technique! The future of machine learning keeps getting brighter ✨ #AI #Innovation",
    "What's the most exciting tech trend you're following right now? I'd love to hear your thoughts! 🚀",
    "The intersection of AI and creativity is producing some incredible results. What would you create with AI? 🎨"
  ]
}
```

## Step 4: Testing Your Setup

### Dry Run Testing

1. Set `TWITTER_DRY_RUN=true` in your `.env` file
2. Start your agent: `bun start`
3. Check logs for "DRY RUN" messages indicating posts would be made
4. Verify no actual posts appear on Twitter

### Live Testing

1. Set `TWITTER_DRY_RUN=false`
2. Set `POST_IMMEDIATELY=true` for immediate testing
3. Start your agent: `bun start`
4. Check your Twitter account for the first post
5. Set `POST_IMMEDIATELY=false` after testing

## Step 5: Monitoring and Safety

### Rate Limiting Awareness

- Twitter has strict rate limits
- Keep `POST_INTERVAL_MIN` above 90 minutes
- Don't enable `TWITTER_SEARCH_ENABLE` unless necessary
- Monitor your account for warnings

### Content Guidelines

- Ensure your character follows Twitter's Terms of Service
- Avoid spam-like behavior
- Include variety in your posts
- Engage authentically with users

### Troubleshooting Common Issues

#### Login Failures

- **Symptoms**: "Login failed" errors
- **Solutions**:
  - Verify username/password are correct
  - Check if 2FA is required and configured
  - Ensure account isn't suspended
  - Try increasing `TWITTER_RETRY_LIMIT`

#### No Posts Appearing

- **Symptoms**: Agent runs but doesn't post
- **Solutions**:
  - Check `TWITTER_DRY_RUN` is set to `false`
  - Verify `POST_INTERVAL_MIN/MAX` settings
  - Check character file has valid `postExamples`
  - Review logs for error messages

#### Rate Limit Errors

- **Symptoms**: "Rate limit exceeded" messages
- **Solutions**:
  - Increase `POST_INTERVAL_MIN` to 120+ minutes
  - Reduce `MAX_ACTIONS_PROCESSING` to 1
  - Disable `ENABLE_ACTION_PROCESSING` temporarily
  - Wait 15 minutes before retrying

#### Account Suspended

- **Symptoms**: Cannot log in, account restricted
- **Solutions**:
  - Review Twitter's Terms of Service
  - Reduce posting frequency
  - Disable automated actions
  - Contact Twitter support if needed

## Best Practices

### Content Strategy

- **Vary your content**: Mix original thoughts, questions, and responses
- **Timing matters**: Post when your audience is most active
- **Quality over quantity**: Better to post less frequently with quality content
- **Engage authentically**: Respond to mentions and participate in conversations

### Technical Best Practices

- **Monitor logs**: Check for errors and warnings regularly
- **Backup configuration**: Keep a copy of your working `.env` file
- **Test changes**: Always use dry run mode when testing new settings
- **Stay updated**: Keep ElizaOS and plugins updated

### Security Best Practices

- **Use strong passwords**: Don't reuse passwords from other accounts
- **Enable 2FA**: Always use two-factor authentication
- **Monitor activity**: Regularly check your account for unusual posts
- **Rotate secrets**: Change passwords and 2FA periodically

## Advanced Configuration

### Custom Approval Workflow

Set up manual approval for all tweets via Discord:

1. Create a Discord server and bot
2. Get the channel ID where approvals will be sent
3. Configure approval settings:
   ```bash
   TWITTER_APPROVAL_ENABLED=true
   TWITTER_APPROVAL_DISCORD_CHANNEL_ID=your_channel_id
   TWITTER_APPROVAL_DISCORD_BOT_TOKEN=your_discord_bot_token
   ```
4. The agent will send proposed tweets to Discord for approval
5. React with ✅ to approve or ❌ to reject

### Multiple Character Personalities

Create different posting styles for various times or contexts:

```json
{
  "style": {
    "morning": ["energetic and motivational", "shares daily inspiration"],
    "evening": ["reflective and thoughtful", "asks philosophical questions"],
    "weekend": ["casual and fun", "shares interesting discoveries"]
  }
}
```

## Next Steps

Once you have basic Twitter functionality working, explore these advanced features:

- **[Advanced Twitter Configuration](../../customize/twitter-advanced.md)** - Personalization, automation strategies, and sophisticated posting behavior
- **[Twitter Technical Integration](../../technical/integrations/twitter-technical.md)** - Technical implementation details, API usage, and development patterns

## Support and Resources

- **Documentation**: [Twitter API Docs](https://developer.twitter.com/en/docs)
- **Community**: [ElizaOS Discord](https://discord.gg/elizaos)
- **Issues**: [GitHub Issues](https://github.com/elizaOS/eliza/issues)
- **Updates**: Follow [@elizaos](https://twitter.com/elizaos) for updates

## Legal and Compliance

- **Terms of Service**: Ensure compliance with Twitter's Terms of Service
- **Bot Policy**: Follow Twitter's Automation Rules and Best Practices
- **Privacy**: Respect user privacy and data protection laws
- **Disclosure**: Consider disclosing that your account is AI-powered

---

**⚠️ Important**: Twitter's policies and API can change. Always verify current requirements and test your setup in dry run mode before going live.
