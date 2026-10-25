/**
 * Seed data for agent integration tests
 */
import type { Agent } from "@elizaos/core";

/**
 * Test agent data used across agent integration tests
 */
export const testAgent: Agent = {
  name: "Integration Test Agent",
  username: "test_agent",
  bio: "A test agent for integration tests",
  enabled: true,
  settings: {
    testSetting: "test value",
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
