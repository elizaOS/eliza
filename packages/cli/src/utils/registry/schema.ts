// src/utils/registry/schema.ts
import { z } from "zod";

export const registrySchema = z.record(z.string(), z.string());

export type PluginType = "adapter" | "client" | "plugin";

// TODO: we should handle this better later
export function getPluginType(name: string): PluginType {
	if (/sql/.test(name)) return "adapter";
	if (/discord|twitter|telegram/.test(name)) return "client";
	return "plugin";
}

export type Registry = z.infer<typeof registrySchema>;
