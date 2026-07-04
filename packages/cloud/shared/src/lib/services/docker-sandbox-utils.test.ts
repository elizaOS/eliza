// Exercises docker sandbox utils behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  allocatePort,
  dockerPlatformFlag,
  extractDockerCreateContainerId,
  getContainerName,
  getVolumePath,
  inferArchitectureFromHetznerServerType,
  isArchitectureCompatibleWithPlatform,
  normalizeDockerArchitecture,
  readDockerHostPortFromMetadata,
  requiredArchitectureForPlatform,
  requiresDockerHostGateway,
  resolveStewardContainerUrl,
  shellQuote,
  validateAgentId,
  validateContainerName,
  validateEnvKey,
  validateEnvValue,
  validateVolumePath,
} from "./docker-sandbox-utils";

/**
 * These helpers build the shell commands and Docker arguments that provision
 * untrusted agent sandboxes on remote nodes. Every validator here is a shell-
 * injection / path-traversal boundary: a gap lets an agent id or env value
 * break out of single-quoting and run arbitrary commands on the host.
 */

describe("shellQuote", () => {
  test("wraps in single quotes and neutralizes embedded quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    // a closing quote + injected command must be defused, not passed through.
    expect(shellQuote("a'; rm -rf /")).toBe(`'a'"'"'; rm -rf /'`);
  });
});

describe("validateAgentId / validateContainerName", () => {
  test("rejects shell metacharacters, control chars, and overflow", () => {
    expect(() => validateAgentId("good-agent_1")).not.toThrow();
    expect(() => validateAgentId("")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("a;b")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("a\nb")).toThrow(/Invalid agent ID/);
    expect(() => validateAgentId("x".repeat(200))).toThrow(/Invalid agent ID/);
  });

  test("container name must start alphanumeric and stay shell-safe", () => {
    expect(() => validateContainerName("agent-abc.1")).not.toThrow();
    expect(() => validateContainerName("-bad")).toThrow();
    expect(() => validateContainerName("has space")).toThrow();
  });
});

describe("validateEnvKey / validateEnvValue", () => {
  test("keys must be identifier-shaped", () => {
    expect(() => validateEnvKey("MY_KEY")).not.toThrow();
    expect(() => validateEnvKey("_x1")).not.toThrow();
    expect(() => validateEnvKey("1BAD")).toThrow(/Invalid environment variable key/);
    expect(() => validateEnvKey("BAD-KEY")).toThrow(/Invalid environment variable key/);
  });

  test("values reject control chars (newline-injected payloads)", () => {
    expect(() => validateEnvValue("K", "a normal value")).not.toThrow();
    expect(() => validateEnvValue("K", "line1\nline2")).toThrow(/contains control characters/);
  });
});

describe("validateVolumePath", () => {
  test("requires absolute, normalized, traversal-free paths", () => {
    expect(() => validateVolumePath("/data/agents/x")).not.toThrow();
    expect(() => validateVolumePath("relative/path")).toThrow();
    expect(() => validateVolumePath("/")).toThrow();
    expect(() => validateVolumePath("/data/../etc")).toThrow(/normalized/);
    expect(() => validateVolumePath("/data//x")).toThrow(/normalized/);
    expect(() => validateVolumePath("/data/x/")).toThrow(/normalized/);
  });
});

describe("getContainerName / getVolumePath", () => {
  test("derive deterministic, validated names from agent id", () => {
    expect(getContainerName("abc123")).toBe("agent-abc123");
    expect(getVolumePath("abc123")).toBe("/data/agents/abc123");
    expect(() => getContainerName("bad;id")).toThrow();
  });
});

describe("architecture inference", () => {
  test("normalizes arch aliases", () => {
    expect(normalizeDockerArchitecture("x86_64")).toBe("amd64");
    expect(normalizeDockerArchitecture("aarch64")).toBe("arm64");
    expect(normalizeDockerArchitecture("mips")).toBeNull();
    expect(normalizeDockerArchitecture(null)).toBeNull();
  });

  test("Hetzner CAX → arm64, CX/CPX/CCX → amd64", () => {
    expect(inferArchitectureFromHetznerServerType("cax21")).toBe("arm64");
    expect(inferArchitectureFromHetznerServerType("cpx31")).toBe("amd64");
    expect(inferArchitectureFromHetznerServerType("unknown")).toBeNull();
  });

  test("platform requirement + compatibility", () => {
    expect(requiredArchitectureForPlatform("linux/arm64")).toBe("arm64");
    expect(isArchitectureCompatibleWithPlatform("amd64", "linux/amd64")).toBe(true);
    expect(isArchitectureCompatibleWithPlatform("amd64", "linux/arm64")).toBe(false);
    // unknown arch or platform is treated as compatible (no false negatives).
    expect(isArchitectureCompatibleWithPlatform(null, "linux/arm64")).toBe(true);
  });
});

describe("dockerPlatformFlag", () => {
  test("empty → no flag, valid → quoted flag, invalid → throws", () => {
    expect(dockerPlatformFlag(undefined)).toEqual([]);
    expect(dockerPlatformFlag("linux/amd64")).toEqual(["--platform 'linux/amd64'"]);
    expect(() => dockerPlatformFlag("linux/amd64; evil")).toThrow(/Invalid Docker platform/);
  });
});

describe("extractDockerCreateContainerId", () => {
  test("picks the hex id line, ignores warnings, truncates to 12", () => {
    const out = "WARNING: something\n" + "a".repeat(64);
    expect(extractDockerCreateContainerId(out)).toBe("aaaaaaaaaaaa");
    expect(() => extractDockerCreateContainerId("no id here")).toThrow(/invalid container id/);
  });
});

describe("steward url + host gateway routing", () => {
  test("loopback host rewrites to host.docker.internal, override wins", () => {
    expect(resolveStewardContainerUrl("http://localhost:8787/steward")).toBe(
      "http://host.docker.internal:8787/steward",
    );
    expect(resolveStewardContainerUrl("https://api.example.com/steward")).toBe(
      "https://api.example.com/steward",
    );
    expect(resolveStewardContainerUrl("http://localhost/x", "http://override/")).toBe(
      "http://override",
    );
    expect(() => resolveStewardContainerUrl("not a url")).toThrow(/Invalid STEWARD_API_URL/);
  });

  test("requiresDockerHostGateway only for host.docker.internal", () => {
    expect(requiresDockerHostGateway("http://host.docker.internal:1/x")).toBe(true);
    expect(requiresDockerHostGateway("http://example.com")).toBe(false);
    expect(requiresDockerHostGateway("garbage")).toBe(false);
  });
});

describe("port + metadata helpers", () => {
  test("allocatePort stays in range and avoids the exclusion set", () => {
    const excluded = new Set([5000, 5001, 5002]);
    for (let i = 0; i < 20; i++) {
      const port = allocatePort(5000, 5010, excluded);
      expect(port).toBeGreaterThanOrEqual(5000);
      expect(port).toBeLessThan(5010);
      expect(excluded.has(port)).toBe(false);
    }
    // fully exhausted range throws rather than looping forever.
    const full = new Set([5000, 5001]);
    expect(() => allocatePort(5000, 5002, full)).toThrow(/No available ports/);
  });

  test("readDockerHostPortFromMetadata returns positive ints only", () => {
    expect(readDockerHostPortFromMetadata({ hostPort: 8080 })).toBe(8080);
    expect(readDockerHostPortFromMetadata({ hostPort: -1 })).toBeNull();
    expect(readDockerHostPortFromMetadata({ hostPort: "80" })).toBeNull();
    expect(readDockerHostPortFromMetadata(null)).toBeNull();
  });
});
