import { registrySchema, type Registry, getPluginType } from "@/src/utils/registry/schema"
import { HttpsProxyAgent } from "https-proxy-agent"
import fetch from "node-fetch"
import { REGISTRY_URL } from "./constants"
import { z } from "zod"
const agent = process.env.https_proxy
  ? new HttpsProxyAgent(process.env.https_proxy)
  : undefined

export async function getRegistryIndex(): Promise<Registry> {
  try {
    console.log("REGISTRY_URL", REGISTRY_URL)
    const response = await fetch(REGISTRY_URL, { agent })
    // Get the response body as text first
    const text = await response.text()

    let registry: Registry
    try {
      // validate if the response is a valid registry
      registry = registrySchema.parse(JSON.parse(text))
    } catch {
      console.error("Invalid JSON response received from registry:", text)
      throw new Error("Registry response is not valid JSON")
    }

    return registry
  } catch (error) {
    throw new Error(`Failed to fetch plugins from registry: ${error.message}`)
  }
}

export async function getPluginRepository(pluginName: string): Promise<string | null> {
  try {
    const registry = await getRegistryIndex()
    return registry[pluginName] || null
  } catch (error) {
    throw new Error(`Failed to get plugin repository: ${error.message}`)
  }
}

export async function listPluginsByType(type: "adapter" | "client" | "plugin"): Promise<string[]> {
  try {
    const registry = await getRegistryIndex()
    return Object.keys(registry).filter(name => name.includes(`${type}-`))
  } catch (error) {
    throw new Error(`Failed to list plugins: ${error.message}`)
  }
}

export async function getAvailableDatabases(): Promise<string[]> {
  try {
    // const adapters = await listPluginsByType("adapter")
    // console.log(adapters)
    // return adapters.map(name => name.replace("@elizaos/adapter-", ""))
    return ["sqlite", "drizzle"]
  } catch (error) {
    throw new Error(`Failed to get available databases: ${error.message}`)
  }
}