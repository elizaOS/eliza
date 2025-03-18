import { apiClient } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { SidebarMenuButton, SidebarMenuItem } from './ui/sidebar';
import { Tooltip, TooltipTrigger } from './ui/tooltip';

export default function ConnectionStatus() {
  const [isHovered, setIsHovered] = useState(false);

  const query = useQuery({
    queryKey: ['ping'],
    queryFn: async () => {
      return await apiClient.ping();
    },
    refetchInterval: 5000,
    retry: 2,
    staleTime: 1000,
  });

  const connected = query.isSuccess && !query.isError;
  const isLoading = query.isRefetching || query.isPending;

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
      </Tooltip>
    </SidebarMenuItem>
  );
}
