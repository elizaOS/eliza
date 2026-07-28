// Exercises app container provider behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { AppContainerProvider, type AppContainerSsh } from "../app-container-provider";
import type { CreateContainerInput } from "../containers/hetzner-client/types";

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
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async () => {},
      egressProxyUrl: "http://egress-gw:3128",
    });

    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });

    expect(result.containerId).toBe("containerid-abc123");
    expect(result.hostPort).toBe(39001);
    expect(result.network).toMatch(/^app-net-/);

    // Network setup precedes the atomically reserved Docker create.
    expect(calls[0]).toContain("docker network create --driver bridge --internal");
    const createCmd = calls.find((c) => c.startsWith("docker create")) ?? "";
    expect(createCmd).toContain("--cap-drop=ALL");
    // Host port is bound to loopback only (ingress/proxy reaches it via
    // 127.0.0.1 on the node) — never exposed on the node's public interface.
    expect(createCmd).toContain("-p 127.0.0.1:39001:3000");
    expect(createCmd).toContain("HTTP_PROXY=http://egress-gw:3128");
    expect(createCmd).not.toContain("NET_ADMIN");
    expect(calls).toContain("docker start 'app-nubilio'");
  });

  test("removes any stale container by name BEFORE docker create (redeploy self-heal)", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async () => {},
    });

    await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });

    const rmIdx = calls.indexOf("docker rm -f 'app-nubilio'");
    const createIdx = calls.findIndex((c) => c.startsWith("docker create"));
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
        if (command.startsWith("docker create")) return "cid";
        return "";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async () => {},
    });
    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: INPUT,
    });
    // rm failed, but inspect proved the name absent before create continued.
    expect(result.containerId).toBe("cid");
    expect(calls.some((c) => c.startsWith("docker create"))).toBe(true);
  });

  test("an uninspectable pre-clean target blocks provisioning", async () => {
    const ssh: AppContainerSsh = {
      async exec(command) {
        if (command.startsWith("docker rm -f")) throw new Error("ssh write failed");
        if (command.startsWith("docker inspect")) throw new Error("ssh read failed");
        return "";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async () => {},
    });

    await expect(
      provider.provision({ appId: APP_ID, containerName: "app-nubilio", input: INPUT }),
    ).rejects.toThrow("Could not prove Docker container app-nubilio is absent");
  });

  test("uses the exact atomically reserved host port", async () => {
    const { ssh } = recordingSsh("cid");
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async (ownerId) => {
        expect(ownerId).toBe("app-x");
        return 31000;
      },
      releaseHostPort: async () => {},
    });
    const result = await provider.provision({
      appId: APP_ID,
      containerName: "app-x",
      input: INPUT,
    });
    expect(result.hostPort).toBe(31000);
  });

  test("a start failure propagates to the executor cleanup boundary", async () => {
    const calls: string[] = [];
    const ssh: AppContainerSsh = {
      async exec(command) {
        calls.push(command);
        if (command.startsWith("docker create")) return "cid";
        if (command.startsWith("docker start")) throw new Error("start failed");
        return "";
      },
    };
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async () => {},
    });

    await expect(
      provider.provision({ appId: APP_ID, containerName: "app-nubilio", input: INPUT }),
    ).rejects.toThrow("start failed");
    expect(calls.filter((command) => command === "docker rm -f 'app-nubilio'")).toHaveLength(1);
  });

  test("provision with DATABASE_URL + POSTGRES_URL stands up the ambassador + rewrites BOTH", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39002,
      releaseHostPort: async () => {},
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
    const released: string[] = [];
    const provider = new AppContainerProvider({
      ssh,
      nodeId: "node-1",
      reserveHostPort: async () => 39001,
      releaseHostPort: async (ownerId) => {
        released.push(ownerId);
      },
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
    expect(released).toEqual(["app-x", "app-x"]);
  });
});
