import { Database } from "better-sqlite3"
import { SqliteDatabaseAdapter } from "@elizaos-plugins/sqlite"
  
  // Initialize database
  export const db = new Database("./eliza.db")
  export const adapter = new SqliteDatabaseAdapter(db)
  