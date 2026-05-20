/**
 * Audit Logs tab component for viewing admin activity.
 *
 * Displays all admin actions with filtering by action type and admin.
 * Shows audit log details including previous/new values for changes.
 *
 * Features:
 * - Audit logs list display
 * - Action type filtering
 * - Resource type filtering
 * - Admin user filtering
 * - Pagination
 * - Action details view
 * - Loading states
 *
 * @returns Audit logs tab element
 */
'use client';

import { cn } from '@babylon/shared';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  ScrollText,
  Shield,
} from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

interface AuditLog {
  id: string;
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  admin: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  };
}

interface AuditLogsResponse {
  logs: AuditLog[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  filters: {
    actionTypes: string[];
    resourceTypes: string[];
  };
}

export function AuditLogsTab() {
  const [data, setData] = useState<AuditLogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, startRefresh] = useTransition();
  const [actionFilter, setActionFilter] = useState<string>('');
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const fetchLogs = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        const params = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
        });
        if (actionFilter) params.set('action', actionFilter);
        if (resourceTypeFilter) params.set('resourceType', resourceTypeFilter);

        const response = await fetch(apiUrl(`/api/admin/audit-logs?${params}`));
        if (!response.ok) {
          toast.error('Failed to load audit logs');
          setLoading(false);
          return;
        }
        const responseData = await response.json();
        setData(responseData);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic();
      }
    },
    [actionFilter, resourceTypeFilter, offset]
  );

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'BAN':
      case 'DELETE':
        return 'text-red-500 bg-red-500/10';
      case 'UNBAN':
      case 'CREATE':
        return 'text-green-500 bg-green-500/10';
      case 'MODIFY':
        return 'text-blue-500 bg-blue-500/10';
      case 'VIEW':
        return 'text-gray-500 bg-gray-500/10';
      case 'PROMOTE_ADMIN':
        return 'text-orange-500 bg-orange-500/10';
      case 'DEMOTE_ADMIN':
        return 'text-yellow-500 bg-yellow-500/10';
      default:
        return 'text-purple-500 bg-purple-500/10';
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-lg sm:text-xl">
            <ScrollText className="h-4 w-4 text-purple-500 sm:h-5 sm:w-5" />
            Audit Logs
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs sm:mt-1 sm:text-sm">
            Track all admin actions on the platform
          </p>
        </div>
        <button
          onClick={() => fetchLogs(true)}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded bg-muted px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-muted/80 disabled:opacity-50 sm:gap-2 sm:px-3 sm:py-2 sm:text-sm"
        >
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5 sm:h-4 sm:w-4',
              isRefreshing && 'animate-spin'
            )}
          />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <label className="text-muted-foreground text-sm">Action:</label>
          <select
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setOffset(0);
            }}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
          >
            <option value="">All Actions</option>
            {data?.filters.actionTypes.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-muted-foreground text-sm">Resource:</label>
          <select
            value={resourceTypeFilter}
            onChange={(e) => {
              setResourceTypeFilter(e.target.value);
              setOffset(0);
            }}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
          >
            <option value="">All Resources</option>
            {data?.filters.resourceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Logs List */}
      {!data || data.logs.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <ScrollText className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No audit logs found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.logs.map((log) => (
            <div
              key={log.id}
              className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/50 sm:p-4"
            >
              <div className="flex items-start gap-2 sm:gap-4">
                {/* Admin Avatar */}
                <div className="hidden sm:block">
                  <Avatar
                    src={log.admin.profileImageUrl || undefined}
                    alt={log.admin.displayName || 'Admin'}
                    size="sm"
                  />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  {/* Header */}
                  <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2 sm:mb-2">
                    <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                      <span className="font-medium text-sm sm:text-base">
                        {log.admin.displayName ||
                          log.admin.username ||
                          'Unknown Admin'}
                      </span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 font-medium text-[10px] sm:text-xs',
                          getActionColor(log.action)
                        )}
                      >
                        {log.action}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:text-xs">
                        {log.resourceType}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground sm:text-xs">
                      <Clock className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                      {formatDate(log.createdAt)}
                    </div>
                  </div>

                  {/* Resource Details */}
                  <div className="space-y-1 text-sm">
                    {log.resourceId && (
                      <div className="text-muted-foreground">
                        <span className="font-medium">Resource ID:</span>{' '}
                        <span className="font-mono">{log.resourceId}</span>
                      </div>
                    )}
                    {log.ipAddress && (
                      <div className="text-muted-foreground">
                        <span className="font-medium">IP:</span>{' '}
                        <span className="font-mono">{log.ipAddress}</span>
                      </div>
                    )}
                  </div>

                  {/* Value Changes */}
                  {(log.previousValue || log.newValue) && (
                    <div className="mt-2 rounded-lg bg-muted/50 p-3 font-mono text-xs">
                      {log.previousValue && (
                        <div className="mb-1">
                          <span className="text-red-500">- Previous:</span>{' '}
                          <span className="text-muted-foreground">
                            {JSON.stringify(log.previousValue, null, 2).slice(
                              0,
                              200
                            )}
                          </span>
                        </div>
                      )}
                      {log.newValue && (
                        <div>
                          <span className="text-green-500">+ New:</span>{' '}
                          <span className="text-muted-foreground">
                            {JSON.stringify(log.newValue, null, 2).slice(
                              0,
                              200
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Admin Badge */}
                <div className="flex-shrink-0">
                  <Shield className="h-5 w-5 text-orange-500" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs sm:text-sm">
            Showing {offset + 1} -{' '}
            {Math.min(offset + data.logs.length, offset + limit)}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs transition-colors hover:bg-muted/80 disabled:opacity-50 sm:px-3 sm:py-1.5 sm:text-sm"
            >
              <ChevronLeft className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Previous</span>
            </button>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={!data.pagination.hasMore}
              className="flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs transition-colors hover:bg-muted/80 disabled:opacity-50 sm:px-3 sm:py-1.5 sm:text-sm"
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRight className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
