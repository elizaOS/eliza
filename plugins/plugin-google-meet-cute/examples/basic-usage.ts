/**
 * Basic usage example for the Google Meet REST API plugin
 * 
 * This plugin uses the official Google Meet REST API to:
 * - Create and manage meeting spaces
 * - Get participant information
 * - Access meeting artifacts (transcripts, recordings)
 */

import { AgentRuntime } from "@elizaos/core";
import { googleMeetPlugin } from "@elizaos/plugin-google-meet-cute";

// Example character configuration
const character = {
  name: "MeetBot",
  bio: "A helpful AI assistant that manages Google Meet meetings",
  plugins: ["@elizaos/plugin-google-meet-cute"],
};

// Example usage in your agent
async function setupAgent() {
  // Initialize your agent runtime
  const runtime = new AgentRuntime({
    character,
    // ... other configuration
  });

  // The plugin will be automatically loaded and available
  
  // First time setup: Authenticate with Google
  // User: "Authenticate with Google"
  // Agent will provide OAuth2 URL for authentication
  
  // Example actions that can be triggered:
  
  // 1. Create a new meeting
  // User: "Create a new meeting"
  // User: "Start a private team meeting" (creates restricted access)
  
  // 2. Get meeting information
  // User: "What's the status of the current meeting?"
  // User: "Show meeting details"
  
  // 3. List participants
  // User: "Who's in the meeting?"
  // User: "List all participants"
  
  // 4. Generate meeting report
  // User: "Generate a meeting report"
  // User: "Get the meeting transcript"
}

// Environment variables needed:
console.log(`
Google Meet REST API Plugin - Configuration

Required environment variables:
- GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
- GOOGLE_CLIENT_SECRET=your-client-secret

Optional:
- GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
- GOOGLE_REFRESH_TOKEN=your-refresh-token (after first auth)
- GOOGLE_MEET_DEFAULT_ACCESS_TYPE=OPEN (OPEN, TRUSTED, or RESTRICTED)
- REPORT_OUTPUT_DIR=./meeting-reports

Setup steps:
1. Create a Google Cloud Project
2. Enable Google Meet API
3. Create OAuth2 credentials
4. Configure environment variables
5. Run agent and authenticate
6. Start using Meet API features!

Available actions:
- AUTHENTICATE_GOOGLE: Authenticate with Google OAuth2
- CREATE_MEETING: Create a new meeting space
- GET_MEETING_INFO: Get meeting details
- GET_PARTICIPANTS: List meeting participants  
- GENERATE_REPORT: Generate meeting report from artifacts
`); 