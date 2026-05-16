export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type DirectRouteCase =
  | {
      name: string;
      path: string;
      selector: string;
      timeoutMs?: number;
    }
  | {
      name: string;
      path: string;
      readyChecks: readonly (
        | { selector: string; text?: never }
        | { selector?: never; text: string }
      )[];
      timeoutMs?: number;
    };

export const DIRECT_ROUTE_CASES: readonly DirectRouteCase[] = [];
