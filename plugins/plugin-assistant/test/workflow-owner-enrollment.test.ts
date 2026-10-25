import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "vitest";
import { DeviceActionService } from "../src/services/device-actions/service";

test("workflow ownership and paired device identity remain separate and enforced", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      `CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0, view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));`,
    );
    const db = drizzle(pg),
      runtime = { agentId: randomUUID(), adapter: { db } } as any,
      service = new DeviceActionService(runtime),
      canonical = randomUUID(),
      paired = randomUUID(),
      credential = {
        subjectUserId: paired,
        installationId: randomUUID(),
        deviceKey: "a".repeat(64),
      },
      registered = await service.register(
        credential,
        "Synthetic paired owner",
        1,
        canonical,
      ),
      target = {
        installationId: registered.installationId,
        enrollmentId: registered.enrollmentId,
      };
    await service.validateWorkflowTarget(canonical, target);
    const rows = await pg.query(
      "SELECT subject_user_id,workflow_owner_id FROM client_devices",
    );
    expect(rows.rows[0]).toEqual({
      subject_user_id: paired,
      workflow_owner_id: canonical,
    });
    await expect(
      service.validateWorkflowTarget(randomUUID(), target),
    ).rejects.toThrow();
    await expect(
      service.validateWorkflowTarget(canonical, {
        ...target,
        enrollmentId: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      service.validateWorkflowTarget(canonical, target, 2),
    ).rejects.toThrow();
    await expect(
      service.register(
        { ...credential, deviceKey: "c".repeat(64) },
        "Forged rebind",
        1,
        randomUUID(),
      ),
    ).rejects.toThrow();
    await service.validateWorkflowTarget(canonical, target);
    await expect(
      new DeviceActionService({
        ...runtime,
        agentId: randomUUID(),
      }).validateWorkflowTarget(canonical, target),
    ).rejects.toThrow();
    // Installation labels may repeat across authenticated subjects. The exact
    // enrollment remains authoritative even when their workflow owner matches.
    const sibling = await service.register(
      { ...credential, subjectUserId: randomUUID(), deviceKey: "d".repeat(64) },
      "Other authenticated subject",
      1,
      canonical,
    );
    expect(sibling.enrollmentId).not.toBe(target.enrollmentId);
    await service.validateWorkflowTarget(canonical, target);
    await service.validateWorkflowTarget(canonical, {
      installationId: sibling.installationId,
      enrollmentId: sibling.enrollmentId,
    });
    await pg.exec("UPDATE client_devices SET workflow_owner_id=NULL");
    await service.validateWorkflowTarget(paired, target);
    await expect(
      service.validateWorkflowTarget(canonical, target),
    ).rejects.toThrow();
    await service.register(credential, "Synthetic paired owner", 1, canonical);
    await service.register(credential, "Synthetic paired owner", 0, canonical);
    await expect(
      service.validateWorkflowTarget(canonical, target),
    ).rejects.toThrow();
    await service.register(credential, "Synthetic paired owner", 1, canonical);
    await service.revoke(credential);
    await expect(
      service.validateWorkflowTarget(canonical, target),
    ).rejects.toThrow();
  } finally {
    await pg.close();
  }
}, 120000);

import { deterministicOwnerEntityId } from "@elizaos/core";
import { workflowDeviceOwner } from "../../../packages/agent/src/api/workflow-device-owner";

test("only a verified local OWNER may bind the canonical workflow scope", () => {
  const runtime = { agentId: randomUUID(), getSetting: () => null } as any,
    subject = randomUUID(),
    canonical = deterministicOwnerEntityId(runtime.agentId);
  expect(
    workflowDeviceOwner(
      runtime,
      { ok: true, role: "OWNER", identityId: subject } as any,
      subject,
    ),
  ).toBe(canonical);
  for (const role of ["USER", "ADMIN"])
    expect(
      workflowDeviceOwner(
        runtime,
        { ok: true, role, identityId: subject } as any,
        subject,
      ),
    ).toBe(subject);
  expect(
    workflowDeviceOwner(
      runtime,
      {
        ok: true,
        role: "OWNER",
        identityId: subject,
        externalIdentity: { issuer: "synthetic", subject: "synthetic" },
      } as any,
      subject,
    ),
  ).toBe(subject);
  expect(() =>
    workflowDeviceOwner(runtime, { ok: false, role: "NONE" } as any, subject),
  ).toThrow();
  expect(() =>
    workflowDeviceOwner(
      runtime,
      { ok: true, role: "OWNER", identityId: randomUUID() } as any,
      subject,
    ),
  ).toThrow();
});
