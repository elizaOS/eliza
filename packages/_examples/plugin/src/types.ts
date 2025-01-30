import { z } from "zod";

// Base resource schema
export const ResourceSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    type: z.enum(["document", "image", "video"]),
    description: z.string(),
    tags: z.array(z.string()),
});

// Create resource schema
export const CreateResourceSchema = ResourceSchema.omit({ id: true });

// Read resource schema
export const ReadResourceSchema = z.object({
    id: z.string(),
    fields: z.array(z.string()).optional(),
});

// Update resource schema
export const UpdateResourceSchema = z.object({
    id: z.string(),
    updates: z.record(z.string(), z.any()),
});

// Type definitions
export type Resource = z.infer<typeof ResourceSchema>;
export type CreateResourceContent = z.infer<typeof CreateResourceSchema>;
export type ReadResourceContent = z.infer<typeof ReadResourceSchema>;
export type UpdateResourceContent = z.infer<typeof UpdateResourceSchema>;

// Type guards
export const isCreateResourceContent = (
    obj: object
): obj is CreateResourceContent => {
    return CreateResourceSchema.safeParse(obj).success;
};

export const isReadResourceContent = (obj: object): obj is ReadResourceContent => {
    return ReadResourceSchema.safeParse(obj).success;
};

export const isUpdateResourceContent = (
    obj: object
): obj is UpdateResourceContent => {
    return UpdateResourceSchema.safeParse(obj).success;
};

// Plugin configuration type
export interface ExamplePluginConfig {
    apiKey: string;
    apiSecret: string;
    endpoint?: string;
}
