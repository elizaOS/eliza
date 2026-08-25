/** Exercises the deterministic app Docker stdin plan without reaching Docker or SSH. */
import { describe, expect, test } from "bun:test";
import { buildAppDockerCreateCmd } from "../app-docker-cmd";
import type { CreateContainerInput } from "../containers/hetzner-client/types";

const APP_ID = "11111111-2222-3333-4444-555555555555";

function input(over: Partial<CreateContainerInput> = {}): CreateContainerInput {
  return {
    name: "nubilio-web",
    projectName: "nubilio",
    organizationId: "org-1",
    userId: "user-1",
    image: "ghcr.io/nubs/nubilio:latest",
    port: 3000,
    desiredCount: 1,
    cpu: 1024,
    memoryMb: 512,
    healthCheckPath: "/health",
    ...over,
  };
}

function build(over: Partial<CreateContainerInput> = {}, egress?: string) {
  return buildAppDockerCreateCmd({
    appId: APP_ID,
    containerName: "app-nubilio",
    input: input(over),
    hostPort: 49001,
    egressProxyUrl: egress,
  });
}

describe("buildAppDockerCreateCmd", () => {
  test("puts the container on its own --internal app network", () => {
    const { command: cmd } = build();
    expect(cmd).toMatch(/--network 'app-net-[a-z0-9]+'/);
    expect(cmd).not.toContain("containers-isolated");
  });

  test("hardens the container and NEVER uses the agent escapes", () => {
    const { command: cmd } = build();
    expect(cmd).toContain("--cap-drop=ALL");
    expect(cmd).toContain("no-new-privileges");
    expect(cmd).toContain("--pids-limit=512");
    expect(cmd).not.toContain("NET_ADMIN");
    expect(cmd).not.toContain("/dev/net/tun");
    expect(cmd).not.toContain("--privileged");
    expect(cmd).not.toContain("host.docker.internal");
    // no eliza scaffolding mounts
    expect(cmd).not.toContain("/root/.eliza");
  });

  test("maps the host port, sets memory, and runs the requested image", () => {
    const { command: cmd } = build();
    expect(cmd).toContain("-p 127.0.0.1:49001:3000");
    expect(cmd).toContain("--memory '512m'");
    expect(cmd).toContain("'ghcr.io/nubs/nubilio:latest'");
  });

  test("publishes ONLY to loopback so the port is not reachable across the private network", () => {
    const { command: cmd } = build();
    // The published mapping must be loopback-scoped, never a bare/0.0.0.0 bind
    // (a bare `-p host:container` binds 0.0.0.0 -> cross-tenant ingress bypass).
    expect(cmd).toContain("-p 127.0.0.1:49001:3000");
    expect(cmd).not.toMatch(/-p (?!127\.0\.0\.1:)/);
    expect(cmd).not.toContain("-p 0.0.0.0:");
  });

  test("caps CPU and pins swap to the memory limit (untrusted-tenant DoS guards)", () => {
    // 1024 ECS units = 1 full vCPU.
    expect(build().command).toContain("--cpus 1");
    // Fractional + multi-vCPU allocations convert cleanly.
    expect(build({ cpu: 512 }).command).toContain("--cpus 0.5");
    expect(build({ cpu: 2048 }).command).toContain("--cpus 2");
    // Swap pinned to the memory limit (no swap escape of the --memory ceiling).
    expect(build().command).toContain("--memory-swap '512m'");
  });

  test("never auto-injects DATABASE_URL and keeps a caller DSN off argv", () => {
    expect(build().command).not.toContain("DATABASE_URL");
    const dsn = "postgresql://app_x:pw@apps-cluster-1/db_app_x?sslmode=require";
    const withDb = build({ environmentVars: { DATABASE_URL: dsn } });
    expect(withDb.command).toContain('--env-file "$env_file"');
    expect(withDb.command).not.toContain("DATABASE_URL");
    expect(withDb.command).not.toContain(dsn);
    expect(withDb.input).toContain("DATABASE_URL");
    expect(withDb.input).toContain(dsn);
  });

  test("keeps arbitrary caller keys and values out of Docker argv", () => {
    const key = "CUSTOM_API_TOKEN";
    const value = "app-secret-argv-sentinel";
    const transport = build({ environmentVars: { [key]: value } });

    expect(transport.command).not.toContain(key);
    expect(transport.command).not.toContain(value);
    expect(transport.input).toContain(key);
    expect(transport.input).toContain(value);
  });

  test("routes egress through the proxy when one is given", () => {
    const transport = build({}, "http://egress-gw:3128");
    expect(transport.command).not.toContain("HTTP_PROXY");
    expect(transport.command).not.toContain("http://egress-gw:3128");
    expect(transport.input).toContain("HTTP_PROXY=http://egress-gw:3128");
    expect(transport.input).toContain("HTTPS_PROXY=http://egress-gw:3128");
  });

  test("preserves caller PORT precedence while infrastructure egress wins", () => {
    const transport = build(
      {
        environmentVars: {
          PORT: "4444",
          HTTP_PROXY: "http://caller-proxy:9999",
        },
      },
      "http://egress-gw:3128",
    );

    expect(transport.input).toContain("PORT='4444'");
    expect(transport.input).not.toContain("http://caller-proxy:9999");
    expect(transport.input).toContain("HTTP_PROXY=http://egress-gw:3128");
  });

  test("honors a custom container port and health path", () => {
    const { command: cmd } = build({ port: 8080, healthCheckPath: "/healthz" });
    expect(cmd).toContain("-p 127.0.0.1:49001:8080");
    expect(cmd).toContain("localhost:8080/healthz");
  });
});
