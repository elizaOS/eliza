// src/utils/registry/schema.ts
import { z } from "zod"

export const registrySchema = z.record(z.string(), z.string())

export type PluginType = "adapter" | "client" | "plugin"

export function getPluginType(name: string): PluginType {
  if (name.includes("adapter-")) return "adapter"
  if (name.includes("client-")) return "client" 
  return "plugin"
}

export type Registry = z.infer<typeof registrySchema>