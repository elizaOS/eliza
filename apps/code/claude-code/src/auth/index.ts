/**
 * Authentication Manager
 * 
 * Main entry point for authentication functionality. Handles authentication
 * flow, token management, and coordination of OAuth and API key auth methods.
 */

import { 
  AuthToken, 
  AuthConfig, 
  AuthMethod, 
  AuthResult, 
  OAuthConfig 
} from './types.js';
import { 
  DEFAULT_OAUTH_CONFIG, 
  performOAuthFlow, 
  refreshOAuthToken 
} from './oauth.js';
import { 
  createTokenStorage, 
  isTokenExpired, 
  validateToken, 
  getTokenDetails,
  createAuthorizationHeader 
} from './tokens.js';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';

// Default auth configuration
const DEFAULT_AUTH_CONFIG: AuthConfig = {
  preferredMethod: AuthMethod.API_KEY,
  autoRefresh: true,
  tokenRefreshThreshold: 300, // 5 minutes
  maxRetryAttempts: 3
};

// Storage key for auth tokens
const AUTH_STORAGE_KEY = 'anthropic-auth';

/**
 * Authentication state
 */
interface AuthState {
  initialized: boolean;
  authenticated: boolean;
  token: AuthToken | null;
  method: AuthMethod | null;
  lastError: Error | null;
}

/**
 * Authentication Manager
 */
export class AuthManager {
  private config: AuthConfig;
  private tokenStorage;
  private state: AuthState;
  
  /**
   * Create a new auth manager
   */
  constructor(config: Partial<AuthConfig> = {}) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
    this.tokenStorage = createTokenStorage();
    this.state = {
      initialized: false,
      authenticated: false,
      token: null,
      method: null,
      lastError: null
    };
    
    logger.debug('AuthManager created with config', this.config);
  }
  
  /**
   * Initialize authentication
   */
  async initialize(): Promise<boolean> {
    logger.info('Initializing authentication');
    
    try {
      // Load stored token
      const token = await this.tokenStorage.getToken(AUTH_STORAGE_KEY);
      
      if (token) {
        logger.debug('Found stored auth token');
        
        // Check if token is valid and not expired
        if (validateToken(token)) {
          logger.debug('Stored token is valid');
          this.state.token = token;
          this.state.authenticated = true;
          
          // Determine authentication method from token properties
          this.state.method = token.refreshToken 
            ? AuthMethod.OAUTH 
            : AuthMethod.API_KEY;
          
          logger.info(`Authenticated using stored ${this.state.method} token`);
        } else if (this.config.autoRefresh && token.refreshToken) {
          logger.debug('Stored token expired, attempting refresh');
          
          // Try to refresh the token
          await this.refreshToken();
        } else {
          logger.debug('Stored token is invalid, clearing it');
          await this.tokenStorage.deleteToken(AUTH_STORAGE_KEY);
        }
      } else {
        logger.debug('No stored auth token found');
      }
      
      this.state.initialized = true;
      return this.state.authenticated;
    } catch (error) {
      logger.error('Failed to initialize authentication', error);
      this.state.lastError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }
  
  /**
   * Check if the current token needs refresh
   */
  async checkAndRefreshToken(): Promise<boolean> {
    if (!this.state.token || !this.config.autoRefresh) {
      return false;
    }
    
    // Only refresh OAuth tokens
    if (this.state.method !== AuthMethod.OAUTH || !this.state.token.refreshToken) {
      return false;
    }
    
    // Check if token is near expiration
    const threshold = this.config.tokenRefreshThreshold || 300;
    
    if (isTokenExpired(this.state.token, threshold)) {
      logger.debug('Token is near expiration, refreshing');
      return await this.refreshToken();
    }
    
    return false;
  }
  
  /**
   * Refresh the current token
   */
  async refreshToken(): Promise<boolean> {
    if (!this.state.token?.refreshToken) {
      logger.debug('No refresh token available');
      return false;
    }
    
    logger.info('Refreshing authentication token');
    
    try {
      const oauthConfig = this.config.oauth || DEFAULT_OAUTH_CONFIG;
      
      const newToken = await refreshOAuthToken(
        this.state.token.refreshToken,
        oauthConfig
      );
      
      // Update state with new token
      this.state.token = newToken;
      
      // Save the new token
      await this.tokenStorage.saveToken(AUTH_STORAGE_KEY, newToken);
      
      logger.info('Token refreshed successfully');
      return true;
    } catch (error) {
      logger.error('Failed to refresh token', error);
      this.state.lastError = error instanceof Error ? error : new Error(String(error));
      
      // Clear invalid token
      this.state.token = null;
      this.state.authenticated = false;
      await this.tokenStorage.deleteToken(AUTH_STORAGE_KEY);
      
      return false;
    }
  }
  
  /**
   * Authenticate with API key
   */
  async authenticateWithApiKey(apiKey: string): Promise<AuthResult> {
    logger.info('Authenticating with API key');
    
    try {
      // Validate API key format
      if (!apiKey || apiKey.trim().length < 10) {
        throw createUserError('Invalid API key format', {
          category: ErrorCategory.AUTHENTICATION,
          resolution: 'Check your API key and try again.'
        });
      }
      
      // Create a token from the API key
      const token: AuthToken = {
        accessToken: apiKey,
        expiresAt: 0, // API keys don't expire
        tokenType: 'Bearer',
        scope: 'anthropic.api'
      };
      
      // Save the token
      await this.tokenStorage.saveToken(AUTH_STORAGE_KEY, token);
      
      // Update state
      this.state.token = token;
      this.state.authenticated = true;
      this.state.method = AuthMethod.API_KEY;
      
      logger.info('API key authentication successful');
      
      return {
        success: true,
        token,
        method: AuthMethod.API_KEY,
        state: AuthState.AUTHENTICATED
      };
    } catch (error) {
      logger.error('API key authentication failed', error);
      
      this.state.lastError = error instanceof Error ? error : new Error(String(error));
      this.state.authenticated = false;
      this.state.token = null;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        method: AuthMethod.API_KEY,
        state: AuthState.FAILED
      };
    }
  }
  
  /**
   * Authenticate with OAuth
   */
  async authenticateWithOAuth(config?: OAuthConfig): Promise<AuthResult> {
    logger.info('Authenticating with OAuth');
    
    try {
      const oauthConfig = config || this.config.oauth || DEFAULT_OAUTH_CONFIG;
      
      // Perform the OAuth flow
      const result = await performOAuthFlow(oauthConfig);
      
      if (result.success && result.token) {
        // Save the token
        await this.tokenStorage.saveToken(AUTH_STORAGE_KEY, result.token);
        
        // Update state
        this.state.token = result.token;
        this.state.authenticated = true;
        this.state.method = AuthMethod.OAUTH;
        
        logger.info('OAuth authentication successful');
      } else {
        logger.warn('OAuth authentication failed', result.error);
        
        if (result.error) {
          this.state.lastError = new Error(result.error);
        }
      }
      
      return result;
    } catch (error) {
      logger.error('OAuth authentication failed', error);
      
      this.state.lastError = error instanceof Error ? error : new Error(String(error));
      this.state.authenticated = false;
      this.state.token = null;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        method: AuthMethod.OAUTH,
        state: AuthState.FAILED
      };
    }
  }
  
  /**
   * Log out (clear credentials)
   */
  async logout(): Promise<void> {
    logger.info('Logging out');
    
    // Clear state
    this.state.token = null;
    this.state.authenticated = false;
    this.state.method = null;
    
    // Clear storage
    await this.tokenStorage.deleteToken(AUTH_STORAGE_KEY);
    
    logger.info('Logged out successfully');
  }
  
  /**
   * Get the current auth token
   */
  getToken(): AuthToken | null {
    return this.state.token;
  }
  
  /**
   * Get authorization header for API requests
   */
  getAuthorizationHeader(): string | null {
    if (!this.state.token) {
      return null;
    }
    
    return createAuthorizationHeader(this.state.token);
  }
  
  /**
   * Check if authenticated
   */
  isAuthenticated(): boolean {
    return this.state.authenticated && !!this.state.token;
  }
  
  /**
   * Get the current auth method
   */
  getAuthMethod(): AuthMethod | null {
    return this.state.method;
  }
  
  /**
   * Get token details for display
   */
  getTokenDetails(): Record<string, string> | null {
    if (!this.state.token) {
      return null;
    }
    
    return getTokenDetails(this.state.token);
  }
  
  /**
   * Get the last error
   */
  getLastError(): Error | null {
    return this.state.lastError;
  }
}

// Create and export singleton auth manager
export const authManager = new AuthManager();

/**
 * Initialize the authentication system
 * 
 * @param config Configuration options for authentication
 * @returns The initialized authentication manager
 */
export async function initAuthentication(config: any = {}): Promise<any> {
  logger.info('Initializing authentication system');
  
  try {
    // Update auth manager with provided config
    if (config.auth) {
      // Update configuration by creating a new instance if needed
      // or applying the settings to the existing instance
      // Note: We can't call a non-existent configure method
    }
    
    // Initialize auth manager
    await authManager.initialize();
    
    logger.info('Authentication system initialized successfully');
    
    // Return auth interface
    return {
      /**
       * Authenticate with the specified method
       */
      authenticate: async (options: { method?: AuthMethod } = {}): Promise<AuthResult> => {
        const method = options.method || authManager.getAuthMethod() || DEFAULT_AUTH_CONFIG.preferredMethod;
        
        if (method === AuthMethod.API_KEY) {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          
          if (!apiKey) {
            throw createUserError('API key not found', {
              category: ErrorCategory.AUTHENTICATION,
              resolution: 'Please set the ANTHROPIC_API_KEY environment variable or log in with OAuth.'
            });
          }
          
          return authManager.authenticateWithApiKey(apiKey);
        } else if (method === AuthMethod.OAUTH) {
          return authManager.authenticateWithOAuth();
        } else {
          throw createUserError(`Unsupported authentication method: ${method}`, {
            category: ErrorCategory.AUTHENTICATION,
            resolution: 'Please use either "api_key" or "oauth" as the authentication method.'
          });
        }
      },
      
      /**
       * Log out (clear credentials)
       */
      logout: async (): Promise<void> => {
        return authManager.logout();
      },
      
      /**
       * Get the current token
       */
      getToken: (): AuthToken | null => {
        return authManager.getToken();
      },
      
      /**
       * Check if authenticated
       */
      isAuthenticated: (): boolean => {
        return authManager.isAuthenticated();
      },
      
      /**
       * Get the current authentication method
       */
      getAuthMethod: (): AuthMethod | null => {
        return authManager.getAuthMethod();
      },
      
      /**
       * Get token details (for display)
       */
      getTokenDetails: (): Record<string, string> | null => {
        return authManager.getTokenDetails();
      },
      
      /**
       * Get authorization header
       */
      getAuthorizationHeader: (): string | null => {
        return authManager.getAuthorizationHeader();
      },
      
      /**
       * Refresh the token
       */
      refreshToken: async (): Promise<boolean> => {
        return authManager.refreshToken();
      }
    };
  } catch (error) {
    logger.error('Failed to initialize authentication system', error);
    throw error;
  }
}

// Export other auth components
export * from './types.js';
export * from './oauth.js';
export * from './tokens.js'; 