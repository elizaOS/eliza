/**
 * Top users table component displaying highest spending users.
 * Shows rank, user info, requests, cost, and tokens with last active timestamp.
 *
 * @param props - Top users table configuration
 * @param props.users - Array of user usage data
 */

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@elizaos/cloud-ui";
import { formatDistanceToNowStrict } from "date-fns";
import type { AnalyticsDataDto } from "@/types/cloud-api";

interface TopUsersTableProps {
  users: AnalyticsDataDto["userBreakdown"];
}

const numberFormatter = new Intl.NumberFormat();

export function TopUsersTable({ users }: TopUsersTableProps) {
  const hasUsers = users.length > 0;

  return (
    <Card className="border-border/70 bg-background/60 shadow-sm">
      <CardHeader className="flex flex-col gap-2 p-6 pb-5">
        <CardTitle className="text-base font-semibold">Top users</CardTitle>
        <p className="text-sm text-muted-foreground">
          Highest spenders within the selected window ranked by total credits consumed.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {!hasUsers ? (
          <div className="px-6 py-14 text-center text-sm text-muted-foreground">
            No user activity for the current filters.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Rank</TableHead>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user: (typeof users)[0], index: number) => {
                const totalTokens = user.inputTokens + user.outputTokens;
                const lastActiveLabel = user.lastActive
                  ? formatDistanceToNowStrict(new Date(user.lastActive), {
                      addSuffix: true,
                    })
                  : "No activity";

                return (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <Badge variant="outline" className="min-w-[2.25rem] justify-center">
                        #{index + 1}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {user.userName || "Unknown"}
                        </span>
                        <span className="text-xs text-muted-foreground">{user.userEmail}</span>
                        <span className="mt-1 text-xs text-muted-foreground/80">
                          Last active {lastActiveLabel}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {numberFormatter.format(user.totalRequests)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {numberFormatter.format(user.totalCost)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {numberFormatter.format(totalTokens)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
