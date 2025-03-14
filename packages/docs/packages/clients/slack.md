# Eliza Slack Client

This package provides Slack integration for the Eliza AI agent.

## Setup Guide

### Prerequisites

- A Slack workspace where you have permissions to install apps
- ngrok installed for local development (`brew install ngrok` on macOS)
- Node.js and pnpm installed

### Step 1: Start ngrok

1. Open a terminal and start ngrok on port 3069 (or your configured port):
    ```bash
    ngrok http 3069
    ```
2. Copy the HTTPS URL (e.g., `https://xxxx-xx-xx-xx-xx.ngrok-free.app`)
3. Keep this terminal open - closing it will invalidate the URL

### Step 2: Create Slack App

1. Go to [Slack API Apps page](https://api.slack.com/apps)
2. Click "Create New App"
3. Choose "From an app manifest"
4. Select your workspace
5. Copy this manifest, replacing `YOUR_NGROK_URL` with your ngrok HTTPS URL:

```yaml
display_information:
    name: eve
    description: Eve elizaos
    background_color: "#143187"
features:
    app_home:
        home_tab_enabled: true
        messages_tab_enabled: true
        messages_tab_read_only_enabled: false
    bot_user:
        display_name: eve
        always_online: false
oauth_config:
    scopes:
        bot:
            - app_mentions:read
            - channels:history
            - channels:join
            - channels:read
            - chat:write
            - files:read
            - files:write
            - groups:history
            - groups:read
            - im:history
            - im:read
            - im:write
            - mpim:history
            - mpim:read
            - mpim:write
            - users:read
settings:
    event_subscriptions:
        request_url: YOUR_NGROK_URL/slack/events
        bot_events:
            - app_mention
            - message.channels
            - message.groups
            - message.im
            - message.mpim
            - file_shared
    interactivity:
        is_enabled: true
        request_url: YOUR_NGROK_URL/slack/interactions
    org_deploy_enabled: false
    socket_mode_enabled: false
    token_rotation_enabled: false
```

6. Click "Create"
7. On the "Basic Information" page, scroll down to "App Credentials"
8. Copy all the credentials - you'll need them in Step 3

### Step 2.5: Verify Event Subscription

Before proceeding to install the app, make sure to verify the event subscription:

1. In your Slack App settings, go to "Event Subscriptions."
2. Enter the request URL (your ngrok HTTPS URL followed by /slack/events).
3. Slack will send a verification request to this URL.
4. Ensure your server is running and configured to respond to the url_verification event by echoing back the challenge token provided in the request.
5. Once verified, you will see a confirmation in your Slack app settings.

### Step 3: Configure Environment Variables

1. Create or edit `.env` file in your project root:
    ```bash
    SLACK_APP_ID=           # From Basic Information > App Credentials > App ID
    SLACK_CLIENT_ID=        # From Basic Information > App Credentials > Client ID
    SLACK_CLIENT_SECRET=    # From Basic Information > App Credentials > Client Secret
    SLACK_SIGNING_SECRET=   # From Basic Information > App Credentials > Signing Secret
    SLACK_BOT_TOKEN=        # From OAuth & Permissions > Bot User OAuth Token (starts with xoxb-)
    SLACK_VERIFICATION_TOKEN= # From Basic Information > App Credentials > Verification Token
    SLACK_SERVER_PORT=3069  # Must match the port you used with ngrok
    ```

### Step 4: Install the App

1. In your Slack App settings, go to "Install App"
2. Click "Install to Workspace"
3. Review the permissions and click "Allow"

### Step 5: Verify Installation

1. Start your Eliza server
2. Check the logs for successful connection
3. Test the bot:
    - In Slack, invite the bot to a channel: `/invite @eve`
    - Try mentioning the bot: `@eve hello`
    - Check your server logs for event reception

### Common Issues and Solutions

#### URL Verification Failed

- Make sure ngrok is running and the URL in your app settings matches exactly
- Check that the `/slack/events` endpoint is accessible
- Verify your environment variables are set correctly

#### Bot Not Responding

1. Check server logs for incoming events
2. Verify the bot is in the channel
3. Ensure all required scopes are granted
4. Try reinstalling the app to refresh permissions

#### Messages Not Received

1. Verify Event Subscriptions are enabled
2. Check the Request URL is correct and verified
3. Confirm all bot events are subscribed
4. Ensure the bot token starts with `xoxb-`

### Updating ngrok URL

If you restart ngrok, you'll get a new URL. You'll need to:

1. Copy the new ngrok HTTPS URL
2. Update the Request URLs in your Slack App settings:
    - Event Subscriptions > Request URL
    - Interactivity & Shortcuts > Request URL
3. Wait for URL verification to complete

### Security Notes

- Never commit your `.env` file or tokens to version control
- Rotate your tokens if they're ever exposed
- Use HTTPS URLs only for Request URLs
- Keep your ngrok and server running while testing

## Development

### Local Testing

1. Start ngrok: `ngrok http 3069`
2. Update Slack App URLs with new ngrok URL
3. Start the server: `pnpm start`
4. Monitor logs for events and errors

### Debugging

Enable detailed logging by setting:

```bash
DEBUG=eliza:*
```

### Adding New Features

1. Update the manifest if adding new scopes
2. Reinstall the app to apply new permissions
3. Update documentation for any new environment variables

## Support

For issues or questions:

1. Check the Common Issues section above
2. Review server logs for errors
3. Verify all setup steps are completed
4. Open an issue with:
    - Error messages
    - Server logs
    - Steps to reproduce
