import { describe, expect, it } from "bun:test";
import { agentCard } from "../src/agent-card";

describe("local A2A server agent card", () => {
  it("exposes the local development A2A contract", () => {
    expect(agentCard.name).toBe("Feed Local A2A Server");
    expect(agentCard.url).toBe("http://localhost:3001");
    expect(agentCard.capabilities.streaming).toBe(true);
    expect(agentCard.skills.map((skill) => skill.id)).toContain("discover");
  });
});
