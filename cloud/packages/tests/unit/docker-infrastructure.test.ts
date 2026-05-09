/**
 * Unit Tests — Docker Infrastructure Pure Functions
 *
 * Tests the utility functions extracted to docker-sandbox-utils.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  allocatePort,
  extractDockerCreateContainerId,
  getContainerName,
  getVolumePath,
  MAX_AGENT_ID_LENGTH,
  parseDockerNodes,
  readDockerHostPortFromMetadata,
  requiresDockerHostGateway,
  resolveStewardContainerUrl,
  shellQuote,
  validateAgentId,
  validateAgentName,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
  validateVolumePath,
} from "@/lib/services/docker-sandbox-utils";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sandboxProviderModuleUrl = new URL("../../lib/services/sandbox-provider.ts", import.meta.url)
  .href;

function runSandboxProviderFactory() {
  const env = { ...process.env };
  env.STEWARD_TENANT_API_KEY ??= "test-steward-key";

  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
        const mod = await import(${JSON.stringify(`${sandboxProviderModuleUrl}?test=${Date.now()}`)});
        const { createSandboxProvider } = mod;
        try {
          const provider = await createSandboxProvider();
          console.log(JSON.stringify({ ok: true, name: provider.constructor?.name ?? null }));
        } catch (error) {
          console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
        }
      `,
    ],
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();

  expect(result.exitCode).toBe(0);
  expect(stderr).toBe("");

  return JSON.parse(stdout) as { ok: true; name: string | null } | { ok: false; message: string };
}

describe("Docker Infrastructure - Pure Functions", () => {
  // -------------------------------------------------------------------------
  describe("shellQuote", () => {
    test("wraps a simple string in single quotes", () => {
      expect(shellQuote("hello")).toBe("'hello'");
    });

    test("wraps an empty string", () => {
      expect(shellQuote("")).toBe("''");
    });

    test("wraps a string with spaces", () => {
      expect(shellQuote("hello world")).toBe("'hello world'");
    });

    test("escapes an embedded single quote", () => {
      expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    });

    test("safely quotes $HOME && rm -rf / (no variable expansion)", () => {
      expect(shellQuote("$HOME && rm -rf /")).toBe("'$HOME && rm -rf /'");
    });

    test("wraps a string with double quotes (no escaping needed)", () => {
      expect(shellQuote('say "hi"')).toBe("'say \"hi\"'");
    });

    test("safely quotes a string with newlines", () => {
      const result = shellQuote("line1\nline2");
      expect(result.startsWith("'")).toBe(true);
      expect(result.endsWith("'")).toBe(true);
      expect(result).toContain("line1\nline2");
    });

    test("safely quotes $(whoami) — no command substitution possible", () => {
      expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    });
  });

  // -------------------------------------------------------------------------
  describe("validateAgentId", () => {
    test("accepts a UUID-like ID", () => {
      expect(() => validateAgentId("abc-123-def")).not.toThrow();
    });

    test("accepts alphanumeric with underscores", () => {
      expect(() => validateAgentId("agent_1")).not.toThrow();
    });

    test("accepts a single character", () => {
      expect(() => validateAgentId("a")).not.toThrow();
    });

    test("accepts exactly the Docker-safe maximum length", () => {
      const id = "a".repeat(MAX_AGENT_ID_LENGTH);
      expect(() => validateAgentId(id)).not.toThrow();
    });

    test("throws for empty string", () => {
      expect(() => validateAgentId("")).toThrow(/Invalid agent ID/);
    });

    test("throws when the agentId would exceed the Docker container name limit", () => {
      const id = "a".repeat(MAX_AGENT_ID_LENGTH + 1);
      expect(() => validateAgentId(id)).toThrow(/Invalid agent ID/);
    });

    test("throws for shell injection chars (semicolon, space)", () => {
      expect(() => validateAgentId("agent;rm -rf /")).toThrow(/Invalid agent ID/);
    });

    test("throws for trailing newline", () => {
      expect(() => validateAgentId("agent_1\n")).toThrow(/Invalid agent ID/);
    });

    test("throws for dots", () => {
      expect(() => validateAgentId("agent.1")).toThrow(/Invalid agent ID/);
    });

    test("throws for spaces", () => {
      expect(() => validateAgentId("agent 1")).toThrow(/Invalid agent ID/);
    });
  });

  // -------------------------------------------------------------------------
  describe("validateAgentName", () => {
    test("accepts a simple valid name", () => {
      expect(() => validateAgentName("my-agent")).not.toThrow();
    });

    test("accepts alphanumeric with underscores and hyphens", () => {
      expect(() => validateAgentName("Agent_99")).not.toThrow();
    });

    test("accepts a single character", () => {
      expect(() => validateAgentName("x")).not.toThrow();
    });

    test("accepts exactly 64 characters", () => {
      const name = "a".repeat(64);
      expect(() => validateAgentName(name)).not.toThrow();
    });

    test("throws for empty string", () => {
      expect(() => validateAgentName("")).toThrow(/Invalid agent name/);
    });

    test("throws for 65 characters (too long)", () => {
      const name = "a".repeat(65);
      expect(() => validateAgentName(name)).toThrow(/Invalid agent name/);
    });

    test("accepts spaces (shell-safe via quoting)", () => {
      expect(() => validateAgentName("my agent")).not.toThrow();
    });

    test("accepts dots (shell-safe via quoting)", () => {
      expect(() => validateAgentName("my.agent")).not.toThrow();
    });

    test("accepts semicolons (shell-safe via quoting)", () => {
      expect(() => validateAgentName("agent;drop")).not.toThrow();
    });

    test("throws for control characters (null byte)", () => {
      expect(() => validateAgentName("agent\x00name")).toThrow(/control characters/);
    });

    test("throws for control characters (newline)", () => {
      expect(() => validateAgentName("agent\nname")).toThrow(/control characters/);
    });

    test("throws for control characters (tab)", () => {
      expect(() => validateAgentName("agent\tname")).toThrow(/control characters/);
    });
  });

  // -------------------------------------------------------------------------
  describe("validateEnvKey", () => {
    test("accepts uppercase and lowercase underscore keys", () => {
      expect(() => validateEnvKey("JWT_SECRET")).not.toThrow();
      expect(() => validateEnvKey("jwt_secret")).not.toThrow();
      expect(() => validateEnvKey("A1_B2")).not.toThrow();
    });

    test("rejects empty keys", () => {
      expect(() => validateEnvKey("")).toThrow(/Invalid environment variable key/);
    });

    test("rejects keys starting with a digit", () => {
      expect(() => validateEnvKey("1SECRET")).toThrow(/Invalid environment variable key/);
    });

    test("rejects punctuation", () => {
      expect(() => validateEnvKey("JWT-SECRET")).toThrow(/Invalid environment variable key/);
    });

    test("rejects trailing newlines", () => {
      expect(() => validateEnvKey("JWT_SECRET\n")).toThrow(/Invalid environment variable key/);
    });
  });

  // -------------------------------------------------------------------------
  describe("validateEnvValue", () => {
    test("accepts printable values", () => {
      expect(() => validateEnvValue("JWT_SECRET", "hello-world_123")).not.toThrow();
    });

    test("accepts UUIDs, URLs, and base64-like tokens", () => {
      expect(() =>
        validateEnvValue(
          "MIXED_VALUE",
          "550e8400-e29b-41d4-a716-446655440000 https://example.com/a?b=c token+/=",
        ),
      ).not.toThrow();
    });

    test("rejects null bytes and includes the key name", () => {
      expect(() => validateEnvValue("JWT_SECRET", "abc\x00def")).toThrow(
        /JWT_SECRET.*control characters/,
      );
    });

    test("rejects newlines and explains PEM-style values are unsupported", () => {
      expect(() => validateEnvValue("TLS_CERT", "abc\ndef")).toThrow(
        /TLS_CERT.*newlines and PEM-encoded values are not supported/,
      );
    });

    test("rejects tabs", () => {
      expect(() => validateEnvValue("JWT_SECRET", "abc\tdef")).toThrow(/control characters/);
    });
  });

  // -------------------------------------------------------------------------
  describe("resolveStewardContainerUrl", () => {
    test("preserves explicit STEWARD_CONTAINER_URL overrides", () => {
      expect(
        resolveStewardContainerUrl("http://localhost:8787/steward", "http://steward.internal:9999"),
      ).toBe("http://steward.internal:9999");
    });

    test("rewrites localhost host URLs for container reachability", () => {
      expect(resolveStewardContainerUrl("http://localhost:8787/steward")).toBe(
        "http://host.docker.internal:8787/steward",
      );
      expect(resolveStewardContainerUrl("http://127.0.0.1:8787/steward")).toBe(
        "http://host.docker.internal:8787/steward",
      );
    });

    test("passes through non-loopback URLs unchanged", () => {
      expect(resolveStewardContainerUrl("http://10.0.0.8:3200")).toBe("http://10.0.0.8:3200");
    });
  });

  // -------------------------------------------------------------------------
  describe("requiresDockerHostGateway", () => {
    test("returns true for host.docker.internal", () => {
      expect(requiresDockerHostGateway("http://host.docker.internal:3200")).toBe(true);
    });

    test("returns false for non-host-gateway URLs", () => {
      expect(requiresDockerHostGateway("http://10.0.0.8:3200")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("extractDockerCreateContainerId", () => {
    test("accepts a plain container id", () => {
      expect(
        extractDockerCreateContainerId(
          "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\n",
        ),
      ).toBe("1234567890ab");
    });

    test("uses the final stdout line when warnings precede the id", () => {
      expect(
        extractDockerCreateContainerId(
          "DEPRECATED: something noisy\nabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd\n",
        ),
      ).toBe("abcdefabcdef");
    });

    test("uses the container id even when stderr arrives after stdout", () => {
      expect(
        extractDockerCreateContainerId(
          "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd\n[stderr] WARNING: platform mismatch\n",
        ),
      ).toBe("abcdefabcdef");
    });

    test("rejects non-hex output", () => {
      expect(() => extractDockerCreateContainerId("container created successfully")).toThrow(
        /invalid container id/,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("allocatePort", () => {
    test("returns a port within [min, max)", () => {
      const port = allocatePort(3000, 4000, new Set());
      expect(port).toBeGreaterThanOrEqual(3000);
      expect(port).toBeLessThan(4000);
    });

    test("never returns an excluded port (large range, many iterations)", () => {
      const excluded = new Set([1000, 1001, 1002]);
      for (let i = 0; i < 50; i++) {
        const port = allocatePort(1000, 2000, excluded);
        expect(excluded.has(port)).toBe(false);
        expect(port).toBeGreaterThanOrEqual(1000);
        expect(port).toBeLessThan(2000);
      }
    });

    test("finds an available port when most of the range is excluded", () => {
      const excluded = new Set(Array.from({ length: 95 }, (_, i) => 500 + i));
      const available = new Set([595, 596, 597, 598, 599]);
      for (let i = 0; i < 20; i++) {
        const port = allocatePort(500, 600, excluded);
        expect(available.has(port)).toBe(true);
        expect(port).toBeGreaterThanOrEqual(500);
        expect(port).toBeLessThan(600);
      }
    });

    test("throws when all ports in range are excluded", () => {
      expect(() => allocatePort(10, 13, new Set([10, 11, 12]))).toThrow(/No available ports/);
    });

    test("works with an empty exclusion set", () => {
      const port = allocatePort(5000, 6000, new Set());
      expect(port).toBeGreaterThanOrEqual(5000);
      expect(port).toBeLessThan(6000);
    });

    test("single-port range with no exclusions returns that port", () => {
      expect(allocatePort(42, 43, new Set())).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  describe("readDockerHostPortFromMetadata", () => {
    test("reads a positive integer hostPort", () => {
      expect(readDockerHostPortFromMetadata({ hostPort: 23456 })).toBe(23456);
    });

    test("rejects missing and invalid host ports", () => {
      expect(readDockerHostPortFromMetadata(null)).toBeNull();
      expect(readDockerHostPortFromMetadata({})).toBeNull();
      expect(readDockerHostPortFromMetadata({ hostPort: "23456" })).toBeNull();
      expect(readDockerHostPortFromMetadata({ hostPort: 0 })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("getContainerName", () => {
    test("prefixes the agentId with 'agent-'", () => {
      expect(getContainerName("abc-123")).toBe("agent-abc-123");
    });

    test("works with a UUID-style agentId", () => {
      const agentId = "550e8400-e29b-41d4-a716-446655440000";
      expect(getContainerName(agentId)).toBe(`agent-${agentId}`);
    });

    test("throws when the derived Docker container name would be too long", () => {
      expect(() => getContainerName("a".repeat(MAX_AGENT_ID_LENGTH + 1))).toThrow(
        /Invalid agent ID/,
      );
    });

    test("rejects an agentId that would exceed the Docker container name limit", () => {
      const longId = "a".repeat(MAX_AGENT_ID_LENGTH + 1);
      expect(() => getContainerName(longId)).toThrow(/Invalid agent ID/);
    });
  });

  // -------------------------------------------------------------------------
  describe("validateContainerName", () => {
    test("accepts Docker-safe names", () => {
      expect(() => validateContainerName("agent-abc_123.def")).not.toThrow();
    });

    test("rejects invalid leading characters", () => {
      expect(() => validateContainerName("-bad")).toThrow(/Invalid container name/);
    });
  });

  // -------------------------------------------------------------------------
  describe("getVolumePath / validateVolumePath", () => {
    test("returns the correct path for a valid agentId", () => {
      expect(getVolumePath("abc-123")).toBe("/data/agents/abc-123");
    });

    test("returns the correct path for a UUID-style agentId", () => {
      const agentId = "550e8400-e29b-41d4-a716-446655440000";
      expect(getVolumePath(agentId)).toBe(`/data/agents/${agentId}`);
    });

    test("throws for an invalid agentId (has dots)", () => {
      expect(() => getVolumePath("agent.1")).toThrow(/Invalid agent ID/);
    });

    test("rejects traversal and repeated separators", () => {
      expect(() => validateVolumePath("/data//agents/test")).toThrow(/normalized/);
      expect(() => validateVolumePath("/data/../agents/test")).toThrow(/normalized/);
    });
  });

  // -------------------------------------------------------------------------
  describe("parseDockerNodes", () => {
    let savedAgentEnv: string | undefined;
    let savedContainersEnv: string | undefined;

    beforeEach(() => {
      savedAgentEnv = process.env.AGENT_DOCKER_NODES;
      savedContainersEnv = process.env.CONTAINERS_DOCKER_NODES;
      delete process.env.CONTAINERS_DOCKER_NODES;
    });

    afterEach(() => {
      if (savedAgentEnv === undefined) {
        delete process.env.AGENT_DOCKER_NODES;
      } else {
        process.env.AGENT_DOCKER_NODES = savedAgentEnv;
      }
      if (savedContainersEnv === undefined) {
        delete process.env.CONTAINERS_DOCKER_NODES;
      } else {
        process.env.CONTAINERS_DOCKER_NODES = savedContainersEnv;
      }
    });

    test("parses a single valid node", () => {
      process.env.AGENT_DOCKER_NODES = "node1:192.168.1.1:8";
      const nodes = parseDockerNodes();
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toEqual({
        nodeId: "node1",
        hostname: "192.168.1.1",
        capacity: 8,
      });
    });

    test("parses multiple valid nodes", () => {
      process.env.AGENT_DOCKER_NODES = "n1:h1:4,n2:h2:8";
      const nodes = parseDockerNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[0]).toEqual({ nodeId: "n1", hostname: "h1", capacity: 4 });
      expect(nodes[1]).toEqual({ nodeId: "n2", hostname: "h2", capacity: 8 });
    });

    test("skips malformed entries and keeps valid ones", () => {
      process.env.AGENT_DOCKER_NODES = "n1:h1:4,bad-entry,n2:h2:8";
      const nodes = parseDockerNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.nodeId).toBe("n1");
      expect(nodes[1]!.nodeId).toBe("n2");
    });

    test("throws when env var is not set", () => {
      delete process.env.AGENT_DOCKER_NODES;
      delete process.env.CONTAINERS_DOCKER_NODES;
      expect(() => parseDockerNodes()).toThrow(/No seed nodes configured/);
    });

    test("throws when all entries are invalid", () => {
      process.env.AGENT_DOCKER_NODES = "bad,also-bad,still-bad";
      expect(() => parseDockerNodes()).toThrow(/No valid nodes parsed/);
    });

    test("returns cached result on repeated calls with same env value", () => {
      process.env.AGENT_DOCKER_NODES = "node1:10.0.0.1:4";
      const first = parseDockerNodes();
      const second = parseDockerNodes();
      expect(first).toBe(second);
    });
  });

  // -------------------------------------------------------------------------
  describe("createSandboxProvider factory", () => {
    test("returns DockerSandboxProvider", () => {
      const result = runSandboxProviderFactory();
      if (result.ok) {
        expect(result.name).toBe("DockerSandboxProvider");
      } else {
        throw new Error(`Expected DockerSandboxProvider, got error: ${result.message}`);
      }
    });
  });
});
