type AnalyticsExportFormat = "csv" | "json" | "excel";
type AnalyticsExportType = "timeseries" | "users" | "providers" | "models";
interface ExportButtonProps {
    startDate: Date | string;
    endDate: Date | string;
    granularity: string;
    format?: AnalyticsExportFormat;
    type?: AnalyticsExportType;
    variant?: "simple" | "dropdown";
    onExport?: (options: {
        format: AnalyticsExportFormat;
        type: AnalyticsExportType;
        startDate: Date | string;
        endDate: Date | string;
        granularity: string;
    }) => void;
}
export declare function ExportButton({ startDate, endDate, granularity, format, type, variant, onExport, }: ExportButtonProps): import("react/jsx-runtime").JSX.Element;
export type { AnalyticsExportFormat, AnalyticsExportType, ExportButtonProps };
//# sourceMappingURL=export-button.d.ts.map