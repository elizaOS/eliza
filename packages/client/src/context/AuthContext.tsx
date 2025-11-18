import { createContext, useState, useContext, ReactNode, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ApiKeyDialog } from '@/components/api-key-dialog';
import { AuthDialog } from '@/components/auth-dialog';
import SocketIOManager from '@/lib/socketio-manager';
import clientLogger from '@/lib/logger';
import { updateApiClientJwtToken } from '@/lib/api-client-config';
import { useServerConfig } from './ServerConfigContext';

interface AuthContextType {
  openApiKeyDialog: () => void;
  openAuthDialog: () => void;
  requireAuth: () => void; // Open dialog when server requires authentication
  logout: () => void;
  jwtToken: string | null;
  isAuthenticated: boolean;
  setJwtToken: (token: string | null) => void;
  getJwtToken: () => string | null;
  getApiKey: () => string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Helper functions for localStorage keys (same pattern as api-key-dialog.tsx)
const getLocalStorageJwtKey = () =>
  typeof window === 'undefined' ? 'eliza-jwt-token' : `eliza-jwt-token-${window.location.origin}`;

const getLocalStorageApiKey = () =>
  typeof window === 'undefined' ? 'eliza-api-key' : `eliza-api-key-${window.location.origin}`;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { requiresAuth } = useServerConfig();
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [jwtToken, setJwtTokenState] = useState<string | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(true); // Track initial load

  // Load JWT token from localStorage on mount
  useEffect(() => {
    try {
      const storedJwtToken = localStorage.getItem(getLocalStorageJwtKey());
      if (storedJwtToken) {
        setJwtTokenState(storedJwtToken);
        // Initialize API client with stored JWT token
        updateApiClientJwtToken(storedJwtToken);
        clientLogger.debug('[Auth] JWT token loaded from localStorage');
      } else {
        // No JWT token found - but don't force login
        // Let the app work without authentication if server allows it
        clientLogger.info('[Auth] No JWT token found - auth is optional until server requires it');
      }
    } catch (err) {
      clientLogger.error('[Auth] Unable to access localStorage for JWT token', err);
    } finally {
      setIsLoadingToken(false); // Mark loading complete
    }
  }, []);

  const setJwtToken = useCallback((token: string | null) => {
    try {
      if (token) {
        localStorage.setItem(getLocalStorageJwtKey(), token);
        setJwtTokenState(token);
        clientLogger.info('[Auth] JWT token stored');
      } else {
        localStorage.removeItem(getLocalStorageJwtKey());
        setJwtTokenState(null);
        clientLogger.info('[Auth] JWT token cleared');
      }

      // Update API client to use new JWT token
      updateApiClientJwtToken(token);

      // Invalidate all queries to refetch with new token
      queryClient.invalidateQueries();
      clientLogger.info('[Auth] All queries invalidated after token change');

      // Handle socket connection based on token change
      if (SocketIOManager.isConnected()) {
        const socketManager = SocketIOManager.getInstance();
        if (!token) {
          // Logout - gracefully disconnect and destroy singleton
          clientLogger.info('[Auth] Logging out - destroying socket instance');
          socketManager.logout();
        } else {
          // Token update - disconnect to force reconnection with new token
          clientLogger.info('[Auth] Token updated - disconnecting to reconnect with new token');
          socketManager.disconnect();
        }
      }
      // Note: After logout, the socket singleton is destroyed.
      // It will be automatically re-initialized by use-socket-chat when navigating to a chat page.
    } catch (err) {
      clientLogger.error('[Auth] Unable to save JWT token to localStorage', err);
    }
  }, [queryClient]);

  const getJwtToken = useCallback(() => {
    try {
      return localStorage.getItem(getLocalStorageJwtKey());
    } catch (err) {
      clientLogger.error('[Auth] Unable to read JWT token from localStorage', err);
      return null;
    }
  }, []);

  const getApiKey = useCallback(() => {
    try {
      return localStorage.getItem(getLocalStorageApiKey());
    } catch (err) {
      clientLogger.error('[Auth] Unable to read API key from localStorage', err);
      return null;
    }
  }, []);

  const openApiKeyDialog = useCallback(() => {
    setIsApiKeyDialogOpen(true);
  }, []);

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const requireAuth = useCallback(() => {
    // Called when server requires authentication (401, JWT errors)
    clientLogger.info('[Auth] Server requires authentication - opening auth dialog');
    setIsAuthDialogOpen(true);
  }, []);

  const logout = useCallback(() => {
    setJwtToken(null);
    clientLogger.info('[Auth] User logged out');

    // Invalidate all queries to clear cached data
    queryClient.invalidateQueries();

    // Navigate to home page to prevent API calls from other routes
    navigate('/');
    clientLogger.info('[Auth] Redirected to home page');

    // Don't force auth dialog - let it be optional
    // Dialog will open automatically if server requires authentication
  }, [setJwtToken, queryClient, navigate]);

  const handleAuthDialogOpenChange = useCallback((open: boolean) => {
    // Always allow changing the dialog state
    // If user closes it but isn't authenticated, useEffect will reopen it
    setIsAuthDialogOpen(open);
  }, []);

  const isAuthenticated = !!jwtToken;

  // Auto-open dialog if auth is required but user is not authenticated
  useEffect(() => {
    // Wait for token to load before checking authentication status
    if (!isLoadingToken && requiresAuth && !isAuthenticated && !isAuthDialogOpen) {
      clientLogger.info('[Auth] Auth required but not authenticated - opening dialog');
      setIsAuthDialogOpen(true);
    }
  }, [isLoadingToken, requiresAuth, isAuthenticated, isAuthDialogOpen]);

  const handleApiKeySaved = useCallback(() => {
    setIsApiKeyDialogOpen(false);
    clientLogger.info('API key saved via dialog, invalidating ping query.');
    queryClient.invalidateQueries({ queryKey: ['ping'] });
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ openApiKeyDialog, openAuthDialog, requireAuth, logout, jwtToken, isAuthenticated, setJwtToken, getJwtToken, getApiKey }}>
      {children}
      <ApiKeyDialog
        open={isApiKeyDialogOpen}
        onOpenChange={setIsApiKeyDialogOpen}
        onApiKeySaved={handleApiKeySaved}
      />
      {/* Only show auth dialog if server requires authentication */}
      {requiresAuth && (
        <AuthDialog
          open={isAuthDialogOpen}
          onOpenChange={handleAuthDialogOpenChange}
          closeable={false} // Dialog cannot be closed when auth is required
        />
      )}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
