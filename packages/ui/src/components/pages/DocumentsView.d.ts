import type { DocumentRecord } from "../../api/client-types-chat";
export { type DocumentUploadFile, getDocumentUploadFilename, shouldReadDocumentFileAsText, } from "./documents-upload";
export declare function DocumentsView({ fileInputId, inModal, embedded, onDocumentsChange, onSelectedDocumentIdChange, selectedDocumentId, showSelectorRail, }?: {
    fileInputId?: string;
    inModal?: boolean;
    embedded?: boolean;
    onDocumentsChange?: (documents: DocumentRecord[]) => void;
    onSelectedDocumentIdChange?: (documentId: string | null) => void;
    selectedDocumentId?: string | null;
    showSelectorRail?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=DocumentsView.d.ts.map