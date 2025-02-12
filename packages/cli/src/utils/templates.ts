// src/utils/templates.ts
export function createDatabaseTemplate(database: string) {
    if (database === "sqlite") {
      return `import { Database } from "better-sqlite3"
  import { SqliteDatabaseAdapter } from "@elizaos-plugins/sqlite"
  
  // Initialize database
  export const db = new Database("./eliza.db")
  export const adapter = new SqliteDatabaseAdapter(db)
  `
    }
  
    return `import { ${database}Adapter } from "@elizaos/adapter-${database}"
  
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not found in environment")
  }
  
  // Initialize adapter
  export const adapter = new ${database}Adapter(process.env.DATABASE_URL)
  `
  }
  
  export function createPluginsTemplate(plugins: string[]) {
    return `// Auto-generated - do not edit
  ${plugins.map(plugin => `import { ${getPluginName(plugin)} } from "${plugin}"`).join("\n")}
  
  export const availablePlugins = {
  ${plugins.map(plugin => `  "${plugin}": ${getPluginName(plugin)},`).join("\n")}
  }
  
  // Helper type
  export type PluginName = keyof typeof availablePlugins
  `
  }
  
  export function createEnvTemplate(database: string) {
    if (database === "sqlite") {
      return `# No configuration needed for SQLite`
    }
  
    return `# Database Configuration
  DATABASE_URL=your_${database}_url_here
  
  # Add any other secrets needed by your plugins below
  `
  }
  
  function getPluginName(plugin: string): string {
    return plugin.split("/").pop()!.replace(/-/g, "")
  }