export declare function summarizeError(error: unknown): string;
export declare function normalizeReleaseNotesUrl(url?: string | null): string;
export declare function StatusPill({ label, tone, }: {
    label: string;
    tone: "neutral" | "good" | "warning";
}): import("react/jsx-runtime").JSX.Element;
export declare function DefinitionRow({ emptyFallback, label, value, }: {
    emptyFallback?: string;
    label: string;
    value: string | number | null | undefined;
}): import("react/jsx-runtime").JSX.Element;
export declare function partitionDescription(partition: string, t: (key: string, options?: Record<string, unknown>) => string): string;
//# sourceMappingURL=shared.d.ts.map