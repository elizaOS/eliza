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

    // network ensure first, then create, then start
    expect(calls[0]).toContain("docker network create --driver bridge --internal");
    expect(calls[1]).toContain("docker create");
    expect(calls[1]).toContain("--cap-drop=ALL");
    expect(calls[1]).toContain("-p 49001:3000");
    expect(calls[1]).toContain("HTTP_PROXY=http://egress-gw:3128");
    expect(calls[1]).not.toContain("NET_ADMIN");
    expect(calls[2]).toBe("docker start 'app-nubilio'");
  });

  test("provision with a DATABASE_URL stands up the DB ambassador + rewrites the DSN host", async () => {
    const { calls, ssh } = recordingSsh();
    const provider = new AppContainerProvider({ ssh, allocateHostPort: async () => 49002 });

    await provider.provision({
      appId: APP_ID,
      containerName: "app-nubilio",
      input: {
        ...INPUT,
        environmentVars: {
          DATABASE_URL: "postgresql://app_x:p%40ss@10.43.0.10:5432/db_app_x?sslmode=require",
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
