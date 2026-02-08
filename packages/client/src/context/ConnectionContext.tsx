import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { useToast } from '@/hooks/use-toast';
import SocketIOManager from '@/lib/socketio-manager';
import { updateApiClientApiKey } from '@/lib/api-client-config';
import { useAuth } from './AuthContext';
import { useServerConfig } from './ServerConfigContext';
import clientLogger from '@/lib/logger';
import { isJwtAuthError } from '@/lib/auth-utils';
// Eliza client refresh functionality removed (not needed with direct client)

export const connectionStatusActions = {
  setUnauthorized: (message: string) => {
    console.warn('setUnauthorized called before ConnectionContext is ready', message);
  },
  setOfflineStatus: (isOffline: boolean) => {
    console.warn('setOfflineStatus called before ConnectionContext is ready', isOffline);
  },
};

export type ConnectionStatusType =
  | 'loading'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'unauthorized';

interface ConnectionContextType {
  status: ConnectionStatusType;
  error: string | null;
  setUnauthorizedFromApi: (message: string) => void;
  setOfflineStatusFromProvider: (isOffline: boolean) => void;
  refreshApiClient: (newApiKey?: string | null) => void;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

export const ConnectionProvider = ({ children }: { children: ReactNode }) => {
  const { toast } = useToast();
  const { logout, requireAuth, isAuthenticated } = useAuth();
  const { requiresAuth } = useServerConfig();
  const [status, setStatus] = useState<ConnectionStatusType>('loading');
  const [error, setError] = useState<string | null>(null);
  const isFirstConnect = useRef(true);
  const isLoggingOut = useRef(false);

  const setUnauthorizedFromApi = useCallback(
    (message: string) => {
      setStatus('unauthorized');
      setError(message);
      toast({
        title: 'Authorization Required',
        description: message || 'Please provide a valid API Key.',
        variant: 'destructive',
      });
    },
    [toast]
  );

  const setOfflineStatusFromProvider = useCallback(
    (isOffline: boolean) => {
      if (isOffline) {
        if (status !== 'error' && status !== 'unauthorized') {
          setStatus('error');
          setError('Network connection appears to be offline.');
          toast({
            title: 'Network Offline',
            description: 'Please check your internet connection.',
            variant: 'destructive',
          });
        }
      } else {
        if (status === 'error' && error?.includes('offline')) {
        }
      }
    },
    [status, error, toast]
  );

  const refreshApiClient = useCallback((newApiKey?: string | null) => {
    try {
      // Update localStorage if a new API key is provided
      if (newApiKey !== undefined) {
        updateApiClientApiKey(newApiKey);
      }

      // Refresh the ElizaClient instance with new configuration
      // Client refresh not needed with direct client pattern

      console.log('API client refreshed with new configuration');
    } catch (error) {
      console.error('Failed to refresh API client:', error);
    }
  }, []);

  useEffect(() => {
    connectionStatusActions.setUnauthorized = setUnauthorizedFromApi;
    connectionStatusActions.setOfflineStatus = setOfflineStatusFromProvider;
  }, [setUnauthorizedFromApi, setOfflineStatusFromProvider]);

  // Reset unauthorized status when user logs in
  useEffect(() => {
    if (isAuthenticated && (status === 'unauthorized' || (status === 'error' && error?.includes('Authentication required')))) {
      clientLogger.info('[ConnectionContext] User authenticated - clearing unauthorized status');
      setStatus('loading'); // Will transition to 'connected' when socket reconnects
      setError(null);
    }
  }, [isAuthenticated, status, error]);

  useEffect(() => {
    const socketManager = SocketIOManager.getInstance();
    const onConnect = () => {
      setStatus('connected');
      setError(null);

      isLoggingOut.current = false;

      if (connectionStatusActions.setOfflineStatus) {
        connectionStatusActions.setOfflineStatus(false);
      }

      if (isFirstConnect.current) {
        isFirstConnect.current = false;
      } else {
        toast({
          title: 'Connection Restored',
          description: 'Successfully reconnected to the Eliza server.',
        });
      }
    };

    const onLogout = (reason: string) => {
      // Mark that we're logging out to suppress disconnect toast
      isLoggingOut.current = true;
      setStatus('loading'); // Reset to loading state during logout
      setError(null);
      clientLogger.info(`[ConnectionContext] Logout event received: ${reason}`);
      // No toast - logout is intentional
    };

    const onDisconnect = (reason: string) => {
      // Don't show error toast if this is an intentional logout
      if (isLoggingOut.current) {
        clientLogger.debug('[ConnectionContext] Ignoring disconnect toast - logout in progress');
        return;
      }

      // If server doesn't require auth, this is just a regular connection error
      if (!requiresAuth) {
        setStatus('error');
        setError(`Connection lost: ${reason}`);
        if (connectionStatusActions.setOfflineStatus) {
          connectionStatusActions.setOfflineStatus(true);
        }
        toast({
          title: 'Connection Lost',
          description: 'Attempting to reconnect to the Eliza server…',
          variant: 'destructive',
        });
        return;
      }

      // Server requires auth - check if this is an auth error
      if (isJwtAuthError(reason) && !isAuthenticated) {
        // Server requires JWT but user is not authenticated
        clientLogger.info('[ConnectionContext] Disconnect due to missing JWT - opening auth dialog');
        setStatus('unauthorized');
        setError('Authentication required');
        requireAuth();

        // Disconnect the socket so it can be recreated with a new JWT token after login
        clientLogger.info('[ConnectionContext] Disconnecting socket to allow reconnection with new JWT');
        socketManager.disconnect();
        return;
      }

      // Regular connection error even with auth enabled
      setStatus('error');
      setError(`Connection lost: ${reason}`);
      if (connectionStatusActions.setOfflineStatus) {
        connectionStatusActions.setOfflineStatus(true);
      }
      toast({
        title: 'Connection Lost',
        description: 'Attempting to reconnect to the Eliza server…',
        variant: 'destructive',
      });
    };

    const onReconnectAttempt = () => {
      setStatus('reconnecting');
      setError('Reconnecting...');
    };

    const onConnectError = (err: Error) => {
      // If server doesn't require auth, this is just a regular connection error
      if (!requiresAuth) {
        setStatus('error');
        setError(err.message);
        if (connectionStatusActions.setOfflineStatus) {
          connectionStatusActions.setOfflineStatus(true);
        }
        return;
      }

      // Server requires auth - check if this is a JWT authentication error
      if (isJwtAuthError(err.message)) {
        // Don't show error toast for JWT errors - open auth dialog instead
        clientLogger.info('[ConnectionContext] JWT authentication required by server');
        setStatus('unauthorized');
        setError('Authentication required');
        requireAuth();

        // Disconnect the socket so it can be recreated with a new JWT token after login
        clientLogger.info('[ConnectionContext] Disconnecting socket to allow reconnection with new JWT');
        socketManager.disconnect();
        return;
      }

      // Regular connection error (network, server down, etc.)
      setStatus('error');
      setError(err.message);
      if (connectionStatusActions.setOfflineStatus) {
        connectionStatusActions.setOfflineStatus(true);
      }
    };

    const onUnauthorized = (reason: string) => {
      setStatus('unauthorized');
      setError(`Unauthorized: ${reason}`);

      // Clear JWT token and force logout
      logout();

      toast({
        title: 'Session Expired',
        description: 'Your session has expired. Please log in again.',
        variant: 'destructive',
      });
    };

    socketManager.on('connect', onConnect);
    socketManager.on('logout', onLogout);
    socketManager.on('disconnect', onDisconnect);
    socketManager.on('reconnect', onConnect);
    socketManager.on('reconnect_attempt', onReconnectAttempt);
    socketManager.on('connect_error', onConnectError);
    socketManager.on('unauthorized', onUnauthorized);

    if (SocketIOManager.isConnected()) {
      onConnect();
    }

    return () => {
      socketManager.off('connect', onConnect);
      socketManager.off('logout', onLogout);
      socketManager.off('disconnect', onDisconnect);
      socketManager.off('reconnect', onConnect);
      socketManager.off('reconnect_attempt', onReconnectAttempt);
      socketManager.off('connect_error', onConnectError);
      socketManager.off('unauthorized', onUnauthorized);
    };
  }, [toast, setOfflineStatusFromProvider, logout, requireAuth, isAuthenticated, requiresAuth]);

  return (
    <ConnectionContext.Provider
      value={{
        status,
        error,
        setUnauthorizedFromApi,
        setOfflineStatusFromProvider,
        refreshApiClient,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnection must be inside ConnectionProvider');
  }
  return ctx;
};
