/**
 * Canonical presentation shell for account collections.
 *
 * Domain adapters own fetching, sorting, mutations, and card rendering; this
 * component owns the shared heading, notices, and mutually exclusive list
 * states so loading, failure, empty, and ready cannot be rendered together.
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
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
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-sm border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
    >
      <span>{notice.message}</span>
      {notice.action}
    </div>
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
    <section
      className={cn(
        "mt-3 flex flex-col gap-2 rounded-sm border border-border/40 bg-bg-accent/40 p-3",
        className,
      )}
    >
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
        <div className="border-y border-dashed border-border/50 px-3 py-6 text-center text-xs text-muted">
          {state.message}
        </div>
      ) : (
        <div className="flex flex-col gap-2">{state.children}</div>
      )}
    </section>
  );
}
