import { cn } from '@/lib/utils';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '../context/AuthContext';
import { useConnection } from '../context/ConnectionContext';

export interface ConnectionStatusProps {
  // Allow standard HTML attributes like className
  [key: string]: any;
}

export default function ConnectionStatus() {
  const { toast } = useToast();
  const [prevStatus, setPrevStatus] = useState<string | null>(null);
  const { openApiKeyDialog } = useAuth();
  const { status, error } = useConnection();

  // Derive states from context
  const isLoading = status === 'loading';
  const isConnected = status === 'connected';
  const isError = status === 'error';
  const isUnauthorized = status === 'unauthorized'; // Context handles this now
  const showingError = isError || isUnauthorized;

  // Track connection state changes and show appropriate toast notifications
  useEffect(() => {
    // Transition from disconnected/error/unauthorized to connected
    if (
      (prevStatus === 'error' || prevStatus === 'unauthorized' || prevStatus === 'disconnected') &&
      isConnected
    ) {
      toast({
        title: 'Connection Restored',
        description: (
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>Successfully reconnected to the Eliza server.</span>
          </div>
        ),
      });
    } else if (prevStatus === 'connected' && (isError || isUnauthorized)) {
      // Transition from connected to error/unauthorized
      toast({
        title: 'Connection Lost',
        description: 'Attempting to reconnect to the Eliza server...',
        variant: 'destructive',
      });
    }

    // Update the connection state tracking for the next render
    setPrevStatus(status);
  }, [status, prevStatus, isConnected, isError, isUnauthorized, toast]);

  useEffect(() => {
    // If the status becomes unauthorized, trigger the API key dialog
    if (isUnauthorized && prevStatus !== 'unauthorized') {
      openApiKeyDialog(); // Trigger the global dialog
    }
  }, [isUnauthorized, prevStatus, openApiKeyDialog]);

  const getStatusColor = () => {
    if (isUnauthorized) return 'bg-yellow-500';
    if (isLoading) return 'bg-muted-foreground';
    return isConnected ? 'bg-green-600' : 'bg-red-600'; // Treat error/disconnected as red
  };

  const getStatusText = () => {
    if (isUnauthorized) return 'Unauthorized';
    if (isLoading) return 'Connecting...';
    return isConnected ? 'Connected' : 'Disconnected';
  };

  const getTextColor = () => {
    if (isUnauthorized) return 'text-yellow-500';
    if (isLoading) return 'text-muted-foreground';
    return isConnected ? 'text-green-600' : 'text-red-600';
  };

  // Get a specific error message based on the error
  const getErrorMessage = () => {
    if (!error) return 'Connection failed'; // Use error from context

    // Specific check for Unauthorized first
    if (isUnauthorized) {
      return 'Unauthorized: Invalid or missing API Key. Check client configuration or server logs.';
    }

    // The context already provides the error message string
    if (error.includes('NetworkError') || error.includes('Failed to fetch')) {
      return 'Cannot reach server';
    } else if (error.includes('ECONNREFUSED')) {
      return 'Connection refused';
    } else if (error.includes('timeout')) {
      return 'Connection timeout';
    } else if (
      error.includes('404') ||
      error.includes('not found') ||
      error.includes('API endpoint not found')
    ) {
      return 'Endpoint not found';
    }
    return error; // Return the error message directly
  };

  return (
    <SidebarMenuItem data-testid="connection-status">
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton className="rounded">
            <div className="flex flex-col gap-1 select-none">
              <div className="flex items-center gap-1">
                {showingError || isUnauthorized ? (
                  // Use AlertCircle for both general errors and unauthorized, but color differently
                  <AlertCircle
                    className={cn(
                      'h-3.5 w-3.5',
                      isUnauthorized ? 'text-yellow-500' : 'text-red-600'
                    )}
                  />
                ) : (
                  <div className={cn(['h-2.5 w-2.5 rounded-full', getStatusColor()])} />
                )}
                <span className={cn('text-xs', getTextColor())}>{getStatusText()}</span>
              </div>
            </div>
          </SidebarMenuButton>
        </TooltipTrigger>
        {showingError && (
          <TooltipContent side="top" align="center" className="max-w-xs">
            <div className="flex flex-col gap-2">
              <div
                className={cn('font-semibold', isUnauthorized ? 'text-yellow-500' : 'text-red-500')}
              >
                {getErrorMessage()}
              </div>
              <p className="text-xs">Please ensure the Eliza server is running and accessible.</p>
              {!isUnauthorized && (
                <p className="text-xs">Try refreshing the connection or check server logs.</p>
              )}
              {isUnauthorized && (
                <p className="text-xs">
                  Check the X-API-KEY configured in your client or the ELIZA_SERVER_AUTH_TOKEN on
                  the server.
                </p>
              )}
            </div>
          </TooltipContent>
        )}
      </Tooltip>
    </SidebarMenuItem>
  );
}
