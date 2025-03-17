import { STALE_TIMES } from '@/hooks/use-query-hooks';
import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export default function ConnectionStatus() {
  const [queryTime, setQueryTime] = useState<number | null>(null);
  const [isTabVisible, setIsTabVisible] = useState<boolean>(true);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const queryClient = useQueryClient();

  // Keep track of the last refresh time to limit window focus refetches
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(Date.now());

  // Track consecutive failures to implement exponential backoff
  const failureCountRef = useRef(0);
  const lastSuccessRef = useRef<number>(Date.now());

  // Listen for tab visibility and network status changes
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(document.visibilityState === 'visible');

      // When tab becomes visible again, reset failure count to retry immediately
      if (document.visibilityState === 'visible') {
        failureCountRef.current = 0;

        // Force a refetch when tab becomes visible again if it's been a while
        const timeSinceLastRefresh = Date.now() - lastRefreshTime;
        if (timeSinceLastRefresh > 10000) {
          // 10 seconds
          queryClient.invalidateQueries({ queryKey: ['status'] });
        }
      }
    };

    const handleOnlineStatusChange = () => {
      setIsOnline(navigator.onLine);

      // When network comes back online, reset failure count
      if (navigator.onLine) {
        failureCountRef.current = 0;
        // Force a refetch when coming back online
        queryClient.invalidateQueries({ queryKey: ['status'] });
      }
    };

    // Add event listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnlineStatusChange);
    window.addEventListener('offline', handleOnlineStatusChange);

    // Initial check
    setIsTabVisible(document.visibilityState === 'visible');

    // Clean up listeners
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnlineStatusChange);
      window.removeEventListener('offline', handleOnlineStatusChange);
    };
  }, [queryClient, lastRefreshTime]);

  // Dynamic poll interval based on tab visibility, online status, and failure history
  const getPollInterval = () => {
    if (!isOnline) return false; // Don't poll when offline

    // If we've had consecutive failures, increase the polling interval exponentially
    if (failureCountRef.current > 0) {
      const backoffTime = Math.min(5000 * 2 ** (failureCountRef.current - 1), 60000);
      return backoffTime; // Up to 1 minute maximum backoff
    }

    // More frequent polling
    if (!isTabVisible) return 15000; // 15s when tab is not visible (reduced from 20s)
    return 3000; // 3s when tab is visible (reduced from 5s)
  };

  const query = useQuery({
    queryKey: ['status'],
    queryFn: async () => {
      try {
        const start = performance.now();
        const data = await apiClient.getAgents();
        const end = performance.now();

        // Reset failure count on success
        failureCountRef.current = 0;
        lastSuccessRef.current = Date.now();

        setQueryTime(end - start);
        setLastRefreshTime(Date.now());
        return data;
      } catch (error) {
        // Increment failure count on error
        failureCountRef.current += 1;
        console.error('Connection check failed:', error);
        throw error;
      }
    },
    refetchInterval: getPollInterval(),
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 1.5 ** attemptIndex, 10000),
    // Ensure we refetch when the window becomes focused to quickly update status
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Shorter stale time to ensure more frequent refresh
    staleTime: 500,
    // Increase cache time to prevent unnecessary refetches
    gcTime: STALE_TIMES.STANDARD,
  });

  const connected = query?.isSuccess && !query?.isError;
  const isLoading = query?.isRefetching || query?.isPending;

  // For long outages, show a different status
  const isLongOutage =
    connected === false &&
    failureCountRef.current > 5 &&
    Date.now() - lastSuccessRef.current > 60000; // 1 minute

  // Show the connection status color with the network status
  const getStatusColor = () => {
    if (!isOnline) return 'bg-orange-600'; // Orange for offline
    if (isLongOutage) return 'bg-yellow-600'; // Yellow for long-term issues
    if (isLoading) return 'bg-muted-foreground';
    return connected ? 'bg-green-600' : 'bg-red-600';
  };

  // Show the connection status text
  const getStatusText = () => {
    if (!isOnline) return 'Offline';
    if (isLongOutage) return 'Reconnecting...';
    if (isLoading) return 'Connecting...';
    return connected ? 'Connected' : 'Disconnected';
  };

  // Get the text color based on status
  const getTextColor = () => {
    if (!isOnline) return 'text-orange-600';
    if (isLongOutage) return 'text-yellow-600';
    if (isLoading) return 'text-muted-foreground';
    return connected ? 'text-green-600' : 'text-red-600';
  };

  // Function to refresh agents and status
  const refreshData = () => {
    // Reset failure tracking
    failureCountRef.current = 0;

    // Force refetch even if within stale time
    queryClient.invalidateQueries({ queryKey: ['agents'] });
    queryClient.invalidateQueries({ queryKey: ['status'] });
  };

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={refreshData}
          >
            <div className="flex flex-col gap-1 select-none transition-all duration-200">
              <div className="flex items-center gap-1">
                {isHovered ? (
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
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
        {connected && !isHovered ? (
          <TooltipContent side="top">
            <div className="flex items-center gap-1">
              <Activity className="size-4" />
              <span>{queryTime?.toFixed(2)} ms</span>
            </div>
          </TooltipContent>
        ) : null}
      </Tooltip>
    </SidebarMenuItem>
  );
}
