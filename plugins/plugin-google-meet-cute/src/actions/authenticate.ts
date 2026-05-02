import { Action, IAgentRuntime, Memory, HandlerCallback, State, logger } from "@elizaos/core";
import { GoogleAuthService } from "../services/googleAuthService";
import { AuthenticateParams } from "../types";

export const authenticateAction: Action = {
  name: "AUTHENTICATE_GOOGLE",
  description: "Authenticate with Google to access Meet API",
  similes: ["login to google", "google auth", "sign in", "authenticate"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Authenticate with Google"
        }
      },
      {
        name: "assistant", 
        content: {
          text: "I'll help you authenticate with Google Meet API.",
          action: "AUTHENTICATE_GOOGLE"
        }
      }
    ]
  ],
  
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const authService = runtime.getService("google-auth") as GoogleAuthService;
    
    if (!authService) {
      logger.error("Google Auth service not found");
      return false;
    }
    
    return true;
  },
  
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    params?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    try {
      const authService = runtime.getService("google-auth") as GoogleAuthService;
      
      if (!authService) {
        throw new Error("Google Auth service not found");
      }
      
      const authParams = params as AuthenticateParams | undefined;
      
      if (authService.isAuthenticated()) {
        if (callback) {
          callback({
            text: "✅ Already authenticated with Google Meet API. You can now create meetings, get participant info, and access meeting artifacts."
          });
        }
        return;
      }
      
      // Check if we should do interactive auth
      const interactive = authParams?.interactive !== false;
      
      if (interactive) {
        const authUrl = authService.getAuthUrl();
        
        if (callback) {
          callback({
            text: `🔐 To authenticate with Google Meet API:

1. Visit this URL: ${authUrl}
2. Sign in with your Google account
3. Grant the requested permissions
4. You'll be redirected back to complete authentication

Starting authentication server...`,
            metadata: {
              authUrl: authUrl,
              interactive: true
            }
          });
        }
        
        // Start interactive authentication
        await authService.authenticateInteractive();
        
        if (callback) {
          callback({
            text: `✅ Successfully authenticated with Google Meet API!

You can now:
- Create new meetings
- Get meeting information
- List participants
- Generate reports from meeting artifacts

💡 Tip: Save the refresh token shown in the logs to your .env file to avoid re-authentication.`
          });
        }
      } else {
        if (callback) {
          callback({
            text: `❌ Authentication required. Please set up Google OAuth credentials:

1. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file
2. Optionally set GOOGLE_REFRESH_TOKEN if you have one
3. Run this command again to authenticate interactively`
          });
        }
      }
    } catch (error) {
      logger.error("Failed to authenticate:", error);
      
      if (callback) {
        callback({
          text: `❌ Failed to authenticate: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: true
        });
      }
    }
  }
}; 