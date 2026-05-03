# ElizaOS Google Meet Plugin

Google Meet integration plugin for ElizaOS - manage meetings, get participant info, and access meeting artifacts via Google Meet REST API.

## Features

- 🔐 **OAuth2 Authentication** - Secure authentication with Google
- 📅 **Meeting Management** - Create and manage Google Meet spaces
- 👥 **Participant Tracking** - Get real-time participant information  
- 📝 **Meeting Artifacts** - Access recordings and transcripts (when available)
- 📊 **Meeting Reports** - Generate reports from meeting data
- 🔒 **Privacy-First** - Uses official Google APIs with proper authorization

## Version 2.0 - Complete API Rewrite

This plugin has been completely rewritten to use the official Google Meet REST API instead of browser automation. This provides:

- **Stability**: No more DOM hacks or browser dependencies
- **Reliability**: Official API with proper error handling
- **Security**: OAuth2 authentication with Google
- **Scalability**: Server-side operation without browser overhead

## Prerequisites

1. Google Cloud Project with Meet API enabled
2. OAuth2 credentials (Client ID and Secret)
3. Node.js 18+ and npm/yarn/bun

## Installation

### 1. Set up Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable the Google Meet API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Meet API"
   - Click "Enable"
4. Create OAuth2 credentials:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Choose "Web application"
   - Add authorized redirect URI: `http://localhost:3000/oauth2callback`
   - Save the Client ID and Client Secret

### 2. Configure ElizaOS

Create a `.env` file in your project root:

```bash
# Required: OAuth2 credentials
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Optional: OAuth redirect URI (default: http://localhost:3000/oauth2callback)
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback

# Optional: If you have a refresh token from previous auth
# GOOGLE_REFRESH_TOKEN=your-refresh-token

# Optional: Default meeting settings
GOOGLE_MEET_DEFAULT_ACCESS_TYPE=OPEN  # OPEN, TRUSTED, or RESTRICTED
REPORT_OUTPUT_DIR=./meeting-reports
```

### 3. Add Plugin to Your Agent

```javascript
import { googleMeetPlugin } from '@elizaos/plugin-google-meet-cute';

const character = {
  name: "MyAgent",
  plugins: [googleMeetPlugin],
  // ... rest of your character config
};
```

### 4. Start Your Agent

```bash
npm start
```

## Usage

### First Time Setup - Authenticate

```
User: Authenticate with Google
Agent: I'll help you authenticate with Google Meet API...
[Opens browser for OAuth flow]
```

After authentication, save the refresh token to your `.env` file to avoid re-authentication.

### Create a Meeting

```
User: Create a new meeting
Agent: I'll create a new Google Meet meeting for you...
Returns: Meeting link and code
```

```
User: Create a private meeting
Agent: I'll create a restricted access meeting...
Returns: Meeting link with restricted access
```

### Get Meeting Information

```
User: What's the status of the current meeting?
Agent: I'll check the current meeting status...
Returns: Meeting details, participants, duration
```

### List Participants

```
User: Who's in the meeting?
Agent: I'll check who's currently in the meeting...
Returns: List of participants with join times
```

### Generate Meeting Report

```
User: Generate a report for the meeting
Agent: I'll generate a comprehensive report...
Returns: Meeting summary with available artifacts
```

## Available Actions

| Action | Description | Example Commands |
|--------|-------------|------------------|
| `AUTHENTICATE_GOOGLE` | Authenticate with Google OAuth2 | "Authenticate with Google", "Login to Google" |
| `CREATE_MEETING` | Create a new meeting space | "Create a meeting", "Start a new call" |
| `GET_MEETING_INFO` | Get meeting details | "Meeting status", "Check meeting" |
| `GET_PARTICIPANTS` | List meeting participants | "Who's in the meeting?", "List attendees" |
| `GENERATE_REPORT` | Generate meeting report | "Create report", "Get transcript" |

## API Limitations

The Google Meet REST API has some limitations:

1. **Real-time Data**: The API provides conference records after meetings, not real-time data
2. **Transcripts**: Only available after meetings end and if recording was enabled
3. **Participant Updates**: Participant lists update with some delay
4. **Meeting Control**: Limited control over active meetings (can't mute, remove participants, etc.)

## Technical Details

- Uses the official `@google-apps/meet` Node.js client library
- OAuth2 authentication with Google
- Supports meeting spaces and conference records
- Access to meeting artifacts (recordings, transcripts)
- No browser automation or DOM manipulation

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ElizaOS Agent │────▶│  Google Auth     │────▶│  Google Meet    │
│                 │     │  Service         │     │  REST API       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Google Meet API │
                        │  Service         │
                        └──────────────────┘
```

## Troubleshooting

### Authentication Issues

- Ensure Client ID and Secret are correctly set in `.env`
- Check that redirect URI matches exactly in Google Console and `.env`
- Verify Meet API is enabled in Google Cloud Console

### API Errors

- **403 Forbidden**: Check OAuth scopes and API enablement
- **404 Not Found**: Meeting space or conference may not exist
- **429 Too Many Requests**: Implement rate limiting

### Getting Help

1. Check logs for detailed error messages
2. Ensure all environment variables are set
3. Verify Google Cloud Project configuration
4. Open an issue with error details

## Development

### Running Tests

```bash
npm test
```

### Building

```bash
npm run build
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT

## Changelog

### v2.0.0
- Complete rewrite to use Google Meet REST API
- Removed Chrome extension dependency
- Added OAuth2 authentication
- Improved stability and reliability
- Better error handling

### v1.0.0
- Initial release with browser automation
