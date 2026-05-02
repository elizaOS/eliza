import { Service, IAgentRuntime, logger } from "@elizaos/core";
import { OAuth2Client } from "google-auth-library";
import { createServer } from "http";
import { URL } from "url";

export class GoogleAuthService extends Service {
  static serviceType = "google-auth" as const;
  
  private oauth2Client: OAuth2Client;
  private authenticated: boolean = false;
  
  get capabilityDescription(): string {
    return "Google OAuth2 authentication service for Google Meet API";
  }
  
  constructor(runtime: IAgentRuntime) {
    super(runtime);
    
    const clientId = runtime.getSetting("GOOGLE_CLIENT_ID");
    const clientSecret = runtime.getSetting("GOOGLE_CLIENT_SECRET");
    const redirectUri = runtime.getSetting("GOOGLE_REDIRECT_URI") || "http://localhost:3000/oauth2callback";
    
    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth2 credentials not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
    }
    
    this.oauth2Client = new OAuth2Client(
      clientId,
      clientSecret,
      redirectUri
    );
    
    // Check if we have a refresh token
    const refreshToken = runtime.getSetting("GOOGLE_REFRESH_TOKEN");
    if (refreshToken) {
      this.oauth2Client.setCredentials({
        refresh_token: refreshToken
      });
      this.authenticated = true;
      logger.info("Authenticated with Google using refresh token");
    }
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info("Starting Google Auth Service");
    const service = new GoogleAuthService(runtime);
    await service.initialize();
    return service;
  }
  
  async initialize(): Promise<void> {
    if (!this.authenticated) {
      logger.info("Google OAuth2 client initialized. Use authenticateInteractive() to authenticate.");
    }
  }
  
  getAuthUrl(): string {
    const scopes = [
      'https://www.googleapis.com/auth/meetings.space.created',
      'https://www.googleapis.com/auth/meetings.space.readonly',
    ];
    
    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
    
    return authUrl;
  }
  
  async authenticateInteractive(): Promise<void> {
    if (this.authenticated) {
      logger.info("Already authenticated with Google");
      return;
    }
    
    const authUrl = this.getAuthUrl();
    logger.info(`Please visit this URL to authenticate: ${authUrl}`);
    
    // Start a temporary server to handle the OAuth callback
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (url.pathname === '/oauth2callback') {
          const code = url.searchParams.get('code');
          
          if (code) {
            const { tokens } = await this.oauth2Client.getToken(code);
            this.oauth2Client.setCredentials(tokens);
            this.authenticated = true;
            
            logger.info("Successfully authenticated with Google");
            logger.info(`Refresh token: ${tokens.refresh_token}`);
            logger.info("Save this refresh token in your .env file as GOOGLE_REFRESH_TOKEN to avoid re-authentication");
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Authentication successful!</h1><p>You can close this window.</p>');
            
            server.close();
          } else {
            throw new Error("No authorization code received");
          }
        }
      } catch (error) {
        logger.error("OAuth callback error:", error);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed!</h1><p>Check the logs for details.</p>');
        server.close();
      }
    });
    
    const redirectUri = this.runtime.getSetting("GOOGLE_REDIRECT_URI") || "http://localhost:3000/oauth2callback";
    const port = new URL(redirectUri).port || "3000";
    server.listen(parseInt(port));
    
    return new Promise((resolve) => {
      server.on('close', resolve);
    });
  }
  
  async getAccessToken(): Promise<string> {
    if (!this.authenticated) {
      throw new Error("Not authenticated. Please authenticate first.");
    }
    
    const tokens = await this.oauth2Client.getAccessToken();
    if (!tokens.token) {
      throw new Error("Failed to get access token");
    }
    
    return tokens.token;
  }
  
  getOAuth2Client(): OAuth2Client {
    return this.oauth2Client;
  }
  
  isAuthenticated(): boolean {
    return this.authenticated;
  }
  
  async stop(): Promise<void> {
    logger.info("Stopping Google Auth Service");
    // No cleanup needed for OAuth client
  }
} 