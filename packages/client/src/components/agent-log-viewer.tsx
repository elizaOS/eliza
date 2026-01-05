import { Database, LoaderIcon, Search, Clock, Trash2, Filter, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useElizaAgents } from '../hooks/use-eliza';
import { getElizaClient } from '../lib/api-client-config';
import SocketIOManager, { type LogStreamData } from '../lib/socketio-manager';
import { useConfirmation } from '@/hooks/use-confirmation';
import ConfirmationDialog from './confirmation-dialog';

// Types
interface LogEntry {
  level: number;
  time: number;
  msg: string;
  agentId?: string;
  agentName?: string;
  roomId?: string;
  [key: string]: string | number | boolean | null | undefined;
}

interface LogResponse {
  logs: LogEntry[];
  count: number;
  total: number;
  level: string;
  levels: string[];
}

interface AgentLogViewerProps {
  agentName?: string;
  level?: string;
}

// Log level mappings
const LOG_LEVEL_NUMBERS = {
  10: 'TRACE',
  20: 'DEBUG',
  27: 'SUCCESS',
  28: 'PROGRESS',
  29: 'LOG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
} as const;

// Helper functions
function getLevelName(level: number): string {
  return LOG_LEVEL_NUMBERS[level as keyof typeof LOG_LEVEL_NUMBERS] || 'UNKNOWN';
}

function getLevelColor(level: number): string {
  if (level >= 50) return 'bg-red-600/80'; // ERROR/FATAL - more muted red
  if (level >= 40) return 'bg-amber-600/80'; // WARN - more muted amber
  if (level >= 27) return 'bg-emerald-600/80'; // SUCCESS - more muted green
  return 'bg-slate-500'; // INFO/DEBUG/TRACE - neutral gray instead of blue
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function generateLogChart(logs: LogEntry[]) {
  // Group logs by hour for the last 24 hours
  const now = Date.now();
  const hours = 24;
  const hourlyData: Record<string, { info: number; errors: number }> = {};

  // Initialize all hours
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = new Date(now - i * 60 * 60 * 1000);
    hourStart.setMinutes(0, 0, 0);
    const key = hourStart.toISOString();
    hourlyData[key] = { info: 0, errors: 0 };
  }

  // Count logs by hour - filter logs to last 24 hours only
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  logs.forEach((log) => {
    // Only count logs from the last 24 hours
    if (log.time >= twentyFourHoursAgo) {
      const logDate = new Date(log.time);
      logDate.setMinutes(0, 0, 0);
      const key = logDate.toISOString();

      if (hourlyData[key]) {
        if (log.level >= 50) {
          hourlyData[key].errors++;
        } else {
          hourlyData[key].info++;
        }
      }
    }
  });

  return Object.entries(hourlyData).map(([timestamp, counts]) => ({
    timestamp: new Date(timestamp),
    ...counts,
    total: counts.info + counts.errors,
  }));
}

function LogChart({ data }: { data: ReturnType<typeof generateLogChart> }) {
  const maxValue = Math.max(...data.map((d) => d.total), 1);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-slate-500"></div>
            <span className="text-sm text-muted-foreground">
              Info{' '}
              <span className="font-mono">
                {data.reduce((sum, d) => sum + d.info, 0).toLocaleString()}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-600/80"></div>
            <span className="text-sm text-muted-foreground">
              Errors{' '}
              <span className="font-mono">
                {data.reduce((sum, d) => sum + d.errors, 0).toLocaleString()}
              </span>
            </span>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {data[data.length - 1]?.timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          - (UTC-7)
        </div>
      </div>

      <div className="h-32 flex items-end gap-1 bg-muted/30 rounded p-4">
        {data.map((point, index) => {
          return (
            <div key={index} className="flex-1 flex flex-col justify-end">
              <div
                key={`${point.timestamp.getTime()}-info`}
                style={{ height: `${(point.info / maxValue) * 100}%` }}
                className="bg-slate-500 rounded-sm min-h-[2px] transition-all duration-200"
                title={`${point.timestamp.toLocaleTimeString()}: ${point.info} info logs`}
              />
              <div
                key={`${point.timestamp.getTime()}-errors`}
                style={{ height: `${(point.errors / maxValue) * 100}%` }}
                className="bg-red-600/80 rounded-sm min-h-[2px] transition-all duration-200"
                title={`${point.timestamp.toLocaleTimeString()}: ${point.errors} error logs`}
              />
            </div>
          );
        })}
      </div>

      <div className="flex justify-between text-xs text-muted-foreground mt-2">
        <span>
          {data[0]?.timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span>
          {data[data.length - 1]?.timestamp.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
          })}
        </span>
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="flex flex-col items-center gap-4">
        <LoaderIcon className="h-8 w-8 animate-spin text-muted-foreground" />
        <div className="text-center">
          <h3 className="font-medium">Loading Logs</h3>
          <p className="text-sm text-muted-foreground">Fetching system logs...</p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  selectedLevel,
  searchQuery,
}: {
  selectedLevel: string;
  searchQuery: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Database className="h-16 w-16 text-muted-foreground/30 mb-4" />
      <h3 className="text-lg font-medium mb-2">No Logs Found</h3>
      <p className="text-muted-foreground max-w-md">
        {searchQuery
          ? `No logs match "${searchQuery}". Try adjusting your search or filter.`
          : selectedLevel === 'all'
            ? 'No logs available. Logs will appear here as the system generates them.'
            : `No ${selectedLevel.toUpperCase()} logs found.`}
      </p>
    </div>
  );
}

export function AgentLogViewer({ agentName, level }: AgentLogViewerProps) {
  const [selectedLevel, setSelectedLevel] = useState(level || 'all');
  const [selectedAgentName, setSelectedAgentName] = useState(agentName || 'all');
  const [searchQuery, setSearchQuery] = useState('');
  const [timeRange, setTimeRange] = useState('7 days');
  const [isLive, setIsLive] = useState(true);
  const [isClearing, setIsClearing] = useState(false);
  const [wsLogs, setWsLogs] = useState<LogEntry[]>([]);
  const [useWebSocket, setUseWebSocket] = useState(false);
  const queryClient = useQueryClient();

  const { confirm, isOpen, onOpenChange, onConfirm, options } = useConfirmation();

  // Use real hooks from the existing codebase
  const {
    data: logResponse,
    isLoading,
    error,
    refetch,
  } = useQuery<LogResponse>({
    queryKey: ['logs', selectedLevel, selectedAgentName],
    queryFn: async () => {
      const elizaClient = getElizaClient();
      return await elizaClient.system.getGlobalLogs({
        level: selectedLevel === 'all' ? '' : selectedLevel,
        agentName: selectedAgentName === 'all' ? undefined : selectedAgentName,
      });
    },
    refetchInterval: isLive && !useWebSocket ? 5000 : false,
    staleTime: 1000,
    enabled: true, // Always enable the query
  });

  const { agents } = useElizaAgents();

  // WebSocket log streaming integration
  const handleLogStream = useCallback(
    (logEntry: LogStreamData) => {
      // Filter logs based on current filters
      const shouldInclude =
        (selectedLevel === 'all' ||
          getLevelName(logEntry.level).toLowerCase() === selectedLevel.toLowerCase()) &&
        (selectedAgentName === 'all' || logEntry.agentName === selectedAgentName);

      if (shouldInclude) {
        setWsLogs((prev) => {
          const newLogs = [logEntry, ...prev].slice(0, 1000); // Keep last 1000 logs
          return newLogs;
        });
      }
    },
    [selectedLevel, selectedAgentName]
  );

  // Setup WebSocket event listeners
  useEffect(() => {
    if (isLive && useWebSocket) {
      const socketManager = SocketIOManager.getInstance();

      // Subscribe to log stream
      socketManager.subscribeToLogStream().catch(console.error);

      // Listen for log events
      socketManager.on('logStream', handleLogStream);

      return () => {
        socketManager.off('logStream', handleLogStream);
        socketManager.unsubscribeFromLogStream().catch(console.error);
      };
    }
  }, [isLive, useWebSocket, handleLogStream]);

  // Toggle WebSocket usage when live mode changes
  useEffect(() => {
    if (isLive) {
      // When enabling live mode, try to start WebSocket. Fallback to polling if WebSocket fails
      if (SocketIOManager.isConnected()) {
        setUseWebSocket(true);
      } else {
        // WebSocket not available, continue with API polling
        setUseWebSocket(false);
      }
    } else {
      // When disabling live mode, stop WebSocket and clear WebSocket logs
      setUseWebSocket(false);
      setWsLogs([]);
    }
  }, [isLive]);

  // Update WebSocket filters when selectedAgentName or selectedLevel changes
  useEffect(() => {
    if (useWebSocket && isLive) {
      const socketManager = SocketIOManager.getInstance();
      socketManager
        .updateLogStreamFilters({
          agentName: selectedAgentName,
          level: selectedLevel,
        })
        .catch(console.error);
    }
  }, [selectedAgentName, selectedLevel, useWebSocket, isLive]);

  // Combine API logs and WebSocket logs
  const apiLogs = logResponse?.logs || [];

  // Smart fallback: If WebSocket has significantly fewer logs than API, use API logs
  // This handles cases where WebSocket streaming isn't working properly
  let combinedLogs;
  if (useWebSocket && isLive && wsLogs.length > 0) {
    // If WebSocket has logs, use them
    combinedLogs = wsLogs;
  } else {
    // Use API logs (either not using WebSocket, or WebSocket has no logs)
    combinedLogs = apiLogs;
  }

  // Sort logs by timestamp in descending order (newest first)
  const logs = combinedLogs.sort((a, b) => b.time - a.time);
  const levels = logResponse?.levels || [];
  const agentNames = agents?.map((agent) => agent.name) || [];

  // Filter and search logs
  const filteredLogs = logs.filter((log: LogEntry) => {
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const searchableText = [
        log.msg,
        log.agentName,
        log.roomId,
        getLevelName(log.level),
        ...Object.entries(log)
          .filter(([key]) => !Number.isNaN(Number(key)))
          .map(([_, value]) => String(value)),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return searchableText.includes(query);
    }
    return true;
  });

  const chartData = generateLogChart(filteredLogs);

  const handleClearLogs = () => {
    confirm(
      {
        title: 'Clear All Logs',
        description:
          'Are you sure you want to permanently delete all system logs? This action cannot be undone.',
        confirmText: 'Delete',
        variant: 'destructive',
      },
      async () => {
        try {
          setIsClearing(true);
          const elizaClient = getElizaClient();
          await elizaClient.system.deleteGlobalLogs();
          queryClient.invalidateQueries({ queryKey: ['logs'] });

          // Also clear WebSocket logs if in WebSocket mode
          if (useWebSocket) {
            setWsLogs([]);
          }
        } catch (error) {
          console.error('Failed to clear logs:', error);
        } finally {
          setIsClearing(false);
        }
      }
    );
  };

  const handleRefresh = () => {
    if (useWebSocket && isLive) {
      // In WebSocket mode, clear current logs and let them re-populate
      setWsLogs([]);
    } else if (refetch) {
      // In API mode, refetch from server
      refetch();
    }
  };

  // Loading state
  if (isLoading && logs.length === 0) {
    return (
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        <LoadingIndicator />
      </div>
    );
  }

  // Error state
  if (error) {
    const isEndpointNotFound =
      error.message?.includes('404') ||
      error.message?.includes('endpoint not found') ||
      error.message?.includes('Not Found');
    return (
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        <div className="flex items-center justify-center flex-1">
          <div className="text-center max-w-md">
            <Database className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="font-medium mb-2">
              {isEndpointNotFound ? 'Global Logs API Not Available' : 'Failed to Load Logs'}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {isEndpointNotFound
                ? 'The server does not have the global logs API endpoint configured. You can still view individual agent logs from the agent details pages.'
                : `There was an error loading the system logs: ${error.message}`}
            </p>
            {!isEndpointNotFound && (
              <Button variant="outline" size="sm" onClick={() => refetch?.()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-100px)] min-h-[400px] w-full">
        {/* Header Controls */}
        <div className="flex items-center gap-3 mb-6 px-4 pt-4 flex-none">
          {/* Filter dropdown */}
          <Select value={selectedLevel} onValueChange={setSelectedLevel}>
            <SelectTrigger className="w-32 h-9">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">ALL</SelectItem>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Search */}
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Full-text log search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-9"
            />
          </div>

          {/* Agent filter */}
          {agentNames && agentNames.length > 0 && !agentName && (
            <Select value={selectedAgentName} onValueChange={setSelectedAgentName}>
              <SelectTrigger className="w-40 h-9">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">ALL AGENTS</SelectItem>
                {agentNames?.map((name) => (
                  <SelectItem key={name} value={name!}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Time range */}
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-32 h-9">
              <Clock className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1 hour">1 hour</SelectItem>
              <SelectItem value="6 hours">6 hours</SelectItem>
              <SelectItem value="24 hours">24 hours</SelectItem>
              <SelectItem value="7 days">7 days</SelectItem>
              <SelectItem value="30 days">30 days</SelectItem>
            </SelectContent>
          </Select>

          {/* Refresh */}
          <Button variant="outline" size="sm" onClick={handleRefresh} className="h-9 w-9 p-0">
            <RefreshCw className="h-4 w-4" />
          </Button>

          {/* Live toggle */}
          <Button
            variant={isLive ? 'default' : 'outline'}
            size="sm"
            onClick={() => setIsLive(!isLive)}
            className="h-9 px-3"
            title={
              isLive
                ? useWebSocket
                  ? 'Live mode (WebSocket)'
                  : 'Live mode (Polling)'
                : 'Live mode disabled'
            }
          >
            <div
              className={`w-2 h-2 rounded-full mr-2 ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`}
            />
            Live
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden px-4 pb-4">
          {filteredLogs.length === 0 ? (
            <EmptyState selectedLevel={selectedLevel} searchQuery={searchQuery} />
          ) : (
            <div className="space-y-6">
              {/* Analytics Chart */}
              <LogChart data={chartData} />

              {/* Log Table */}
              <div className="border rounded-lg overflow-hidden">
                {/* Table Header */}
                <div className="bg-muted/50 border-b px-4 py-3">
                  <div className="grid grid-cols-[200px_1fr] gap-4">
                    <div className="text-sm font-medium text-muted-foreground">Timestamp</div>
                    <div className="text-sm font-medium text-muted-foreground">Message</div>
                  </div>
                </div>

                {/* Table Body */}
                <div className="divide-y max-h-[400px] overflow-y-auto">
                  {filteredLogs.slice(0, 100).map((log, index) => (
                    <div
                      key={`${log.time}-${log.msg}-${index}`}
                      className="grid grid-cols-[200px_1fr] gap-4 px-4 py-3 hover:bg-muted/30 transition-colors"
                    >
                      {/* Timestamp with level indicator */}
                      <div className="flex items-center gap-3">
                        <div className={`w-1 h-6 rounded-full ${getLevelColor(log.level)}`} />
                        <div className="text-sm font-mono text-muted-foreground">
                          {formatTimestamp(log.time)}
                        </div>
                      </div>

                      {/* Message */}
                      <div className="flex items-start gap-2 min-w-0">
                        <div className="font-mono text-sm leading-relaxed break-all">{log.msg}</div>
                        {log.agentName && (
                          <Badge variant="secondary" className="text-xs flex-shrink-0">
                            {log.agentName}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Show more indicator */}
                {filteredLogs.length > 100 && (
                  <div className="border-t bg-muted/30 px-4 py-3 text-center">
                    <span className="text-sm text-muted-foreground">
                      Showing first 100 of {filteredLogs.length.toLocaleString()} logs
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions Bar */}
        <div className="border-t bg-muted/30 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isLive && (
              <>
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Live updates enabled {useWebSocket ? '(streaming)' : '(polling)'}</span>
              </>
            )}
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleClearLogs}
            disabled={isClearing}
            className="h-8 px-3 text-xs"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            {isClearing ? 'Clearing...' : 'Clear All Logs'}
          </Button>
        </div>
      </div>

      <ConfirmationDialog
        open={isOpen}
        onOpenChange={onOpenChange}
        title={options?.title || ''}
        description={options?.description || ''}
        confirmText={options?.confirmText}
        cancelText={options?.cancelText}
        variant={options?.variant}
        onConfirm={onConfirm}
      />
    </>
  );
}
