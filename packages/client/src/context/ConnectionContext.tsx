import { createContext, useContext, useState, ReactNode, useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import SocketIOManager from '@/lib/socketio-manager';

export type ConnectionStatusType =
  | 'loading'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'unauthorized';

interface ConnectionContextType {
  status: ConnectionStatusType;
  error: string | null;
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

export const ConnectionProvider = ({ children }: { children: ReactNode }) => {
  const { toast } = useToast();
  const [status, setStatus] = useState<ConnectionStatusType>('loading');
  const [error, setError] = useState<string | null>(null);
  const isFirstConnect = useRef(true);
  const socketManager = SocketIOManager.getInstance();

  useEffect(() => {
    const onConnect = () => {
      setStatus('connected');
      setError(null);

      if (isFirstConnect.current) {
        isFirstConnect.current = false;
      } else {
        toast({
          title: 'Connection Restored',
          description: 'Successfully reconnected to the Eliza server.',
        });
      }
    };

    const onDisconnect = (reason: string) => {
      setStatus('error');
      setError(`Connection lost: ${reason}`);

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
      setStatus('error');
      setError(err.message);
    };

    const onUnauthorized = (reason: string) => {
      setStatus('unauthorized');
      setError(`Unauthorized: ${reason}`);
      toast({ title: 'Unauthorized', description: 'Please log in again.', variant: 'destructive' });
    };

    socketManager.on('connect', onConnect);
    socketManager.on('disconnect', onDisconnect);
    socketManager.on('reconnect', onConnect);
    socketManager.on('reconnect_attempt', onReconnectAttempt);
    socketManager.on('connect_error', onConnectError);
    socketManager.on('unauthorized', onUnauthorized);

    // trigger initial connect state
    if (SocketIOManager.isConnected()) {
      onConnect();
    }

    return () => {
      socketManager.off('connect', onConnect);
      socketManager.off('disconnect', onDisconnect);
      socketManager.off('reconnect', onConnect);
      socketManager.off('reconnect_attempt', onReconnectAttempt);
      socketManager.off('connect_error', onConnectError);
      socketManager.off('unauthorized', onUnauthorized);
    };
  }, [toast]);

  return (
    <ConnectionContext.Provider value={{ status, error }}>{children}</ConnectionContext.Provider>
  );
};

export const useConnection = () => {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnection must be inside ConnectionProvider');
  }
  return ctx;
};
