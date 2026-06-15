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
  const ssh: AppContainerSsh = {
    async exec(command) {
      calls.push(command);
      if (command.startsWith("docker create")) return create;
      return "";
    },
  };
  return { calls, ssh };
}

describe("AppContainerProvider.provision", () => {
  test("ensures the --internal network, creates, starts, and returns the id", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
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

    // network ensured first; a docker-ps probe runs for collision-safe ports
    expect(calls[0]).toContain("docker network create --driver bridge --internal");
    expect(calls.some((c) => c.startsWith("docker ps"))).toBe(true);
    const createCmd = calls.find((c) => c.startsWith("docker create")) ?? "";
    expect(createCmd).toContain("--cap-drop=ALL");
    expect(createCmd).toContain("-p 49001:3000");
    expect(createCmd).toContain("HTTP_PROXY=http://egress-gw:3128");
    expect(createCmd).not.toContain("NET_ADMIN");
    expect(calls).toContain("docker start 'app-nubilio'");
  });

  test("picks a host port not already in use on the node (collision-safe)", async () => {
    // node already has 30000 published; allocator hands out 30000 then 31000
    const ports = [30000, 31000];
    let i = 0;
    const ssh = {
      async exec(command: string) {
        if (command.startsWith("docker ps")) return "0.0.0.0:30000->3000/tcp, :::30000->3000/tcp";
        if (command.startsWith("docker create")) return "cid";
        return "";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
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

  test("provision with DATABASE_URL + POSTGRES_URL stands up the ambassador + rewrites BOTH", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({ ssh, allocateHostPort: async () => 49002 });

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
    const createCmd = calls.find((c) => c.startsWith("docker create")) ?? "";
    expect(createCmd).toContain(
      "DATABASE_URL=postgresql://app_x:p%40ss@app-db-111111112222:5432/db_app_x?sslmode=require",
    );
    expect(createCmd).toContain(
      "POSTGRES_URL=postgresql://app_x:p%40ss@app-db-111111112222:5432/db_app_x?sslmode=require",
    );
    // neither var still points at the real cluster host (both rewritten to the ambassador)
    expect(createCmd).not.toContain("@10.43.0.10:5432");
  });

  test("lifecycle verbs issue the expected docker commands", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({ ssh, allocateHostPort: async () => 1 });
    await provider.delete("app-x");
    await provider.restart("app-x");
    await provider.logs("app-x", 50);
    expect(calls).toEqual([
      "docker rm -f 'app-x'",
      "docker rm -f 'app-db-x' >/dev/null 2>&1 || true",
      "docker restart 'app-x'",
      "docker logs --tail 50 'app-x'",
    ]);
  });
});
