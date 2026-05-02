# Google Meet REST API Plugin Documentation

## Overview

The Google Meet plugin for ElizaOS provides integration with Google Meet using the official REST API. This enables agents to:

- Create and manage meeting spaces
- Get participant information
- Access meeting artifacts (transcripts, recordings)
- Generate comprehensive meeting reports

## Architecture

This plugin uses a service-based architecture with two main services:

### GoogleAuthService
Handles OAuth2 authentication with Google:
- Manages OAuth2 flow
- Stores and refreshes access tokens
- Provides authentication status

### GoogleMeetAPIService
Interfaces with the Google Meet REST API:
- Creates meeting spaces
- Retrieves conference information
- Lists participants
- Accesses meeting artifacts

## Actions

### AUTHENTICATE_GOOGLE
Initiates OAuth2 authentication flow.

**Triggers**: "authenticate with google", "login to google", "sign in"

**Process**:
1. Generates OAuth2 authorization URL
2. Starts local server for callback
3. User authorizes in browser
4. Receives and stores tokens

### CREATE_MEETING
Creates a new Google Meet meeting space.

**Triggers**: "create meeting", "start a call", "new meeting"

**Parameters**:
- `accessType`: OPEN, TRUSTED, or RESTRICTED (optional)

**Returns**: Meeting link and code

### GET_MEETING_INFO
Retrieves information about a meeting.

**Triggers**: "meeting status", "check meeting", "meeting info"

**Returns**: Meeting details, status, participants

### GET_PARTICIPANTS
Lists participants in a meeting.

**Triggers**: "who's in the meeting", "list participants", "attendees"

**Returns**: Participant list with join/leave times

### GENERATE_REPORT
Generates a report from meeting artifacts.

**Triggers**: "generate report", "meeting summary", "get transcript"

**Parameters**:
- `includeTranscript`: Include full transcript (optional)
- `includeActionItems`: Extract action items (optional)

**Returns**: Formatted report saved to file

## Providers

### GOOGLE_MEET_PROVIDER
Provides current meeting context to the agent.

**Returns**: Current meeting status, participant count, duration

## Configuration

### Required Environment Variables

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

### Optional Environment Variables

```bash
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
GOOGLE_REFRESH_TOKEN=your-refresh-token
GOOGLE_MEET_DEFAULT_ACCESS_TYPE=OPEN
REPORT_OUTPUT_DIR=./meeting-reports
```

## API Integration

The plugin uses these Google Meet API endpoints:

- `spaces.create`: Create new meeting spaces
- `spaces.get`: Get meeting space details
- `spaces.endActiveConference`: End active conferences
- `conferenceRecords.get`: Get conference information
- `conferenceRecords.participants.list`: List participants
- `conferenceRecords.transcripts.get`: Get transcripts
- `conferenceRecords.recordings.list`: List recordings

## Limitations

1. **Real-time Updates**: The API provides data with some delay
2. **Meeting Control**: Limited control over active meetings
3. **Transcripts**: Only available after meetings with recording enabled
4. **Participant Updates**: Not real-time, requires polling

## Security Considerations

- OAuth2 tokens are stored in memory
- Refresh tokens should be stored securely
- Use environment variables for sensitive data
- Follow Google's OAuth2 best practices

## Error Handling

The plugin handles common errors:

- **Authentication errors**: Prompts for re-authentication
- **API rate limits**: Implements exponential backoff
- **Network errors**: Retries with timeout
- **Invalid meeting IDs**: Returns user-friendly messages

## Best Practices

1. **Authentication**: Store refresh token after first auth
2. **Rate Limiting**: Avoid excessive API calls
3. **Error Messages**: Provide clear user feedback
4. **Logging**: Use appropriate log levels
5. **Configuration**: Validate all settings on init 