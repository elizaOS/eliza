"use client";

import { Avatar, AvatarFallback, Button } from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import { Activity, DollarSign, Globe, Loader2, RefreshCw, Users as UsersIcon } from "lucide-react";
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
        fetch(`/api/v1/apps/${appId}/analytics/requests?view=visitors&limit=50`),
      ]);

      const [usersData, visitorsData] = await Promise.all([usersRes.json(), visitorsRes.json()]);

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
        <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
      </div>
    );
  }

  const hasUsers = users.length > 0;
  const hasVisitors = visitors.length > 0;

  if (!hasUsers && !hasVisitors) {
    return (
      <div className="bg-neutral-900 rounded-xl p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center mx-auto mb-3">
          <UsersIcon className="h-6 w-6 text-neutral-500" />
        </div>
        <h3 className="text-sm font-medium text-white mb-1">No users yet</h3>
        <p className="text-xs text-neutral-500">
          Users will appear here once they start using your app
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hasUsers && (
        <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white flex items-center gap-2">
              <UsersIcon className="h-4 w-4 text-[#FF5800]" />
              Authenticated Users ({users.length})
            </h3>
          </div>

          <div className="space-y-2">
            {users.map((appUser) => (
              <div
                key={appUser.id}
                className="flex items-center justify-between p-3 bg-black/30 hover:bg-black/40 rounded-lg border border-white/5 hover:border-white/10 transition-all"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-gradient-to-br from-[#FF5800] to-purple-600 text-white text-xs">
                      {appUser.user_id.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">
                      User {appUser.user_id.substring(0, 8)}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-neutral-500">
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
                    <p className="text-xs text-neutral-500">
                      First seen{" "}
                      {formatDistanceToNow(new Date(appUser.first_seen_at), {
                        addSuffix: true,
                      })}
                    </p>
                    <p className="text-[10px] text-neutral-600 mt-0.5">
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
        <div className="bg-neutral-900 rounded-xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-400" />
              Visitors ({visitors.length})
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchData()}
              disabled={isLoading}
              className="h-8 w-8 p-0"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left py-2 px-3 text-neutral-500 font-medium text-xs">
                    IP Address
                  </th>
                  <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                    Requests
                  </th>
                  <th className="text-right py-2 px-3 text-neutral-500 font-medium text-xs">
                    Last Seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {visitors.map((visitor, index) => (
                  <tr key={visitor.ip} className="border-b border-white/5 hover:bg-white/5">
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center w-6 h-6 rounded-full bg-white/5">
                          <span className="text-neutral-500 text-[10px]">{index + 1}</span>
                        </div>
                        <code className="text-white font-mono text-xs">{visitor.ip}</code>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right text-white text-xs font-medium">
                      {visitor.requestCount.toLocaleString()}
                    </td>
                    <td className="py-2 px-3 text-right text-neutral-500 text-xs">
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
