import type { Agent } from "./agent";

export class ElizaOS {
  private static agents: Agent[] = [];

  constructor() {
    console.log("Welcome to elizaOS v3");
  }

  public static addAgent(agent: Agent) {
    this.agents.push(agent);
  }
}
