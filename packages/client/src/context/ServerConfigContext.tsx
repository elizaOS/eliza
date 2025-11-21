import { createContext, useContext, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import clientLogger from '@/lib/logger';

interface ServerConfig {
  requiresAuth: boolean;
}

interface ServerConfigContextType {
  config: ServerConfig | null;
  isLoading: boolean;
  requiresAuth: boolean; // Convenience accessor
}

const ServerConfigContext = createContext<ServerConfigContextType | undefined>(undefined);

export const ServerConfigProvider = ({ children }: { children: ReactNode }) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['server-config'],
    queryFn: async () => {
      const response = await fetch('/api/system/config');
      if (!response.ok) {
        throw new Error(`Failed to fetch server config: ${response.status}`);
      }
      const result = await response.json();
      clientLogger.info('[ServerConfig] Server configuration loaded:', result.data);
      return result.data as ServerConfig;
    },
    staleTime: Infinity, // Config doesn't change during session
    gcTime: Infinity, // Keep in cache forever (renamed from cacheTime in v5)
    retry: 3, // Retry 3 times on network errors
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
  });

  // Default to safe mode (requireAuth: true) on error
  if (error) {
    clientLogger.error('[ServerConfig] Failed to load server config, defaulting to safe mode:', error);
  }

  const config = data ?? { requiresAuth: true }; // Default to safe mode
  const requiresAuth = config.requiresAuth;

  return (
    <ServerConfigContext.Provider value={{ config, isLoading, requiresAuth }}>
      {children}
    </ServerConfigContext.Provider>
  );
};

export const useServerConfig = () => {
  const context = useContext(ServerConfigContext);
  if (context === undefined) {
    throw new Error('useServerConfig must be used within a ServerConfigProvider');
  }
  return context;
};
