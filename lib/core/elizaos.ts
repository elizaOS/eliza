import { Database } from "../db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Agent } from "./agent";

export class ElizaOS {
  private static agents: Agent[] = [];
  private static db: NodePgDatabase;

  constructor() {
    console.log("Welcome to elizaOS v3");
    ElizaOS.db = Database.getInstance();
    Database.setMemory(1, "Hello, world!");
  }

  public static addAgent(agent: Agent) {
    this.agents.push(agent);
  }
}
