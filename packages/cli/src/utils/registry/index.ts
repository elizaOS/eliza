import { registrySchema, type Registry, getPluginType } from "@/src/utils/registry/schema"
import { HttpsProxyAgent } from "https-proxy-agent"
import fetch from "node-fetch"
import { REGISTRY_URL } from "./constants"

const agent = process.env.https_proxy
  ? new HttpsProxyAgent(process.env.https_proxy)
  : undefined

export async function getRegistryIndex(): Promise<Registry> {
  try {
    const response = await fetch(REGISTRY_URL, { agent })
    const result = await response.json()
    return registrySchema.parse(result)
  } catch (error: any) {
    throw new Error(`Failed to fetch plugins from registry: ${error.message}`)
  }
}

export async function getPluginRepository(pluginName: string): Promise<string | null> {
  try {
    const registry = await getRegistryIndex()
    return registry[pluginName] || null
  } catch (error: any) {
    throw new Error(`Failed to get plugin repository: ${error.message}`)
  }
}

export async function listPluginsByType(type: "adapter" | "client" | "plugin"): Promise<string[]> {
  try {
    const registry = await getRegistryIndex()
    console.log(registry)
    return Object.keys(registry).filter(name => name.includes(type + "-"))
  } catch (error: any) {
    throw new Error(`Failed to list plugins: ${error.message}`)
  }
}

export async function getAvailableDatabases(): Promise<string[]> {
  try {
    // const adapters = await listPluginsByType("adapter")
    // console.log(adapters)
    // return adapters.map(name => name.replace("@elizaos/adapter-", ""))
    return ["sqlite"]
  } catch (error: any) {
    throw new Error(`Failed to get available databases: ${error.message}`)
  }
}