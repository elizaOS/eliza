import { Database } from "../db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Agent } from "./agent";

export class ElizaOS {
  private agents: Agent[] = [];
  private db: NodePgDatabase;

  constructor() {
    console.log("Welcome to elizaOS v3");
    this.db = Database.getInstance();
    Database.setMemory(1, "Hello, world!");
  }

  public addAgent(agent: Agent) {
    this.agents.push(agent);
  }

  public getAgents() {
    return this.agents;
  }

  public getDb() {
    return this.db;
  }
}
