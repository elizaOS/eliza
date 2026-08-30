/**
 * Canonical presentation shell for account collections.
 *
 * Domain adapters own fetching, sorting, mutations, and card rendering; this
 * component owns the shared heading, notices, and mutually exclusive list
 * states so loading, failure, empty, and ready cannot be rendered together.
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Alert, AlertDescription } from "../ui/alert";
import { Card } from "../ui/card";
import { Spinner } from "../ui/spinner";

export type AccountListShellState =
  | { kind: "loading"; label: string }
  | { kind: "error"; message: string; action?: ReactNode }
  | { kind: "empty"; message: string }
  | { kind: "ready"; children: ReactNode };

export interface AccountListShellNotice {
  message: string;
  action?: ReactNode;
}

export interface AccountListShellProps {
  heading: ReactNode;
  action?: ReactNode;
  controls?: ReactNode;
  notice?: AccountListShellNotice;
  state: AccountListShellState;
  className?: string;
}

function AccountListError({ notice }: { notice: AccountListShellNotice }) {
  return (
    <Alert
      variant="destructive"
      className="flex items-center justify-between gap-3"
    >
      <AlertDescription>{notice.message}</AlertDescription>
      {notice.action}
    </Alert>
  );
}

export function AccountListShell({
  heading,
  action,
  controls,
  notice,
  state,
  className,
}: AccountListShellProps) {
  return (
    <Card
      asChild
      variant="transparent"
      surface="raised"
      border="standard"
      padding="default"
      flow="column"
      gap="compact"
      className={cn("mt-3", className)}
    >
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
            {heading}
          </h3>
          {action}
        </div>

        {controls}
        {notice ? <AccountListError notice={notice} /> : null}

        {state.kind === "loading" ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="size-3" />
            {state.label}
          </div>
        ) : state.kind === "error" ? (
          <AccountListError notice={state} />
        ) : state.kind === "empty" ? (
          <Card asChild variant="dashedEmpty" className="px-3">
            <div>{state.message}</div>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">{state.children}</div>
        )}
      </section>
    </Card>
  );
}
