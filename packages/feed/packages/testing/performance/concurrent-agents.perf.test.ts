/**
 * Concurrent Agent Performance Tests
 *
 * Tests system performance under concurrent agent load:
 * - Multiple agents registering simultaneously
 * - Concurrent message sending/receiving
 * - Discovery queries under load
 * - Trust calculation performance
 * - Message routing throughput
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  CommunicationHub,
  ExternalAgentAdapter,
  getEventBus,
} from "@feed/agents";
import type { AgentCapabilities } from "@feed/shared";

// Performance thresholds
const PERF_THRESHOLDS = {
  maxRegistrationTime: 1000, // 1 second per agent
  maxMessageDeliveryTime: 500, // 500ms per message
  maxDiscoveryTime: 2000, // 2 seconds for discovery
  maxTrustCalculationTime: 100, // 100ms for trust score
  minThroughput: 10, // messages per second
};

// Helper to measure execution time
async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}

// Helper to generate test agent data
function generateTestAgent(index: number) {
  return {
    externalId: `perf-test-agent-${Date.now()}-${index}`,
    name: `Performance Test Agent ${index}`,
    description: `Agent ${index} for performance testing`,
    endpoint: `https://perf-agent-${index}.example.com/a2a`,
    protocol: "a2a" as const,
    capabilities: {
      actions: ["text-generation", "analysis"],
      version: "1.0.0",
      skills: [`skill-${index}`],
      domains: [`domain-${index}`],
    } as AgentCapabilities,
  };
}

describe("Concurrent Agent Performance Tests", () => {
  let adapter: ExternalAgentAdapter;
  let hub: CommunicationHub;

  beforeAll(async () => {
    adapter = new ExternalAgentAdapter();
    await adapter.initialize();
    hub = new CommunicationHub(getEventBus());
  });

  afterAll(() => {
    adapter.stopHealthChecks();
    adapter.shutdown();
    hub.clearHistory();
  });

  describe("Registration Performance", () => {
    it("should handle 10 concurrent registrations within threshold", async () => {
      const agentCount = 10;
      const agents = Array.from({ length: agentCount }, (_, i) =>
        generateTestAgent(i),
      );

      const { duration } = await measureTime(async () => {
        const registrations = agents.map(async (agent) => {
          // Simulate registration via API
          const response = await fetch(
            "http://localhost:3000/api/agents/external/register",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(agent),
            },
          );
          return response.json();
        });

        return Promise.all(registrations);
      });

      const avgTimePerAgent = duration / agentCount;

      console.log(
        `Registered ${agentCount} agents in ${duration.toFixed(2)}ms`,
      );
      console.log(`Average time per agent: ${avgTimePerAgent.toFixed(2)}ms`);

      expect(avgTimePerAgent).toBeLessThan(PERF_THRESHOLDS.maxRegistrationTime);
    });

    it("should handle 50 concurrent registrations without errors", async () => {
      const agentCount = 50;
      const agents = Array.from({ length: agentCount }, (_, i) =>
        generateTestAgent(100 + i),
      );

      const { result, duration } = await measureTime(async () => {
        const registrations = agents.map(async (agent) => {
          try {
            const response = await fetch(
              "http://localhost:3000/api/agents/external/register",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(agent),
              },
            );
            const data = await response.json();
            return { success: data.success, status: response.status };
          } catch (error) {
            return { success: false, error: (error as Error).message };
          }
        });

        return Promise.all(registrations);
      });

      const successCount = result.filter((r) => r.success).length;

      console.log(
        `Registered ${successCount}/${agentCount} agents in ${duration.toFixed(2)}ms`,
      );

      expect(successCount).toBeGreaterThanOrEqual(agentCount * 0.95); // 95% success rate
    });
  });

  describe("Message Delivery Performance", () => {
    it("should handle 100 concurrent messages within threshold", async () => {
      const messageCount = 100;

      // Create mock connection for testing
      const mockConnection = {
        id: "perf-conn-1",
        externalId: "perf-agent-1",
        endpoint: "https://perf-agent.example.com/a2a",
        protocol: "a2a" as const,
        isHealthy: true,
      };

      adapter.connections.set("perf-agent-1", mockConnection);

      const { duration } = await measureTime(async () => {
        const messages = Array.from({ length: messageCount }, (_, i) =>
          hub.sendMessage(
            "sender-agent",
            "perf-agent-1",
            "test-message",
            { index: i, content: `Test message ${i}` },
            { priority: "normal" },
          ),
        );

        return Promise.all(messages);
      });

      const avgTimePerMessage = duration / messageCount;
      const throughput = (messageCount / duration) * 1000; // messages per second

      console.log(`Sent ${messageCount} messages in ${duration.toFixed(2)}ms`);
      console.log(
        `Average time per message: ${avgTimePerMessage.toFixed(2)}ms`,
      );
      console.log(`Throughput: ${throughput.toFixed(2)} messages/second`);

      expect(avgTimePerMessage).toBeLessThan(
        PERF_THRESHOLDS.maxMessageDeliveryTime,
      );
      expect(throughput).toBeGreaterThan(PERF_THRESHOLDS.minThroughput);
    });

    it("should maintain low latency under sustained load", async () => {
      const duration = 5000; // 5 seconds
      const messageInterval = 50; // Send message every 50ms
      const expectedMessages = duration / messageInterval;

      let sentMessages = 0;
      let successCount = 0;
      const latencies: number[] = [];

      const startTime = Date.now();

      while (Date.now() - startTime < duration) {
        const messageStart = performance.now();

        try {
          const response = await hub.sendMessage(
            "load-test-sender",
            "load-test-receiver",
            "load-test",
            { timestamp: Date.now(), index: sentMessages },
          );

          const messageEnd = performance.now();
          const latency = messageEnd - messageStart;

          latencies.push(latency);

          if (response.success) {
            successCount++;
          }
        } catch {
          // Track failures but continue
        }

        sentMessages++;
        await new Promise((resolve) => setTimeout(resolve, messageInterval));
      }

      const avgLatency =
        latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const minLatency = Math.min(...latencies);
      const successRate = (successCount / sentMessages) * 100;

      console.log("Sustained load test results:");
      console.log(`  Sent: ${sentMessages} messages`);
      console.log(`  Success rate: ${successRate.toFixed(2)}%`);
      console.log(`  Avg latency: ${avgLatency.toFixed(2)}ms`);
      console.log(`  Min latency: ${minLatency.toFixed(2)}ms`);
      console.log(`  Max latency: ${maxLatency.toFixed(2)}ms`);

      expect(sentMessages).toBeGreaterThanOrEqual(expectedMessages * 0.9);
      expect(avgLatency).toBeLessThan(PERF_THRESHOLDS.maxMessageDeliveryTime);
      expect(successRate).toBeGreaterThan(95);
    });
  });

  describe("Discovery Performance", () => {
    it("should handle concurrent discovery queries", async () => {
      const queryCount = 20;

      const { duration } = await measureTime(async () => {
        const queries = Array.from({ length: queryCount }, (_, i) =>
          fetch(
            `http://localhost:3000/api/agents/external/discover?limit=10&offset=${i * 10}`,
            {
              method: "GET",
              headers: {
                Authorization: "Bearer test-api-key",
              },
            },
          ).then((r) => r.json()),
        );

        return Promise.all(queries);
      });

      const avgTimePerQuery = duration / queryCount;

      console.log(
        `Executed ${queryCount} discovery queries in ${duration.toFixed(2)}ms`,
      );
      console.log(`Average time per query: ${avgTimePerQuery.toFixed(2)}ms`);

      expect(avgTimePerQuery).toBeLessThan(PERF_THRESHOLDS.maxDiscoveryTime);
    });
  });

  describe("Trust Calculation Performance", () => {
    it("should calculate trust scores efficiently", async () => {
      const connectionCount = 100;
      const connections = Array.from({ length: connectionCount }, (_, i) => ({
        id: `conn-${i}`,
        externalId: `agent-${i}`,
        endpoint: `https://agent-${i}.example.com`,
        protocol: "a2a" as const,
        isHealthy: i % 2 === 0, // 50% healthy
        lastConnected: i % 4 === 0 ? new Date() : undefined,
      }));

      const { duration } = await measureTime(async () => {
        return connections.map((conn) => adapter.calculateTrustScore(conn));
      });

      const avgTimePerCalculation = duration / connectionCount;

      console.log(
        `Calculated ${connectionCount} trust scores in ${duration.toFixed(2)}ms`,
      );
      console.log(
        `Average time per calculation: ${avgTimePerCalculation.toFixed(2)}ms`,
      );

      expect(avgTimePerCalculation).toBeLessThan(
        PERF_THRESHOLDS.maxTrustCalculationTime,
      );
    });
  });

  describe("Message Routing Performance", () => {
    it("should route messages efficiently across protocols", async () => {
      const messageCount = 50;

      // Create mock connections for different protocols
      const protocols: Array<"a2a" | "mcp" | "agent0" | "custom"> = [
        "a2a",
        "mcp",
        "agent0",
        "custom",
      ];

      protocols.forEach((protocol) => {
        adapter.connections.set(`${protocol}-agent`, {
          id: `conn-${protocol}`,
          externalId: `${protocol}-agent`,
          endpoint: `https://${protocol}-agent.example.com`,
          protocol,
          isHealthy: true,
        });
      });

      const { duration } = await measureTime(async () => {
        const messages = Array.from(
          { length: messageCount },
          (_, messageIndex) => {
            const protocol = protocols[messageIndex % protocols.length];
            return hub.sendMessage(
              "routing-test-sender",
              `${protocol}-agent`,
              "routing-test",
              `Test message ${messageIndex} for ${protocol}`,
            );
          },
        );

        return Promise.all(messages);
      });

      const avgTimePerMessage = duration / messageCount;

      console.log(
        `Routed ${messageCount} messages across protocols in ${duration.toFixed(2)}ms`,
      );
      console.log(`Average routing time: ${avgTimePerMessage.toFixed(2)}ms`);

      expect(avgTimePerMessage).toBeLessThan(
        PERF_THRESHOLDS.maxMessageDeliveryTime,
      );
    });
  });

  describe("Memory and Resource Usage", () => {
    it("should handle large message history without memory leaks", async () => {
      const messageCount = 1000;
      const initialMemory = process.memoryUsage().heapUsed;

      // Send many messages to build up history
      for (let i = 0; i < messageCount; i++) {
        await hub.sendMessage(
          "memory-test-sender",
          "memory-test-receiver",
          "memory-test",
          { index: i, data: "x".repeat(100) }, // 100 bytes per message
        );
      }

      const history = hub.getMessageHistory();
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      const bytesPerMessage = memoryIncrease / messageCount;

      console.log(`Message history size: ${history.length}`);
      console.log(
        `Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`,
      );
      console.log(`Bytes per message: ${bytesPerMessage.toFixed(2)}`);

      // Memory usage should be reasonable (less than 10KB per message including overhead)
      expect(bytesPerMessage).toBeLessThan(10240);

      // Clear history to prevent memory issues
      hub.clearHistory();

      const clearedMemory = process.memoryUsage().heapUsed;

      console.log(
        `Memory after cleanup: ${(clearedMemory / 1024 / 1024).toFixed(2)} MB`,
      );
    });
  });
});
