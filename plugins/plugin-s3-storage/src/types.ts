import { z } from 'zod';

export const FileLocationResultSchema = z.object({
  fileLocation: z.string().min(1),
});

/**
 * Represents the type of result that is inferred from the FileLocationResultSchema.
 */
export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;

/**
 * Checks if the input object is of type FileLocationResult.
 * @param {unknown} obj - The object to check the type for.
 * @returns {boolean} - True if the object is a FileLocationResult, false otherwise.
 */
export function isFileLocationResult(obj: unknown): obj is FileLocationResult {
  return FileLocationResultSchema.safeParse(obj).success;
}
