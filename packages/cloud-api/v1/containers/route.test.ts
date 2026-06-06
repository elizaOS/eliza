import { beforeEach, describe, expect, mock, test } from "bun:test";
import { type Context, Hono } from "hono";

type TestVariables = {
  authMethod?: "api_key" | "session";
  apiKeyId?: string;
  apiKeyPermissions?: string[];
  user?: { id: string; organization_id: string };
};

type ContainerBody = {
  data: Record<string, unknown>;
};

type ContainersBody = {
  data: Record<string, unknown>[];
};

/**
 * Auth resolution sets the API-key context the same way the real
 * `requireUserOrApiKeyWithOrg` does: `authMethod` + `apiKeyPermissions` come
 * from the validated key, NOT from a route-level middleware. The route enforces
 * the scope INSIDE the handler via the REAL `enforceApiKeyPermission`, so this
 * mock populates the context for that check to fire. A handler that forgot to
 * call `enforceApiKeyPermission` after auth would fail the 403 tests below —
 * which is the production regression this suite must catch.
 */
const requireUserOrApiKeyWithOrg = mock(
  async (c: Context<{ Variables: TestVariables }>) => {
    const permissionsHeader = c.req.header("x-test-api-key-permissions");
    if (permissionsHeader !== undefined) {
      c.set("authMethod", "api_key");
      c.set("apiKeyId", "key-1");
      c.set(
        "apiKeyPermissions",
        permissionsHeader
          .split(",")
          .map((permission: string) => permission.trim())
          .filter(Boolean),
      );
    } else {
      c.set("authMethod", "session");
    }
    c.set("user", { id: "user-1", organization_id: "org-1" });
    return { id: "user-1", organization_id: "org-1" };
  },
);

const listByOrganization = mock();
const getById = mock();
const getActiveByProjectName = mock();
const checkQuota = mock();
const createContainer = mock();
const codingContainerImageAllowlist = mock(() => ["ghcr.io/elizaos/*"]);
const auditEmit = mock(async () => undefined);

// Use the REAL enforceApiKeyPermission / requireApiKeyPermission from
// `@/api-app/middleware/auth`; only stub its audit dependency so a denied
// request does not need a live dispatcher.
mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: auditEmit }),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
  // `auth.ts` imports this at module top level (used only by the global gate,
  // which this suite never invokes) — provide a stub so the module loads.
  getCurrentUser: mock(async () => null),
}));

mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    codingContainerImageAllowlist,
  },
}));

mock.module("@/lib/services/coding-containers", () => ({
  isCodingContainerImageAllowed: (image: string, allowlist: string[]) =>
    allowlist.some((pattern) =>
      pattern.endsWith("*")
        ? image.startsWith(pattern.slice(0, -1))
        : image === pattern,
    ),
}));

mock.module("@/lib/services/containers", () => ({
  containersService: {
    listByOrganization,
    getById,
    getActiveByProjectName,
    checkQuota,
  },
}));

mock.module("@/lib/services/containers/hetzner-client/client", () => ({
  getHetznerContainersClient: () => ({
    createContainer,
  }),
}));

mock.module("@/lib/services/containers/hetzner-client/types", () => ({
  HetznerClientError: class HetznerClientError extends Error {
    code = "invalid_input";
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: containersRoute } = await import("./route");

const app = new Hono<{ Variables: TestVariables }>();
app.route("/api/v1/containers", containersRoute);

function rawContainer() {
  return {
    id: "container-1",
    name: "App",
    project_name: "app",
    description: "test app",
    organization_id: "org-1",
    user_id: "user-1",
    api_key_id: "key-secret",
    character_id: null,
    load_balancer_url: "https://app.example",
    public_hostname: "app.containers.example",
    status: "running",
    image_tag: "ghcr.io/elizaos/app:latest",
    environment_vars: { OPENAI_API_KEY: "secret" },
    desired_count: 1,
    cpu: 1792,
    memory: 1792,
    port: 3000,
    health_check_path: "/health",
    node_id: "node-secret",
    volume_path: "/var/lib/private",
    volume_size_gb: 10,
    hcloud_volume_id: 123,
    volume_location: "fsn1",
    last_deployed_at: new Date("2026-06-05T12:00:00.000Z"),
    last_health_check: null,
    deployment_log: "contains internal pull output",
    deployment_log_storage: "inline",
    deployment_log_key: "logs/private",
    error_message: null,
    metadata: { hostname: "internal-host" },
    last_billed_at: null,
    next_billing_at: null,
    billing_status: "active",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    total_billed: "0.00",
    created_at: new Date("2026-06-05T12:00:00.000Z"),
    updated_at: new Date("2026-06-05T12:00:00.000Z"),
  };
}

// Shape the Hetzner client returns from createContainer (sparse provisioning
// summary — camelCase, no secret/infra columns).
function summaryContainer() {
  return {
    id: "container-1",
    name: "App",
    projectName: "app",
    status: "pending",
    publicUrl: null,
    image: "ghcr.io/elizaos/app:latest",
    createdAt: new Date("2026-06-05T12:00:00.000Z"),
    updatedAt: new Date("2026-06-05T12:00:00.000Z"),
    errorMessage: null,
    metadata: { hostname: "internal-host" },
  };
}

describe("containers route", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    listByOrganization.mockReset();
    getById.mockReset();
    getActiveByProjectName.mockReset();
    checkQuota.mockReset();
    createContainer.mockReset();
    codingContainerImageAllowlist.mockClear();
    auditEmit.mockClear();
  });

  test("rejects an API key without containers:read on list (real enforcement)", async () => {
    const response = await app.request("/api/v1/containers", {
      headers: { "x-test-api-key-permissions": "agents:read" },
    });

    expect(response.status).toBe(403);
    // The handler reached enforceApiKeyPermission AFTER auth resolved; if it
    // skipped enforcement the data service would have been hit.
    expect(listByOrganization).not.toHaveBeenCalled();
    expect(auditEmit).toHaveBeenCalledTimes(1);
  });

  test("allows a wildcard-scoped API key and returns CloudContainer data", async () => {
    listByOrganization.mockResolvedValue([rawContainer()]);

    const response = await app.request("/api/v1/containers", {
      headers: { "x-test-api-key-permissions": "containers:*" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ContainersBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: "container-1",
      name: "App",
      status: "running",
      image_tag: "ghcr.io/elizaos/app:latest",
      created_at: "2026-06-05T12:00:00.000Z",
    });
  });

  test("redacts secret and infrastructure fields from list responses", async () => {
    listByOrganization.mockResolvedValue([rawContainer()]);

    const response = await app.request("/api/v1/containers", {
      headers: { "x-test-api-key-permissions": "containers:read" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ContainersBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty("environment_vars");
    expect(body.data[0]).not.toHaveProperty("deployment_log");
    expect(body.data[0]).not.toHaveProperty("metadata");
    expect(body.data[0]).not.toHaveProperty("api_key_id");
    expect(body.data[0]).not.toHaveProperty("node_id");
    expect(body.data[0]).not.toHaveProperty("volume_path");
    expect(body.data[0]).not.toHaveProperty("organization_id");
    expect(body.data[0]).not.toHaveProperty("user_id");
  });

  test("rejects an API key without containers:deploy on POST (real enforcement)", async () => {
    const response = await app.request("/api/v1/containers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-api-key-permissions": "containers:read",
      },
      body: JSON.stringify({
        name: "App",
        image: "ghcr.io/elizaos/app:latest",
      }),
    });

    expect(response.status).toBe(403);
    expect(getActiveByProjectName).not.toHaveBeenCalled();
    expect(createContainer).not.toHaveBeenCalled();
  });

  test("provisions and returns the deployed container under `data`", async () => {
    getActiveByProjectName.mockResolvedValue(null);
    checkQuota.mockResolvedValue({ allowed: true });
    createContainer.mockResolvedValue(summaryContainer());

    const response = await app.request("/api/v1/containers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-api-key-permissions": "containers:deploy",
      },
      body: JSON.stringify({
        name: "App",
        image: "ghcr.io/elizaos/app:latest",
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as ContainerBody;
    expect(body.data).toMatchObject({
      id: "container-1",
      name: "App",
      project_name: "app",
      status: "pending",
    });
    expect(body.data).not.toHaveProperty("environment_vars");
    expect(body.data).not.toHaveProperty("metadata");
    expect(createContainer).toHaveBeenCalledTimes(1);
  });

  test("is idempotent: returns the existing active container with 200", async () => {
    getActiveByProjectName.mockResolvedValue(rawContainer());

    const response = await app.request("/api/v1/containers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-api-key-permissions": "containers:deploy",
      },
      body: JSON.stringify({
        name: "App",
        projectName: "app",
        image: "ghcr.io/elizaos/app:latest",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ContainerBody;
    expect(body.data).toMatchObject({ id: "container-1", status: "running" });
    // No duplicate provisioning, and no quota burn for an already-live deploy.
    expect(createContainer).not.toHaveBeenCalled();
    expect(checkQuota).not.toHaveBeenCalled();
  });
});
