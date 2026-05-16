"use client";

import { Avatar, AvatarFallback, Button, EmptyState } from "@elizaos/ui";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  DollarSign,
  Globe,
  Loader2,
  RefreshCw,
  Users as UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface AppUserDisplay {
  id: string;
  user_id: string;
  total_requests: number;
  total_credits_used: string;
  first_seen_at: string;
  last_seen_at: string;
}

interface Visitor {
  ip: string;
  requestCount: number;
  lastSeen: string;
}

interface AppUsersProps {
  appId: string;
}

export function AppUsers({ appId }: AppUsersProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<AppUserDisplay[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [usersRes, visitorsRes] = await Promise.all([
        fetch(`/api/v1/apps/${appId}/users?limit=50`),
        fetch(
          `/api/v1/apps/${appId}/analytics/requests?view=visitors&limit=50`,
        ),
      ]);

      const [usersData, visitorsData] = await Promise.all([
        usersRes.json(),
        visitorsRes.json(),
      ]);

      if (usersData.success) {
        setUsers(usersData.users);
      }
      if (visitorsData.success) {
        setVisitors(visitorsData.visitors);
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setIsLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  const hasUsers = users.length > 0;
  const hasVisitors = visitors.length > 0;

  if (!hasUsers && !hasVisitors) {
    return (
      <EmptyState
        variant="dashed"
        icon={<UsersIcon className="h-6 w-6" />}
        title="No users yet"
        description="Users will appear here once they start using your app"
      />
    );
  }

  return (
    <div className="space-y-4">
      {hasUsers && (
        <div className="space-y-4 rounded-sm border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium text-txt">
              <UsersIcon className="h-4 w-4 text-accent" />
              Authenticated Users ({users.length})
            </h3>
          </div>

          <div className="space-y-2">
            {users.map((appUser) => (
              <div
                key={appUser.id}
                className="flex items-center justify-between rounded-lg border border-border bg-bg-accent p-3 transition-all hover:border-border-strong hover:bg-bg-hover"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-accent text-accent-fg text-xs">
                      {appUser.user_id.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-txt">
                      User {appUser.user_id.substring(0, 8)}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="flex items-center gap-1">
                        <Activity className="h-3 w-3" />
                        {appUser.total_requests}
                      </span>
                      <span className="flex items-center gap-1">
                        <DollarSign className="h-3 w-3" />$
                        {parseFloat(appUser.total_credits_used).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <div className="text-right hidden lg:block">
                    <p className="text-xs text-muted">
                      First seen{" "}
                      {formatDistanceToNow(new Date(appUser.first_seen_at), {
                        addSuffix: true,
                      })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted">
                      Last seen{" "}
                      {formatDistanceToNow(new Date(appUser.last_seen_at), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasVisitors && (
        <div className="space-y-4 rounded-sm border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium text-txt">
              <Globe className="h-4 w-4 text-accent" />
              Visitors ({visitors.length})
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchData()}
              disabled={isLoading}
              className="h-8 w-8 p-0"
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted">
                    IP Address
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted">
                    Requests
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-muted">
                    Last Seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {visitors.map((visitor, index) => (
                  <tr
                    key={visitor.ip}
                    className="border-b border-border/60 hover:bg-bg-hover"
                  >
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-bg-accent">
                          <span className="text-[10px] text-muted">
                            {index + 1}
                          </span>
                        </div>
                        <code className="font-mono text-xs text-txt">
                          {visitor.ip}
                        </code>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs font-medium text-txt">
                      {visitor.requestCount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted">
                      {formatDistanceToNow(new Date(visitor.lastSeen), {
                        addSuffix: true,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
