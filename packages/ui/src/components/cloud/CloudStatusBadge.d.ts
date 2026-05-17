type CloudHeaderStatusKind =
  | "error"
  | "warning"
  | "low-credits"
  | "regular-credits";
interface ResolveCloudStatusBadgeStateArgs {
  connected: boolean;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
  authRejected: boolean;
  creditsError?: string | null;
  t: (key: string) => string;
}
interface CloudStatusBadgeState {
  kind: CloudHeaderStatusKind;
  text: string;
  title: string;
}
export interface CloudStatusBadgeProps {
  connected: boolean;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
  authRejected: boolean;
  creditsError?: string | null;
  compactOnMobile?: boolean;
  appearance?: "default" | "shell";
  t: (key: string) => string;
  onClick: () => void;
  dataTestId?: string;
}
export declare function formatCompactCloudCredits(balance: number): string;
export declare function resolveCloudStatusBadgeState(
  args: ResolveCloudStatusBadgeStateArgs,
): CloudStatusBadgeState | null;
export declare function CloudStatusBadge(
  props: CloudStatusBadgeProps,
): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=CloudStatusBadge.d.ts.map
