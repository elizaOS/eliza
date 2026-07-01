/**
 * Stub for `@elizaos/ui` — the giant renderer barrel — used by the view
 * screenshot harness. Aliased in place of the real package via vite
 * `resolve.alias`. Mirrors exactly the surface the views' own jsdom tests mock:
 *
 * - `client.getBaseUrl()` / `client.sendChatMessage()` — touched only by the
 *   views' default fetcher seams, which the harness always overrides; provided
 *   so the module-level affordances (Connect / Add / Set-goal buttons) don't
 *   throw on render.
 * - `useApp()` / `useMediaQuery()` — used by CalendarView + CalendarSection.
 * - `Button` / `Spinner` / `Popover*` / `SegmentedControl` — Calendar UI
 *   primitives, stubbed to plain DOM exactly like CalendarSection.test.tsx.
 */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export const client = {
  getBaseUrl: () => "http://test.local",
  sendChatMessage: (..._args: unknown[]) => {},
  // Real hook calls this when useCalendarWeek is NOT stubbed; the harness
  // always stubs useCalendarWeek, so this is a never-resolving guard.
  getLifeOpsCalendarFeed: (..._args: unknown[]) => new Promise<never>(() => {}),
  stopWebsiteBlock: async () => ({ success: true, removed: true }),
};

export function useApp(): {
  t: (key: string, opts?: { defaultValue?: string }) => string;
  setActionNotice: (...args: unknown[]) => void;
} {
  return {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    setActionNotice: () => {},
  };
}

// Desktop default; the calendar fixtures flip this through `?compact=1`.
export function useMediaQuery(): boolean {
  return globalThis.__VIEW_HARNESS_COMPACT__ === true;
}

export function Button({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

export function Spinner(): ReactNode {
  return <span data-testid="spinner">⟳</span>;
}

export function Popover({ children }: { children: ReactNode }): ReactNode {
  return <div>{children}</div>;
}

export function PopoverTrigger({
  children,
}: {
  children: ReactNode;
  asChild?: boolean;
}): ReactNode {
  return children;
}

export function PopoverContent({
  children,
  ...props
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...props}>{children}</div>;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  items,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
}): ReactNode {
  return (
    <div data-segmented-control>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          data-testid={`view-${item.value}`}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __VIEW_HARNESS_COMPACT__: boolean | undefined;
}
