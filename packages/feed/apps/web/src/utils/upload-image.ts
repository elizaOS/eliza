/**
 * Upload an image to the app's image API (Vercel Blob or MinIO).
 * Used by edit profile and onboarding for profile/cover image uploads.
 */

import { apiFetch } from '@/utils/api-fetch';

export type UploadImageType = 'profile' | 'cover';

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Validate image file type and size. Use before upload for consistent client-side UX.
 * @param file - File to validate
 * @param maxSize - Max size in bytes (default MAX_IMAGE_SIZE)
 * @returns Error message or null if valid
 */
export function validateImageFile(
  file: File,
  maxSize: number = MAX_IMAGE_SIZE
): string | null {
  if (!file.type.startsWith('image/')) {
    return 'Please select an image file';
  }
  if (file.size > maxSize) {
    const mb = Math.round(maxSize / (1024 * 1024));
    return `Image must be less than ${mb}MB`;
  }
  return null;
}

interface UploadErrorResponse {
  error?: string;
  message?: string;
}

/**
 * Upload a file to /api/upload/image and return the public URL.
 * Uses apiFetch for auth (Privy token) and 401 retry.
 * @param file - Image file to upload
 * @param type - 'profile' or 'cover'
 * @returns The public URL of the uploaded image
 * @throws Error if the request fails
 */
export async function uploadImage(
  file: File,
  type: UploadImageType
): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('type', type);

  const response = await apiFetch('/api/upload/image', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body: UploadErrorResponse = await response.json().catch(() => ({}));
    throw new Error(body.error ?? body.message ?? 'Upload failed');
  }

  const data = (await response.json()) as { url: string };
  return data.url;
}
