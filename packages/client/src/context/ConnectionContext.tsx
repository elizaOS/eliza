import { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import clientLogger from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { STALE_TIMES } from '@/hooks/use-query-hooks';

export type ConnectionStatusType = 'loading' | 'connected' | 'error' | 'unauthorized';

interface ConnectionContextType {
  status: ConnectionStatusType;
  error: string | null;
  refetch: () => void;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

export const ConnectionProvider = ({ children }: { children: ReactNode }) => {
  const { toast } = useToast();
  const [wasConnected, setWasConnected] = useState(false);
  const [wasDisconnected, setWasDisconnected] = useState(false);
  const [status, setStatus] = useState<ConnectionStatusType>('loading');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['ping'],
    queryFn: () => apiClient.ping(),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message.includes('Unauthorized')) {
        return false;
      }
      return failureCount < 3;
    },
    staleTime: STALE_TIMES.FREQUENT,
    gcTime: STALE_TIMES.NEVER,
    throwOnError: false,
  });

  // Update status and error based on query results
  useEffect(() => {
    let newStatus: ConnectionStatusType = 'loading';
    let newError: string | null = null;

    if (query.isLoading) {
      newStatus = 'loading';
    } else if (query.isSuccess) {
      newStatus = 'connected';
      newError = null;
    } else if (query.isError) {
      if (query.error instanceof Error) {
        newError = query.error.message;
        if (newError.includes('Unauthorized') || newError.includes('401')) {
          newStatus = 'unauthorized';
        } else {
          newStatus = 'error';
        }
      } else {
        clientLogger.error('Ping query failed with non-Error type:', query.error);
        newError = 'An unknown connection error occurred.';
        newStatus = 'error';
      }
    }

    setStatus(newStatus);
    setError(newError);
  }, [query.status, query.error, query.isLoading, query.isSuccess, query.isError]);

  // Effects for toast notifications
  useEffect(() => {
    if (query.isSuccess && !wasConnected) {
      setWasConnected(true);
      setWasDisconnected(false);
      if (wasDisconnected) {
        toast({
          title: 'Connection Restored',
          description: 'Successfully reconnected to the Eliza server.',
        });
      }
      clientLogger.info('Successfully connected to Eliza server.');
    } else if (query.isError && !wasDisconnected) {
      setWasDisconnected(true);
      setWasConnected(false);
      if (wasConnected) {
        toast({
          title: 'Connection Lost',
          description: 'Attempting to reconnect to the Eliza server...',
          variant: 'destructive',
        });
      }
      const logErrorMessage =
        query.error instanceof Error ? query.error.message : String(query.error);
      clientLogger.error(`Connection to Eliza server failed: ${logErrorMessage}`);
    }
  }, [query.isSuccess, query.isError, wasConnected, wasDisconnected, toast, query.error]);

  useEffect(() => {
    if (query.isError && query.error && !wasDisconnected) {
      const errorMessage = query.error instanceof Error ? query.error.message : String(query.error);
      clientLogger.error(`Connection failure detected: ${errorMessage}`);
    } else if (!wasDisconnected && !query.isSuccess) {
      if (wasConnected) {
        clientLogger.warn('Connection to Eliza server lost (status unknown).');
      }
    }
  }, [query.isError, query.error, query.isSuccess, wasConnected, wasDisconnected]);

  const refetch = () => {
    queryClient.invalidateQueries({ queryKey: ['ping'] });
  };

  return (
    <ConnectionContext.Provider value={{ status, error, refetch }}>
      {children}
    </ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const context = useContext(ConnectionContext);
  if (context === undefined) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
};
