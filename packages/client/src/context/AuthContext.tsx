import { createContext, useState, useContext, ReactNode, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiKeyDialog } from '@/components/api-key-dialog';
import clientLogger from '@/lib/logger';

interface AuthContextType {
  openApiKeyDialog: () => void;
  getApiKey: () => string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const getLocalStorageApiKey = () =>
  typeof window === 'undefined' ? 'eliza-api-key' : `eliza-api-key-${window.location.origin}`;

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const queryClient = useQueryClient();
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);

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
    <AuthContext.Provider value={{ openApiKeyDialog, getApiKey }}>
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
