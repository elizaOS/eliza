import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import {
  closeDb,
  createPGLiteDb,
  getDb,
  setPGLiteOverride,
  tenantConfigs,
  tenants,
} from "@stwd/db";
import { eq } from "drizzle-orm";

const PLATFORM_KEY = "platform-email-config-key";
const TENANT_ID = "platform-email-config-tenant";

describe("platform tenant email config routes", () => {
  let platformRoutes: Awaited<typeof import("../routes/platform")>["platformRoutes"];

  beforeAll(async () => {
    process.env.STEWARD_PGLITE_MEMORY = "true";
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/steward";
    process.env.STEWARD_MASTER_PASSWORD = "platform-email-config-master-password";
    process.env.STEWARD_PLATFORM_KEYS = PLATFORM_KEY;

    const { db, client } = await createPGLiteDb("memory://");
    setPGLiteOverride(db, async () => {
      await client.close();
    });

    const dbHandle = getDb();
    await dbHandle.insert(tenants).values({
      id: TENANT_ID,
      name: "Platform Email Config Tenant",
      apiKeyHash: "hash",
    });

    ({ platformRoutes } = await import("../routes/platform"));
  });

  afterAll(async () => {
    await closeDb();
    delete process.env.STEWARD_PGLITE_MEMORY;
    delete process.env.DATABASE_URL;
    delete process.env.STEWARD_MASTER_PASSWORD;
    delete process.env.STEWARD_PLATFORM_KEYS;
  });

  it("patches, reads, and deletes tenant email config", async () => {
    const patchResponse = await platformRoutes.request(`/tenants/${TENANT_ID}/email-config`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({
        apiKey: "tenant-resend-api-key",
        from: "Tenant <login@tenant.example.com>",
        replyTo: "help@tenant.example.com",
        templateId: "elizacloud",
        subjectOverride: "Tenant Sign In",
      }),
    });

    expect(patchResponse.status).toBe(200);
    const patchBody = (await patchResponse.json()) as {
      ok: boolean;
      data: {
        from: string;
        replyTo?: string;
        templateId?: string;
        subjectOverride?: string;
        hasApiKey: boolean;
      };
    };
    expect(patchBody.ok).toBe(true);
    expect(patchBody.data.hasApiKey).toBe(true);
    expect(patchBody.data.from).toBe("Tenant <login@tenant.example.com>");

    const dbHandle = getDb();
    const [storedConfig] = await dbHandle
      .select({ emailConfig: tenantConfigs.emailConfig })
      .from(tenantConfigs)
      .where(eq(tenantConfigs.tenantId, TENANT_ID));
    expect(storedConfig?.emailConfig?.apiKeyEncrypted).toBeDefined();
    expect(storedConfig?.emailConfig?.apiKeyEncrypted).not.toContain("tenant-resend-api-key");

    const getResponse = await platformRoutes.request(`/tenants/${TENANT_ID}/email-config`, {
      headers: {
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
    });

    expect(getResponse.status).toBe(200);
    const getBody = (await getResponse.json()) as {
      ok: boolean;
      data: {
        emailConfig: {
          from: string;
          replyTo?: string;
          templateId?: string;
          subjectOverride?: string;
        } | null;
        hasApiKey: boolean;
      };
    };
    expect(getBody.ok).toBe(true);
    expect(getBody.data.hasApiKey).toBe(true);
    expect(getBody.data.emailConfig).toEqual({
      provider: "resend",
      from: "Tenant <login@tenant.example.com>",
      replyTo: "help@tenant.example.com",
      templateId: "elizacloud",
      subjectOverride: "Tenant Sign In",
    });

    const deleteResponse = await platformRoutes.request(`/tenants/${TENANT_ID}/email-config`, {
      method: "DELETE",
      headers: {
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
    });

    expect(deleteResponse.status).toBe(200);
    const deleteBody = (await deleteResponse.json()) as { ok: boolean };
    expect(deleteBody.ok).toBe(true);

    const [afterDelete] = await dbHandle
      .select({ emailConfig: tenantConfigs.emailConfig })
      .from(tenantConfigs)
      .where(eq(tenantConfigs.tenantId, TENANT_ID));
    expect(afterDelete?.emailConfig ?? null).toBeNull();
  });
});
