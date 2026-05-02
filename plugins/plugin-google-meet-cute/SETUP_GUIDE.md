# Google Meet REST API Plugin - Quick Setup Guide

## Prerequisites

1. **Google Cloud Account**: You'll need a Google Cloud account (free tier is fine)
2. **Node.js**: Version 18 or higher
3. **ElizaOS**: Already set up and running

## Step 1: Enable Google Meet API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Navigate to **APIs & Services** > **Library**
4. Search for "Google Meet API"
5. Click on it and press **Enable**

## Step 2: Create OAuth2 Credentials

1. In Cloud Console, go to **APIs & Services** > **Credentials**
2. Click **+ Create Credentials** > **OAuth client ID**
3. If prompted, configure OAuth consent screen:
   - Choose "External" user type
   - Fill in required fields (app name, email, etc.)
   - Add scopes: `../auth/meetings.space.created` and `../auth/meetings.space.readonly`
4. For Application type, choose **Web application**
5. Add authorized redirect URI: `http://localhost:3000/oauth2callback`
6. Click **Create**
7. Save the Client ID and Client Secret

## Step 3: Configure ElizaOS

Add to your `.env` file:

```bash
# Required
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret-here

# Optional
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
REPORT_OUTPUT_DIR=./meeting-reports
```

## Step 4: Add Plugin to Your Agent

In your agent configuration:

```javascript
import { googleMeetPlugin } from '@elizaos/plugin-google-meet-cute';

const character = {
  name: "YourAgent",
  plugins: [googleMeetPlugin],
  // ... rest of config
};
```

## Step 5: First Time Authentication

1. Start your agent: `npm start`
2. Say: "Authenticate with Google"
3. Visit the provided URL in your browser
4. Sign in with Google and grant permissions
5. You'll be redirected back and authenticated

**Important**: After authentication, check the logs for your refresh token and add it to `.env`:
```bash
GOOGLE_REFRESH_TOKEN=your-refresh-token-here
```

This prevents needing to re-authenticate every time.

## Usage Examples

### Create a Meeting
```
User: Create a new meeting
Agent: ✅ Meeting created successfully!
- Meeting Link: https://meet.google.com/abc-defg-hij
- Meeting Code: abc-defg-hij
```

### Get Meeting Info
```
User: What's the status of the current meeting?
Agent: 📅 Meeting Information:
- Status: ACTIVE
- Participants: 5
```

### Generate Report
```
User: Generate a meeting report
Agent: ✅ Meeting report generated successfully!
[Saves to ./meeting-reports/]
```

## Troubleshooting

### "Not authenticated" Error
- Ensure you've run the authenticate command first
- Check that Client ID and Secret are correct in `.env`

### "API not enabled" Error
- Go back to Cloud Console and ensure Meet API is enabled
- Wait a few minutes for changes to propagate

### "Invalid redirect URI" Error
- Ensure the redirect URI in `.env` matches exactly what's in Cloud Console
- Default is `http://localhost:3000/oauth2callback`

## Need Help?

- Check logs for detailed error messages
- Ensure all environment variables are set correctly
- Verify Google Cloud Project configuration
- Open an issue on GitHub with error details 