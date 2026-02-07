/**
 * Top users table component displaying highest spending users.
 * Shows rank, user info, requests, cost, and tokens with last active timestamp.
 *
 * @param props - Top users table configuration
 * @param props.users - Array of user usage data
 */
import { formatDistanceToNowStrict } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AnalyticsData } from "@/lib/actions/analytics";

interface TopUsersTableProps {
  users: AnalyticsData["userBreakdown"];
}

const numberFormatter = new Intl.NumberFormat();

export function TopUsersTable({ users }: TopUsersTableProps) {
  const hasUsers = users.length > 0;

  return (
    <Card className="border-border/70 bg-background/60 shadow-sm">
      <CardHeader className="flex flex-col gap-2 p-6 pb-5">
        <CardTitle className="text-base font-semibold">Top users</CardTitle>
        <p className="text-sm text-muted-foreground">
          Highest spenders within the selected window ranked by total credits
          consumed.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {!hasUsers ? (
          <div className="px-6 py-14 text-center text-sm text-muted-foreground">
            No user activity for the current filters.
          </div>
        ) : (
          <div className="overflow-hidden px-2 pb-2">
            <div className="hidden border-b border-border/60 text-xs uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[auto_1fr_repeat(3,minmax(0,140px))]">
              <span className="px-6 py-3">Rank</span>
              <span className="px-6 py-3">User</span>
              <span className="px-6 py-3 text-right">Requests</span>
              <span className="px-6 py-3 text-right">Cost</span>
              <span className="px-6 py-3 text-right">Tokens</span>
            </div>
            <div className="divide-y divide-border/60">
              {users.map((user: (typeof users)[0], index: number) => {
                const totalTokens = user.inputTokens + user.outputTokens;
                const lastActiveLabel = user.lastActive
                  ? formatDistanceToNowStrict(new Date(user.lastActive), {
                      addSuffix: true,
                    })
                  : "No activity";

                return (
                  <div
                    key={user.userId}
                    className="grid grid-cols-1 gap-4 px-6 py-5 text-sm transition-colors hover:bg-muted/40 md:grid-cols-[auto_1fr_repeat(3,minmax(0,140px))] md:gap-0 md:py-4"
                  >
                    <div className="flex items-center md:justify-center">
                      <Badge
                        variant="outline"
                        className="min-w-[2.25rem] justify-center"
                      >
                        #{index + 1}
                      </Badge>
                    </div>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">
                        {user.userName || "Unknown"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {user.userEmail}
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground/80">
                        Last active {lastActiveLabel}
                      </span>
                    </div>
                    <div className="text-right font-mono tabular-nums md:self-center">
                      {numberFormatter.format(user.totalRequests)}
                    </div>
                    <div className="text-right font-mono tabular-nums md:self-center">
                      {numberFormatter.format(user.totalCost)}
                    </div>
                    <div className="text-right font-mono tabular-nums md:self-center">
                      {numberFormatter.format(totalTokens)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
