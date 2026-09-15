/**
 * Defines per-request transport limits for resumable parenting-agreement
 * uploads. These constants never limit the complete PDF or extracted content.
 */

export const AGREEMENT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const AGREEMENT_UPLOAD_METADATA_BYTES = 64 * 1024;
