export interface ApiKeysSummaryData {
    totalKeys: number;
    activeKeys: number;
    monthlyUsage: number;
    rateLimit: number;
    lastGeneratedAt?: string | null;
}
export interface ApiKeysSummaryProps {
    summary: ApiKeysSummaryData;
}
export declare function ApiKeysSummary({ summary }: ApiKeysSummaryProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=api-keys-summary.d.ts.map