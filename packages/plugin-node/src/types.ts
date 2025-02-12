import { z } from "zod";

export const FileLocationResultSchema = z.object({
    fileLocation: z.string().min(1),
});

export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;

export function isFileLocationResult(obj: unknown): obj is FileLocationResult {
    return FileLocationResultSchema.safeParse(obj).success;
}
