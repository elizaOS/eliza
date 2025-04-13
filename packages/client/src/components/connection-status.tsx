import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, RefreshCw, CheckCircle } from 'lucide-react';
import { useState, useEffect } from 'react';
import { SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useToast } from '@/hooks/use-toast';

export interface ConnectionStatusProps {
  testEndpoint?: string; // Optional endpoint to test instead of ping
}

export default function ConnectionStatus({ testEndpoint }: ConnectionStatusProps) {
  const [isHovered, setIsHovered] = useState(false);
  const { toast } = useToast();
  const [wasConnected, setWasConnected] = useState(false);
  const [wasDisconnected, setWasDisconnected] = useState(false);

  const query = useQuery({
    queryKey: ['ping'],
    queryFn: async () => {
      if (testEndpoint) {
        return await apiClient.testEndpoint(testEndpoint);
      }
      return await apiClient.ping();
    },
    refetchInterval: 5000,
    retry: 2,
    staleTime: 5000,
  });

  const connected = query.isSuccess && !query.isError;
  const isLoading = query.isRefetching || query.isPending;
  const showingError = query.isError && !isLoading;

  // Track connection state changes and show appropriate toast notifications
  useEffect(() => {
    if (wasDisconnected && connected && !isLoading) {
      toast({
        title: 'Connection Restored',
        description: (
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span>Successfully reconnected to the Eliza server.</span>
          </div>
        ),
      });
    }

    // Update the connection state tracking for the next render
    setWasDisconnected(showingError);
    setWasConnected(connected);
  }, [connected, showingError, query.error, toast, isLoading, testEndpoint]);

  const getStatusColor = () => {
    if (isLoading) return 'bg-muted-foreground';
    return connected ? 'bg-green-600' : 'bg-red-600';
  };

  const getStatusText = () => {
    if (isLoading) return 'Connecting...';
    return connected ? 'Connected' : 'Disconnected';
  };

  const getTextColor = () => {
    if (isLoading) return 'text-muted-foreground';
    return connected ? 'text-green-600' : 'text-red-600';
  };

  const refreshStatus = () => {
    query.refetch();
  };

  // Get a specific error message based on the error
  const getErrorMessage = () => {
    if (!query.error) return 'Connection failed';

    const error = query.error;
    if (error instanceof Error) {
      if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
        return 'Cannot reach server';
      } else if (error.message.includes('ECONNREFUSED')) {
        return 'Connection refused';
      } else if (error.message.includes('timeout')) {
        return 'Connection timeout';
      } else if (
        error.message.includes('404') ||
        error.message.includes('not found') ||
        error.message.includes('API endpoint not found')
      ) {
        if (testEndpoint) {
          return `Endpoint not found: ${testEndpoint}`;
        }
        return 'Endpoint not found';
      }
      return error.message;
    }

    return 'Connection failed';
  };

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={refreshStatus}
          >
            <div className="flex flex-col gap-1 select-none">
              <div className="flex items-center gap-1">
                {isHovered ? (
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
                ) : showingError ? (
                  <AlertCircle className="h-3.5 w-3.5 text-red-600" />
                ) : (
                  <div className={cn(['h-2.5 w-2.5 rounded-full', getStatusColor()])} />
                )}
                <span
                  className={cn(['text-xs', isHovered ? 'text-muted-foreground' : getTextColor()])}
                >
                  {isHovered ? 'Refresh' : getStatusText()}
                </span>
              </div>
            </div>
          </SidebarMenuButton>
        </TooltipTrigger>
        {showingError && (
          <TooltipContent side="top" align="center" className="max-w-xs">
            <div className="flex flex-col gap-2">
              <div className="font-semibold text-red-500">{getErrorMessage()}</div>
              <p className="text-xs">Please ensure the Eliza server is running and accessible.</p>
              <p className="text-xs">Try refreshing the connection or check server logs.</p>
            </div>
          </TooltipContent>
        )}
      </Tooltip>
    </SidebarMenuItem>
  );
}
