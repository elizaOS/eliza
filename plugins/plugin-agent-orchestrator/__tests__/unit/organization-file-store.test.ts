/**
 * Exercises organization persistence against a real temporary filesystem with fault injection.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toOrganizationCommandId,
  toOrganizationId,
  toOrganizationPrincipalId,
  toOrganizationTimestamp,
} from "@elizaos/core/contracts/agent-organization";
import { afterEach, describe, expect, it } from "vitest";
import { FileOrganizationStore } from "../../src/services/organization-file-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function storePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "organization-store-"));
  tempDirs.push(dir);
  return join(dir, "organizations");
}

function createCommand(commandId = "create") {
  return {
    organizationId: toOrganizationId("org-acme"),
    commandId: toOrganizationCommandId(commandId),
    expectedRevision: 0,
    actorPrincipalId: toOrganizationPrincipalId("principal-sponsor"),
    issuedAt: toOrganizationTimestamp("2026-08-27T10:00:00.000Z"),
    command: {
      type: "create_organization" as const,
      name: "Acme agents",
      goal: "Sell elizaOS as an embeddable agentic OS",
    },
  };
}

function organizationDirectory(root: string): string {
  const digest = createHash("sha256").update("org-acme").digest("hex");
  return join(root, digest);
}

function revisionPath(root: string, revision: number): string {
  return join(
    organizationDirectory(root),
    `revision-${revision.toString().padStart(16, "0")}.json`,
  );
}

describe("FileOrganizationStore", () => {
  it("serializes concurrent writers and rejects the stale command", async () => {
    const path = await storePath();
    const first = new FileOrganizationStore(path);
    const second = new FileOrganizationStore(path);
    await first.apply(createCommand());

    const rename = (commandId: string, name: string) => ({
      ...createCommand(commandId),
      expectedRevision: 1,
      command: { type: "rename_organization" as const, name },
    });
    const results = await Promise.allSettled([
      first.apply(rename("rename-a", "Alpha")),
      second.apply(rename("rename-b", "Beta")),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await first.get(toOrganizationId("org-acme")))?.revision).toBe(2);
  });

  it("preserves the previous revision when a candidate write fails", async () => {
    const path = await storePath();
    const healthy = new FileOrganizationStore(path);
    await healthy.apply(createCommand());
    const before = await readFile(revisionPath(path, 1), "utf8");
    const failing = new FileOrganizationStore(path, {
      writeAtomic: async () => {
        throw new Error("injected candidate-write failure");
      },
    });

    await expect(
      failing.apply({
        ...createCommand("rename"),
        expectedRevision: 1,
        command: {
          type: "rename_organization" as const,
          name: "Never committed",
        },
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_STORE_WRITE_FAILED" });

    expect(await readFile(revisionPath(path, 1), "utf8")).toBe(before);
    await expect(readFile(revisionPath(path, 2), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    expect(
      (await healthy.get(toOrganizationId("org-acme")))?.organization.name,
    ).toBe("Acme agents");
  });

  it("replays an exact retry without adding a revision or audit event", async () => {
    const path = await storePath();
    const store = new FileOrganizationStore(path);
    const first = await store.apply(createCommand());
    const restartedStore = new FileOrganizationStore(path);
    const retry = await restartedStore.apply(createCommand());

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.record.revision).toBe(1);
    expect(retry.record.audit).toHaveLength(1);
  });

  it("ignores a stranded candidate and resumes from the published revision", async () => {
    const path = await storePath();
    const store = new FileOrganizationStore(path);
    await store.apply(createCommand());
    await writeFile(
      join(organizationDirectory(path), ".candidate-interrupted.json"),
      '{"incomplete":',
      "utf8",
    );
    const restartedStore = new FileOrganizationStore(path);

    const retry = await restartedStore.apply(createCommand());

    expect(retry.replayed).toBe(true);
    expect(retry.record.revision).toBe(1);
  });

  it("translates revision publication failures into a typed store error", async () => {
    const path = await storePath();
    const store = new FileOrganizationStore(path, {
      publishRevision: async () => {
        throw Object.assign(new Error("injected publication failure"), {
          code: "EIO",
        });
      },
    });

    await expect(store.apply(createCommand())).rejects.toMatchObject({
      code: "ORGANIZATION_STORE_PUBLISH_FAILED",
    });
    expect(await store.get(toOrganizationId("org-acme"))).toBeNull();
  });

  it("fails closed on malformed persisted state", async () => {
    const path = await storePath();
    const store = new FileOrganizationStore(path);
    await store.apply(createCommand());
    await writeFile(revisionPath(path, 1), '{"revision":', "utf8");

    await expect(store.get(toOrganizationId("org-acme"))).rejects.toMatchObject(
      {
        code: "ORGANIZATION_STORE_CORRUPT",
      },
    );
  });

  it("validates nested receipts and audit history before returning persisted state", async () => {
    const path = await storePath();
    const store = new FileOrganizationStore(path);
    const created = await store.apply(createCommand());
    const corruptRecord = structuredClone(created.record);
    const receipt = corruptRecord.receipts[0];
    if (!receipt) throw new Error("test fixture was not persisted");
    receipt.resultingRevision = 99;
    await writeFile(
      revisionPath(path, 1),
      JSON.stringify(corruptRecord),
      "utf8",
    );

    await expect(store.get(toOrganizationId("org-acme"))).rejects.toMatchObject(
      { code: "ORGANIZATION_STORE_CORRUPT" },
    );
  });
});
