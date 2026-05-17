import type React from "react";
import type {
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
} from "../../../api";
export type SurfaceTone = "neutral" | "accent" | "success" | "warn" | "danger";
export interface SelectedAppRun {
  run: AppRunSummary | null;
  matchingRuns: AppRunSummary[];
}
export declare function selectLatestRunForApp(
  appName: string,
  runs: AppRunSummary[] | null | undefined,
): SelectedAppRun;
export declare function formatDetailTimestamp(
  value: string | number | null | undefined,
): string;
export declare function toneForHealthState(
  state: AppRunHealthState | null | undefined,
): SurfaceTone;
export declare function toneForViewerAttachment(
  attachment: AppRunViewerAttachment | null | undefined,
): SurfaceTone;
export declare function toneForStatusText(
  status: string | null | undefined,
): SurfaceTone;
export declare function SurfaceBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: SurfaceTone;
}): import("react/jsx-runtime").JSX.Element;
export declare function SurfaceCard({
  label,
  value,
  tone,
  subtitle,
}: {
  label: string;
  value: React.ReactNode;
  tone?: SurfaceTone;
  subtitle?: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function SurfaceGrid({
  children,
}: {
  children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function SurfaceSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function SurfaceEmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=surface.d.ts.map
