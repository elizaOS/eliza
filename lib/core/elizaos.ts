import { Database } from "@/lib/db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Agent } from "@/lib/core";

export class ElizaOS {
  private agentsById: Map<string, Agent> = new Map();
  private db: NodePgDatabase;

  constructor() {
    console.log("Welcome to elizaOS v3");
    this.db = Database.getInstance();
    Database.setMemory(1, "Hello, world!");
  }

  public addAgent(agent: Agent, id: string): string {
    if (this.agentsById.has(id)) {
      throw new Error(`Agent with id "${id}" already exists`);
    }
    this.agentsById.set(id, agent);
    return id;
  }

  public listAgents(): Array<{ id: string }> {
    return Array.from(this.agentsById.keys()).map((id) => ({ id }));
  }

  public getAgentById(id: string): Agent | undefined {
    return this.agentsById.get(id);
  }

  public getDb() {
    return this.db;
  }
}
