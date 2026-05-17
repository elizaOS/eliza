import type { DocumentScope } from "../../api/client-types-chat";
export declare const MAX_UPLOAD_REQUEST_BYTES: number;
export declare const BULK_UPLOAD_TARGET_BYTES: number;
export declare const MAX_BULK_REQUEST_DOCUMENTS = 100;
export declare const LARGE_FILE_WARNING_BYTES: number;
export declare const SUPPORTED_UPLOAD_EXTENSIONS: Set<string>;
export declare const DOCUMENT_UPLOAD_ACCEPT: string;
export type DocumentUploadFile = File & {
    webkitRelativePath?: string;
};
export type DocumentUploadOptions = {
    includeImageDescriptions: boolean;
    scope: DocumentScope;
};
export declare const DEFAULT_DOCUMENT_UPLOAD_SCOPE: DocumentScope;
export declare function getDocumentUploadFilename(file: DocumentUploadFile): string;
export declare function shouldReadDocumentFileAsText(file: Pick<File, "type" | "name">): boolean;
export declare function isSupportedDocumentFile(file: Pick<File, "name">): boolean;
export declare function UploadZone({ fileInputId, onFilesUpload, onTextUpload, onUrlUpload, uploading, uploadStatus, }: {
    fileInputId?: string;
    onFilesUpload: (files: DocumentUploadFile[], options: DocumentUploadOptions) => void;
    onTextUpload: (text: string, title: string | undefined, options: DocumentUploadOptions) => void;
    onUrlUpload: (url: string, options: DocumentUploadOptions) => void;
    uploading: boolean;
    uploadStatus: {
        current: number;
        total: number;
        filename: string;
    } | null;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=documents-upload.d.ts.map