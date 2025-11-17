import { createContext, useState, useContext, ReactNode, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiKeyDialog } from '@/components/api-key-dialog';
import clientLogger from '@/lib/logger';

interface AuthContextType {
  openApiKeyDialog: () => void;
  jwtToken: string | null;
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
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [jwtToken, setJwtTokenState] = useState<string | null>(null);

  // Load JWT token from localStorage on mount
  useEffect(() => {
    try {
      const storedJwtToken = localStorage.getItem(getLocalStorageJwtKey());
      if (storedJwtToken) {
        setJwtTokenState(storedJwtToken);
        clientLogger.debug('[Auth] JWT token loaded from localStorage');
      }
    } catch (err) {
      clientLogger.error('[Auth] Unable to access localStorage for JWT token', err);
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
    } catch (err) {
      clientLogger.error('[Auth] Unable to save JWT token to localStorage', err);
    }
  }, []);

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

  const handleApiKeySaved = useCallback(() => {
    setIsApiKeyDialogOpen(false);
    clientLogger.info('API key saved via dialog, invalidating ping query.');
    queryClient.invalidateQueries({ queryKey: ['ping'] });
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ openApiKeyDialog, jwtToken, setJwtToken, getJwtToken, getApiKey }}>
      {children}
      <ApiKeyDialog
        open={isApiKeyDialogOpen}
        onOpenChange={setIsApiKeyDialogOpen}
        onApiKeySaved={handleApiKeySaved}
      />
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
