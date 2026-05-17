import type { AppRunSummary, RegistryAppInfo } from "../../api";
interface RunningAppsRowProps {
    runs: AppRunSummary[];
    catalogApps: RegistryAppInfo[];
    busyRunId: string | null;
    onOpenRun: (run: AppRunSummary) => void;
    onStopRun?: (run: AppRunSummary) => void;
    stoppingRunId?: string | null;
}
export declare function RunningAppsRow({ runs, catalogApps, busyRunId, onOpenRun, onStopRun, stoppingRunId, }: RunningAppsRowProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=RunningAppsRow.d.ts.map