import { registrySchema, type Registry, getPluginType } from "@/src/utils/registry/schema"
import { HttpsProxyAgent } from "https-proxy-agent"
import fetch from "node-fetch"
import { REGISTRY_URL } from "./constants"
import { z } from "zod"
import { isMonorepoContext, getLocalPackages } from "@/src/utils/get-package-info"
import { execa } from "execa"
import { logger } from "@/src/utils/logger"

const agent = process.env.https_proxy
  ? new HttpsProxyAgent(process.env.https_proxy)
  : undefined

export async function getRegistryIndex(): Promise<Registry> {
  try {
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

/**
 * Check if a GitHub repository has a specific branch
 */
export async function repoHasBranch(repoUrl: string, branchName: string): Promise<boolean> {
  try {
    const { stdout } = await execa('git', ['ls-remote', '--heads', repoUrl, branchName]);
    return stdout.includes(branchName);
  } catch (error) {
    logger.warn(`Failed to check for branch ${branchName} in ${repoUrl}: ${error.message}`);
    return false;
  }
}

export async function getBestBranch(repoUrl: string): Promise<string> {
  // Check for v2 or v2-develop branches
  if (await repoHasBranch(repoUrl, 'v2')) {
    return 'v2';
  } else if (await repoHasBranch(repoUrl, 'v2-develop')) {
    return 'v2-develop';
  } else {
    // Default to main branch
    return 'main';
  }
}

export async function listPluginsByType(type: "adapter" | "client" | "plugin"): Promise<string[]> {
  try {
    const registry = await getRegistryIndex()
    const registryPlugins = Object.keys(registry).filter(name => name.includes(`${type}-`))
    
    // If we're in a monorepo context, include local packages
    if (isMonorepoContext()) {
      const localPlugins = await getLocalPackages()
      const filteredLocalPlugins = localPlugins.filter(name => name.includes(`${type}-`))
      
      // Combine and deduplicate
      return [...new Set([...registryPlugins, ...filteredLocalPlugins])]
    }
    
    return registryPlugins
  } catch (error) {
    throw new Error(`Failed to list plugins: ${error.message}`)
  }
}

export async function getAvailableDatabases(): Promise<string[]> {
  try {
    // const adapters = await listPluginsByType("adapter")
    // console.log(adapters)
    // return adapters.map(name => name.replace("@elizaos/adapter-", ""))
    return ["postgres", "pglite"]
  } catch (error) {
    throw new Error(`Failed to get available databases: ${error.message}`)
  }
}