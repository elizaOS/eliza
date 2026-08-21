/** Exercises app container orchestration with a deterministic in-process SSH seam. */
import { describe, expect, test } from "bun:test";
import {
  AppContainerProvider,
  type AppContainerSsh,
  parseUsedHostPorts,
} from "../app-container-provider";
import type { CreateContainerInput } from "../containers/hetzner-client/types";

describe("parseUsedHostPorts", () => {
  test("extracts host ports from `docker ps` Ports output (ipv4 + ipv6 dedup)", () => {
    const out = "0.0.0.0:28123->3000/tcp, :::28123->3000/tcp\n0.0.0.0:30500->80/tcp";
    expect([...parseUsedHostPorts(out)].sort((a, b) => a - b)).toEqual([28123, 30500]);
  });
  test("empty output -> empty set", () => {
    expect(parseUsedHostPorts("").size).toBe(0);
  });
});

const APP_ID = "11111111-2222-3333-4444-555555555555";

const INPUT: CreateContainerInput = {
  name: "nubilio-web",
  projectName: "nubilio",
  organizationId: "org-1",
  userId: "user-1",
  image: "ghcr.io/nubs/nubilio:latest",
  port: 3000,
  desiredCount: 1,
  cpu: 1,
  memoryMb: 512,
  healthCheckPath: "/health",
};

function recordingSsh(create = "containerid-abc123") {
  const calls: string[] = [];
  const stdinCalls: Array<{ command: string; input: string | Buffer }> = [];
  const ssh: AppContainerSsh = {
    async exec(command) {
      calls.push(command);
      return "";
    },
    async execStdin(command, input) {
      calls.push(command);
      stdinCalls.push({ command, input });
      return create;
    },
  };
  return { calls, ssh, stdinCalls };
}

describe("AppContainerProvider.provision", () => {
  test("ensures the --internal network, creates, starts, and returns the id", async () => {
    const { calls, ssh, stdinCalls } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
      egressProxyUrl: "http://egress-gw:3128",
    });

    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });

    expect(result.containerId).toBe("containerid-abc123");
    expect(result.hostPort).toBe(49001);
    expect(result.network).toMatch(/^app-net-/);

    // The collision probe is read-only; the network remains the first remote
    // mutation, followed by stale-name cleanup and the stdin-backed create.
    const psIndex = calls.findIndex((c) => c.startsWith("docker ps"));
    const networkIndex = calls.findIndex((c) =>
      c.includes("docker network create --driver bridge --internal"),
    );
    const removeIndex = calls.indexOf("docker rm -f 'app-nubilio'");
    const createIndex = calls.findIndex((c) => c.includes("docker create"));
    expect(psIndex).toBeGreaterThanOrEqual(0);
    expect(networkIndex).toBeGreaterThan(psIndex);
    expect(removeIndex).toBeGreaterThan(networkIndex);
    expect(createIndex).toBeGreaterThan(removeIndex);
    const createCmd = stdinCalls[0]?.command ?? "";
    const createInput = String(stdinCalls[0]?.input ?? "");
    expect(createCmd).toContain("--cap-drop=ALL");
    // Host port is bound to loopback only (ingress/proxy reaches it via
    // 127.0.0.1 on the node) — never exposed on the node's public interface.
    expect(createCmd).toContain("-p 127.0.0.1:49001:3000");
    expect(createCmd).not.toContain("HTTP_PROXY");
    expect(createCmd).not.toContain("http://egress-gw:3128");
    expect(createInput).toContain("HTTP_PROXY=http://egress-gw:3128");
    expect(createCmd).not.toContain("NET_ADMIN");
    expect(calls).toContain("docker start 'app-nubilio'");
  });

  test("preserves multiline and large app environment through stdin", async () => {
    const { calls, ssh, stdinCalls } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });
    const pem = "-----BEGIN CERTIFICATE-----\nline one\nline two\n-----END CERTIFICATE-----\n";
    const large = "x".repeat(70 * 1024);

    await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: { ...INPUT, environmentVars: { TLS_CERT: pem, LARGE_CONFIG: large } },
    });

    const create = stdinCalls[0];
    expect(create).toBeDefined();
    expect(create?.command).not.toContain("TLS_CERT");
    expect(create?.command).not.toContain(pem);
    expect(create?.command).not.toContain(large);
    expect(String(create?.input)).toContain(pem);
    expect(String(create?.input)).toContain(large);
    expect(calls).toContain("docker start 'app-nubilio'");
  });

  test("rejects an impossible app environment before allocation or remote IO", async () => {
    const { calls, ssh } = recordingSsh();
    let allocations = 0;
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => {
        allocations += 1;
        return 49001;
      },
    });

    await expect(
      provider.provision({
        appId: APP_ID,
        containerName: "app-nubilio",
        input: { ...INPUT, environmentVars: { OVERSIZED: "x".repeat(121 * 1024) } },
      }),
    ).rejects.toThrow(/process entry limit/);

    expect(calls).toEqual([]);
    expect(allocations).toBe(0);
  });

  test("validates the rewritten DSN before creating the network or ambassador", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });
    const dsnPrefix = "postgresql://app:";
    const dsnSuffix = "@x:5432/db";
    const entryLimit = 120 * 1024;
    const paddingLength =
      entryLimit -
      Buffer.byteLength("DATABASE_URL=") -
      Buffer.byteLength(dsnPrefix) -
      Buffer.byteLength(dsnSuffix);
    const boundaryDsn = `${dsnPrefix}${"p".repeat(paddingLength)}${dsnSuffix}`;

    await expect(
      provider.provision({
        appId: APP_ID,
        containerName: "app-nubilio",
        input: { ...INPUT, environmentVars: { DATABASE_URL: boundaryDsn } },
      }),
    ).rejects.toThrow(/process entry limit/);

    expect(calls).toEqual([]);
  });

  test("removes any stale container by name BEFORE docker create (redeploy self-heal)", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });

    await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });

    const rmIdx = calls.indexOf("docker rm -f 'app-nubilio'");
    const createIdx = calls.findIndex((c) => c.includes("docker create"));
    // The idempotent `docker rm -f <name>` is issued, and it precedes the create
    // so the deterministic `app-<slug>` name is free (no 'name already in use').
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(createIdx);
  });

  test("a missing pre-clean target is confirmed absent before provisioning", async () => {
    const calls: string[] = [];
    const ssh: AppContainerSsh = {
      async exec(command) {
        calls.push(command);
        if (command === "docker rm -f 'app-nubilio'") throw new Error("rm failed");
        if (command.startsWith("docker inspect")) throw new Error("No such container");
        return "";
      },
      async execStdin(command) {
        calls.push(command);
        return "cid";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });
    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });
    // rm failed, but inspect proved the name absent before create continued.
    expect(result.containerId).toBe("cid");
    expect(calls.some((c) => c.includes("docker create"))).toBe(true);
  });

  test("an uninspectable pre-clean target blocks provisioning", async () => {
    const ssh: AppContainerSsh = {
      async exec(command) {
        if (command.startsWith("docker rm -f")) throw new Error("ssh write failed");
        if (command.startsWith("docker inspect")) throw new Error("ssh read failed");
        return "";
      },
      async execStdin() {
        return "cid";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });

    await expect(
      provider.provision({ appId: APP_ID, containerName: "app-nubilio", input: INPUT }),
    ).rejects.toThrow("Could not prove Docker container app-nubilio is absent");
  });

  test("picks a host port not already in use on the node (collision-safe)", async () => {
    // node already has 30000 published; allocator hands out 30000 then 31000
    const ports = [30000, 31000];
    let i = 0;
    const ssh = {
      async exec(command: string) {
        if (command.startsWith("docker ps")) return "0.0.0.0:30000->3000/tcp, :::30000->3000/tcp";
        return "";
      },
      async execStdin() {
        return "cid";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => ports[i++] ?? 39999,
    });
    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-x",
      input: INPUT,
    });
    // skipped the in-use 30000, landed on 31000
    expect(result.hostPort).toBe(31000);
  });

  test("a start failure propagates to the executor cleanup boundary", async () => {
    const calls: string[] = [];
    const ssh: AppContainerSsh = {
      async exec(command) {
        calls.push(command);
        if (command.startsWith("docker start")) throw new Error("start failed");
        return "";
      },
      async execStdin(command) {
        calls.push(command);
        return "cid";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });

    await expect(
      provider.provision({ appId: APP_ID, containerName: "app-nubilio", input: INPUT }),
    ).rejects.toThrow("start failed");
    expect(calls.filter((command) => command === "docker rm -f 'app-nubilio'")).toHaveLength(1);
  });

  test("provision with DATABASE_URL + POSTGRES_URL stands up the ambassador + rewrites BOTH", async () => {
    const { calls, ssh, stdinCalls } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49002,
    });

    await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: {
        ...INPUT,
        environmentVars: {
          DATABASE_URL: "postgresql://app_x:p%40ss@10.43.0.10:5432/db_app_x?sslmode=require",
          POSTGRES_URL: "postgresql://app_x:p%40ss@10.43.0.10:5432/db_app_x?sslmode=require",
        },
      },
    });

    const joined = calls.join("\n");
    // ambassador: rm stale, run socat to the REAL DB, attach to the app net
    expect(joined).toContain("docker run -d --name 'app-db-111111112222'");
    expect(joined).toContain("'TCP:10.43.0.10:5432'");
    expect(joined).toContain("'TCP-LISTEN:5432,fork,reuseaddr'");
    expect(joined).toMatch(/docker network connect 'app-net-\S+' 'app-db-111111112222'/);
    // the app container's DSN host is rewritten to the ambassador (creds/db/params kept)
    const createCmd = stdinCalls[0]?.command ?? "";
    const createInput = String(stdinCalls[0]?.input ?? "");
    expect(createCmd).not.toContain("DATABASE_URL");
    expect(createCmd).not.toContain("POSTGRES_URL");
    expect(createCmd).not.toContain("p%40ss");
    expect(createInput).toContain(
      "DATABASE_URL='postgresql://app_x:p%40ss@app-db-111111112222:5432/db_app_x?sslmode=require'",
    );
    expect(createInput).toContain(
      "POSTGRES_URL='postgresql://app_x:p%40ss@app-db-111111112222:5432/db_app_x?sslmode=require'",
    );
    // neither var still points at the real cluster host (both rewritten to the ambassador)
    expect(createInput).not.toContain("@10.43.0.10:5432");
  });

  test("lifecycle verbs issue the expected docker commands", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 1,
    });
    await provider.delete("app-x");
    await provider.deleteById("docker-immutable-1", "app-x");
    await provider.restart("app-x");
    await provider.logs("app-x", 50);
    expect(calls).toEqual([
      "docker rm -f 'app-x'",
      "docker rm -f 'app-db-x' >/dev/null 2>&1 || true",
      "docker rm -f 'docker-immutable-1'",
      "docker rm -f 'app-db-x' >/dev/null 2>&1 || true",
      "docker restart 'app-x'",
      "docker logs --tail 50 'app-x'",
    ]);
  });
});

describe("AppContainerProvider.deletePrimaryById", () => {
  test("removes only the immutable primary and preserves the shared ambassador", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      allocateHostPort: async () => 49001,
    });

    await provider.deletePrimaryById("docker-stale-1");

    expect(calls).toEqual(["docker rm -f 'docker-stale-1'"]);
  });
});
