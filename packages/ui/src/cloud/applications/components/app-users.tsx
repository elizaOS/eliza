/**
 * Application detail — Users tab (authenticated users + anonymous visitors).
 * Both GETs are routed through the typed `api` client.
 */

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
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { EmptyState } from "../../../components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

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

interface UsersResponse {
  success?: boolean;
  users?: AppUserDisplay[];
}

interface VisitorsResponse {
  success?: boolean;
  visitors?: Visitor[];
}

interface AppUsersProps {
  appId: string;
}

export function AppUsers({ appId }: AppUsersProps) {
  const t = useCloudT();
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<AppUserDisplay[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [usersData, visitorsData] = await Promise.all([
        api<UsersResponse>(`/api/v1/apps/${appId}/users?limit=50`),
        api<VisitorsResponse>(
          `/api/v1/apps/${appId}/analytics/requests?view=visitors&limit=50`,
        ),
      ]);

      if (usersData.success && usersData.users) {
        setUsers(usersData.users);
      }
      if (visitorsData.success && visitorsData.visitors) {
        setVisitors(visitorsData.visitors);
      }
    } catch {
      toast.error(
        t("cloud.appUsers.loadFailed", {
          defaultValue: "Failed to load app users",
        }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [appId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-8 animate-spin text-accent" />
      </div>
    );
  }

  const hasUsers = users.length > 0;
  const hasVisitors = visitors.length > 0;

  if (!hasUsers && !hasVisitors) {
    return (
      <EmptyState
        variant="dashed"
        icon={<UsersIcon className="size-6" />}
        title={t("cloud.appUsers.emptyTitle", { defaultValue: "No users yet" })}
        description={t("cloud.appUsers.emptyDescription", {
          defaultValue: "Users will appear here once they start using your app",
        })}
      />
    );
  }

  return (
    <div className="space-y-4">
      {hasUsers && (
        <Card stack="default" variant="outlinedPadded">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium text-txt">
              <UsersIcon className="size-4 text-accent" />
              {t("cloud.appUsers.authenticatedUsers", {
                count: users.length,
                defaultValue: "Authenticated Users ({{count}})",
              })}
            </h3>
          </div>

          <div className="space-y-2">
            {users.map((appUser) => (
              <div
                key={appUser.id}
                className="flex items-center justify-between rounded-sm bg-bg-accent p-3 transition-all hover:bg-bg-hover"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Avatar className="size-8">
                    <AvatarFallback className="bg-accent text-accent-fg text-xs">
                      {appUser.user_id.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-txt">
                      {t("cloud.appUsers.userLabel", {
                        id: appUser.user_id.substring(0, 8),
                        defaultValue: "User {{id}}",
                      })}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-muted">
                      <span className="flex items-center gap-1">
                        <Activity className="size-3" />
                        {appUser.total_requests}
                      </span>
                      <span className="flex items-center gap-1">
                        <DollarSign className="size-3" />$
                        {parseFloat(appUser.total_credits_used).toFixed(2)}
                      </span>
                    </div>
                  </div>

                  <div className="text-right hidden lg:block">
                    <p className="text-xs text-muted">
                      {t("cloud.appUsers.firstSeen", {
                        time: formatDistanceToNow(
                          new Date(appUser.first_seen_at),
                          { addSuffix: true },
                        ),
                        defaultValue: "First seen {{time}}",
                      })}
                    </p>
                    <p className="mt-0.5 text-2xs text-muted">
                      {t("cloud.appUsers.lastSeen", {
                        time: formatDistanceToNow(
                          new Date(appUser.last_seen_at),
                          { addSuffix: true },
                        ),
                        defaultValue: "Last seen {{time}}",
                      })}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {hasVisitors && (
        <Card stack="default" variant="outlinedPadded">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-medium text-txt">
              <Globe className="size-4 text-accent" />
              {t("cloud.appUsers.visitors", {
                count: visitors.length,
                defaultValue: "Visitors ({{count}})",
              })}
            </h3>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => fetchData()}
              disabled={isLoading}
            >
              <RefreshCw
                className={`size-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border">
                  <TableHead className="px-3 py-2 text-left text-xs font-medium text-muted">
                    {t("cloud.appUsers.ipAddress", {
                      defaultValue: "IP Address",
                    })}
                  </TableHead>
                  <TableHead className="px-3 py-2 text-right text-xs font-medium text-muted">
                    {t("cloud.appUsers.requests", {
                      defaultValue: "Requests",
                    })}
                  </TableHead>
                  <TableHead className="px-3 py-2 text-right text-xs font-medium text-muted">
                    {t("cloud.appUsers.lastSeenHeader", {
                      defaultValue: "Last Seen",
                    })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visitors.map((visitor, index) => (
                  <TableRow
                    key={visitor.ip}
                    className="border-b border-border/60 hover:bg-bg-hover"
                  >
                    <TableCell className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        <div className="flex size-6 items-center justify-center rounded-full bg-bg-accent">
                          <span className="text-2xs text-muted">
                            {index + 1}
                          </span>
                        </div>
                        <code className="font-mono text-xs text-txt">
                          {visitor.ip}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs font-medium text-txt tabular-nums">
                      {visitor.requestCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs text-muted">
                      {formatDistanceToNow(new Date(visitor.lastSeen), {
                        addSuffix: true,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
