/**
 * Shared type definitions for document features.
 */

/**
 * Cloud document structure.
 */
export interface CloudDocument {
  id: string;
  content: {
    text: string;
  };
  createdAt: number;
  metadata?: {
    fileName?: string;
    fileSize?: number;
    uploadedBy?: string;
    uploadedAt?: number;
    originalFilename?: string;
  };
}

/**
 * Query result from document search.
 */
export interface QueryResult {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

/**
 * Pre-uploaded file metadata.
 * Used for files uploaded before character creation.
 */
export interface PreUploadedFile {
  id: string;
  filename: string;
  blobUrl: string;
  contentType: string;
  size: number;
  uploadedAt: number;
}
