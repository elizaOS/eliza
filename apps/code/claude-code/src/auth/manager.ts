/**
 * Authentication Manager
 * 
 * Manages authentication processes, token handling, and authentication state.
 */

import { AuthToken, AuthMethod, AuthState, AuthResult, TokenStorage, OAuthConfig } from './types.js';
import { createTokenStorage, isTokenExpired } from './tokens.js';
import { performOAuthFlow, refreshOAuthToken, DEFAULT_OAUTH_CONFIG } from './oauth.js';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

// Authentication events
export const AUTH_EVENTS = {
  STATE_CHANGED: 'auth:state_changed',
  LOGGED_IN: 'auth:logged_in',
  LOGGED_OUT: 'auth:logged_out',
  TOKEN_REFRESHED: 'auth:token_refreshed',
  ERROR: 'auth:error'
};

/**
 * Authentication Manager Class
 * 
 * Centralizes all authentication-related functionality
 */
export class AuthManager extends EventEmitter {
  private state: AuthState = AuthState.INITIAL;
  private tokenStorage: TokenStorage;
  private currentToken: AuthToken | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly tokenKey = 'default';
  private readonly config: {
    apiKey?: string;
    oauth?: OAuthConfig;
    preferredMethod?: AuthMethod;
    autoRefresh: boolean;
    tokenRefreshThreshold: number;
    maxRetryAttempts: number;
  };

  /**
   * Create a new AuthManager instance
   */
  constructor(config: any) {
    super();
    
    // Extract authentication-related configuration
    this.config = {
      apiKey: config.api?.key,
      oauth: config.oauth || DEFAULT_OAUTH_CONFIG,
      preferredMethod: config.preferredMethod,
      autoRefresh: config.autoRefresh !== false,
      tokenRefreshThreshold: config.tokenRefreshThreshold || 300, // 5 minutes
      maxRetryAttempts: config.maxRetryAttempts || 3
    };
    
    // Create token storage
    this.tokenStorage = createTokenStorage();
    
    logger.debug('Authentication manager created');
  }

  /**
   * Initialize the authentication manager
   */
  async initialize(): Promise<void> {
    logger.debug('Initializing authentication manager');
    
    try {
      // Try to load existing token
      this.currentToken = await this.tokenStorage.getToken(this.tokenKey);
      
      if (this.currentToken) {
        // Check if token is valid and not expired
        if (isTokenExpired(this.currentToken, this.config.tokenRefreshThreshold)) {
          logger.info('Token expired, attempting to refresh');
          
          if (this.currentToken.refreshToken) {
            try {
              await this.refreshToken();
            } catch (error) {
              logger.warn('Failed to refresh token, will need to re-authenticate');
              this.currentToken = null;
              this.setState(AuthState.INITIAL);
            }
          } else {
            logger.warn('No refresh token available, will need to re-authenticate');
            this.currentToken = null;
            this.setState(AuthState.INITIAL);
          }
        } else {
          // Valid token
          logger.info('Valid authentication token found');
          this.setState(AuthState.AUTHENTICATED);
          
          // Set up auto-refresh if enabled
          if (this.config.autoRefresh) {
            this.scheduleTokenRefresh();
          }
        }
      } else {
        logger.info('No authentication token found');
        this.setState(AuthState.INITIAL);
      }
    } catch (error) {
      logger.error('Error initializing authentication manager', error);
      this.setState(AuthState.FAILED);
      this.emit(AUTH_EVENTS.ERROR, error);
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.state === AuthState.AUTHENTICATED && !!this.currentToken;
  }

  /**
   * Get the current authentication state
   */
  getState(): AuthState {
    return this.state;
  }

  /**
   * Get the current authentication token
   */
  getToken(): AuthToken | null {
    return this.currentToken;
  }

  /**
   * Get the authorization header value for API requests
   */
  getAuthorizationHeader(): string | null {
    if (!this.currentToken) {
      return null;
    }
    
    return `${this.currentToken.tokenType} ${this.currentToken.accessToken}`;
  }

  /**
   * Authenticate the user
   */
  async authenticate(method?: AuthMethod): Promise<AuthResult> {
    // Determine authentication method
    const authMethod = method || this.config.preferredMethod || (this.config.apiKey ? AuthMethod.API_KEY : AuthMethod.OAUTH);
    
    logger.info(`Authenticating using ${authMethod} method`);
    this.setState(AuthState.AUTHENTICATING);
    
    try {
      let result: AuthResult;
      
      if (authMethod === AuthMethod.API_KEY) {
        result = await this.authenticateWithApiKey();
      } else {
        result = await this.authenticateWithOAuth();
      }
      
      if (result.success && result.token) {
        this.currentToken = result.token;
        await this.tokenStorage.saveToken(this.tokenKey, result.token);
        this.setState(AuthState.AUTHENTICATED);
        this.emit(AUTH_EVENTS.LOGGED_IN, { method: authMethod });
        
        // Set up auto-refresh if enabled
        if (this.config.autoRefresh && result.token.refreshToken) {
          this.scheduleTokenRefresh();
        }
      } else {
        this.setState(AuthState.FAILED);
        this.emit(AUTH_EVENTS.ERROR, result.error);
      }
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Authentication failed: ${errorMessage}`);
      
      this.setState(AuthState.FAILED);
      this.emit(AUTH_EVENTS.ERROR, error);
      
      return {
        success: false,
        error: errorMessage,
        state: AuthState.FAILED
      };
    }
  }

  /**
   * Log out the current user
   */
  async logout(): Promise<void> {
    logger.info('Logging out user');
    
    // Clear token refresh timer
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    
    // Clear token from storage
    try {
      await this.tokenStorage.deleteToken(this.tokenKey);
    } catch (error) {
      logger.warn('Error clearing token from storage', error);
    }
    
    // Reset state
    this.currentToken = null;
    this.setState(AuthState.INITIAL);
    this.emit(AUTH_EVENTS.LOGGED_OUT);
  }

  /**
   * Authenticate using API key
   */
  private async authenticateWithApiKey(): Promise<AuthResult> {
    const apiKey = this.config.apiKey;
    
    if (!apiKey) {
      return {
        success: false,
        error: 'No API key available',
        state: AuthState.FAILED
      };
    }
    
    // Create a token with the API key
    // The token doesn't expire and has no refresh token
    const token: AuthToken = {
      accessToken: apiKey,
      expiresAt: Number.MAX_SAFE_INTEGER, // Never expires
      tokenType: 'Bearer',
      scope: 'all'
    };
    
    return {
      success: true,
      method: AuthMethod.API_KEY,
      token,
      state: AuthState.AUTHENTICATED
    };
  }

  /**
   * Authenticate using OAuth flow
   */
  private async authenticateWithOAuth(): Promise<AuthResult> {
    return performOAuthFlow(this.config.oauth);
  }

  /**
   * Refresh the current token
   */
  private async refreshToken(): Promise<void> {
    if (!this.currentToken || !this.currentToken.refreshToken) {
      throw new Error('No refresh token available');
    }
    
    this.setState(AuthState.REFRESHING);
    logger.debug('Refreshing authentication token');
    
    try {
      const newToken = await refreshOAuthToken(this.currentToken.refreshToken, this.config.oauth);
      
      // Update the current token
      this.currentToken = newToken;
      await this.tokenStorage.saveToken(this.tokenKey, newToken);
      
      this.setState(AuthState.AUTHENTICATED);
      this.emit(AUTH_EVENTS.TOKEN_REFRESHED);
      
      // Schedule the next refresh
      if (this.config.autoRefresh) {
        this.scheduleTokenRefresh();
      }
    } catch (error) {
      logger.error('Failed to refresh token', error);
      
      // If we can't refresh the token, we need to re-authenticate
      this.setState(AuthState.FAILED);
      this.emit(AUTH_EVENTS.ERROR, error);
      
      throw error;
    }
  }

  /**
   * Schedule a token refresh
   */
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    
    if (!this.currentToken || !this.currentToken.refreshToken) {
      return;
    }
    
    // Calculate when to refresh the token
    // Refresh when the token is at 80% of its lifetime
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = this.currentToken.expiresAt - now;
    const refreshIn = Math.max(0, expiresIn - this.config.tokenRefreshThreshold);
    
    logger.debug(`Scheduling token refresh in ${refreshIn} seconds`);
    
    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch(error => {
        logger.error('Scheduled token refresh failed', error);
      });
    }, refreshIn * 1000);
    
    // Make sure the timer doesn't prevent Node.js from exiting
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  /**
   * Update the authentication state
   */
  private setState(newState: AuthState): void {
    if (this.state !== newState) {
      logger.debug(`Authentication state changed: ${AuthState[this.state]} → ${AuthState[newState]}`);
      this.state = newState;
      this.emit(AUTH_EVENTS.STATE_CHANGED, newState);
    }
  }
} 