import type { DocumentRecord } from "../../api/client-types-chat";
export declare function getDocumentTypeLabel(contentType?: string): string;
export declare function getDocumentSourceLabel(source: string | undefined, t: (key: string, options?: Record<string, unknown>) => string): string;
export declare function getDocumentSummary(doc: DocumentRecord, t: (key: string, options?: Record<string, unknown>) => string): string;
export declare function DocumentViewer({ documentId, onUpdated, }: {
    documentId: string | null;
    onUpdated?: () => void;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=documents-detail.d.ts.map