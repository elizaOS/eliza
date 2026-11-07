import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { privatePitrApi } from "./pitr-private-api";
import {
  runStageOnlyPolicyEngine,
  type StageOnlyInput,
} from "./pitr-stage-runner";
import { generateRecipientKeyPair, openEnvelope } from "./recipient-envelope";

function observationFixture() {
  return {
    projectId: "project",
    environmentId: "env",
    serviceId: "db",
    sourceHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedVolumeReceipt:
      "62d7a6b1211d627650e2bf0c869b69b564e2cd74290ae1dd78ae4b5e20b0cfe7",
    expectedImageReceipt:
      "6105d6cc76af400325e94d588ce511be5bfdbb73b437dc51eca43917d7a43e3d",
    approvedBackup: {
      backupReceipt:
        "54d00d867758cef816bc4685f58e327b949712b07ebd17c3485f3ffc9e9f5133",
      volumeReceipt:
        "62d7a6b1211d627650e2bf0c869b69b564e2cd74290ae1dd78ae4b5e20b0cfe7",
      createdAtMs: 1000,
      validUntilMs: Date.now() + 3600000,
      expiresAtMs: null as number | null,
    },
    authority: {
      checks: {
        railwayTarget: "match",
        protectedDatabaseAuthority: "match",
      },
      postgresMajor: {
        canonical: "18",
        protected: "18",
      },
    },
    authorityObservedAtMs: 2000,
    now: 3000,
    environment: {
      data: {
        environment: {
          id: "env",
          config: {
            services: {
              db: {
                source: {
                  image: "image",
                },
                variables: {
                  PGPASSWORD: {
                    value: "private sentinel",
                  },
                },
              },
            },
            buckets: {
              old: {
                region: "region",
              },
            },
          },
        },
      },
    },
    project: {
      data: {
        project: {
          id: "project",
          workspaceId: "workspace",
          buckets: {
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
            },
            edges: [
              {
                node: {
                  id: "old",
                  projectId: "project",
                  name: "oldname",
                },
              },
            ],
          },
        },
      },
    },
    volumes: {
      data: {
        environment: {
          id: "env",
          volumeInstances: {
            edges: [
              {
                node: {
                  id: "volume",
                  environmentId: "env",
                  serviceId: "db",
                  mountPath: "/var/lib/postgresql/data",
                  state: "READY",
                  deletedAt: null,
                  isPendingDeletion: false,
                },
              },
            ],
          },
        },
      },
    },
    staged: {
      data: {
        environmentStagedChanges: {
          patch: {
            services: {},
            buckets: {},
          },
        },
      },
    },
    backups: {
      data: {
        volumeInstanceBackupList: [
          {
            id: "backup",
            createdAt: "1970-01-01T00:00:01.000Z",
            expiresAt: null as string | null,
          },
        ],
      },
    },
    pitr: {
      isHaCluster: false,
    },
  };
}

const recipient = generateRecipientKeyPair();
const template = { fixture: "only synthetic stage template" };
const templateReceipt = createHash("sha256")
  .update(JSON.stringify(template))
  .digest("hex");
async function scenario(
  mode:
    | "valid"
    | "image"
    | "uncertain"
    | "preflight"
    | "expired"
    | "backup_expires"
    | "stale_capture"
    | "publish_fails"
    | "backup_ages"
    | "active_image"
    | "post_backup_expired"
    | "siblings_fail",
) {
  const f = observationFixture();
  if (mode === "backup_expires") {
    f.approvedBackup.expiresAtMs = Date.now() + 50;
    f.backups.data.volumeInstanceBackupList[0].expiresAt = new Date(
      f.approvedBackup.expiresAtMs,
    ).toISOString();
  }
  if (mode === "backup_ages") f.approvedBackup.validUntilMs = Date.now() + 50;
  let sourceReads = 0;
  let clockOffset = 0;
  const clock = () => Date.now() + clockOffset;
  const directory = mkdtempSync(join(tmpdir(), "pitr-stage-test-"));
  const calls: string[] = [];
  const published: Record<string, unknown>[] = [];
  let staged = false;
  let pendingReads = 0;
  const api = (async (
    name: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    calls.push(name);
    if (mode === "siblings_fail") {
      if (name === "environment") throw Error("private-read-error");
      pendingReads++;
      return await new Promise((_, reject) => {
        const finish = () =>
          setTimeout(() => {
            pendingReads--;
            reject(Error("private-cancelled"));
          }, 10);
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    }

    if (mode === "preflight") throw Error("private-provider-sentinel");
    if (name === "environment") return f.environment;
    if (name === "projectBuckets") return f.project;
    if (name === "volumes") return f.volumes;
    if (name === "staged") return f.staged;
    if (name === "backupList") {
      if (mode === "stale_capture") clockOffset = 61000;
      return f.backups;
    }
    if (name === "template")
      return {
        data: {
          template: {
            id: "template-private",
            serializedConfig: JSON.stringify(template),
          },
        },
      };
    if (name === "workflowStatus")
      return { data: { workflowStatus: { status: "Complete" } } };
    if (name === "stageTemplate") {
      const input = variables.input as Record<string, unknown>;
      expect(input.stageOnly).toBe(true);
      expect(input.existingRootServiceId).toBe("db");
      expect(input.serializedConfig).toEqual(template);
      staged = true;
      if (mode === "active_image")
        f.environment.data.environment.config.services.db.source.image =
          "unexpected-private-image";
      if (mode === "post_backup_expired")
        f.backups.data.volumeInstanceBackupList[0].expiresAt =
          "1970-01-01T00:00:02.000Z";

      f.project.data.project.buckets.edges.push({
        node: { id: "new", projectId: "project", name: "newname" },
      });
      const values = Object.fromEntries(
        Object.entries({
          WAL_ARCHIVE_BUCKET: "BUCKET",
          WAL_ARCHIVE_ENDPOINT: "ENDPOINT",
          WAL_ARCHIVE_KEY: "ACCESS_KEY_ID",
          WAL_ARCHIVE_SECRET: "SECRET_ACCESS_KEY",
          WAL_ARCHIVE_REGION: "REGION",
        }).map(([k, v]) => [k, { value: `${"$"}{{newname.${v}}}` }]),
      );
      f.staged.data.environmentStagedChanges.patch = {
        services: {
          db: {
            variables: values,
            ...(mode === "image" ? { source: { image: "unreviewed" } } : {}),
          },
        },
        buckets: { new: { name: "newname" } },
      };
      if (mode === "uncertain") throw Error("private-provider-after-create");
      return {
        data: {
          templateDeployV2: {
            projectId: "project",
            workflowId: "private-workflow",
          },
        },
      };
    }
    throw Error("unexpected-query");
  }) as typeof privatePitrApi;
  const input: StageOnlyInput = {
    directory,
    recipientPublicKey: recipient.publicKeyBase64,
    projectId: "project",
    environmentId: "env",
    serviceId: "db",
    sourceHead: f.sourceHead,
    volumeReceipt: f.expectedVolumeReceipt,
    imageReceipt: f.expectedImageReceipt,
    maintenanceReceipt: "b".repeat(64),
    expiry: mode === "expired" ? Date.now() - 1 : Date.now() + 60000,
    approvedBackup: { ...f.approvedBackup, verifiedRunId: 1 },
    signal: new AbortController().signal,
    api,
    sourceFresh: async () => {
      sourceReads++;
      if (
        (mode === "backup_expires" || mode === "backup_ages") &&
        sourceReads === 5
      )
        await new Promise((resolve) => setTimeout(resolve, 70));
      return true;
    },
    refreshAuthority: async () => ({
      authority: f.authority,
      authorityObservedAtMs: clock(),
      pitr: f.pitr,
    }),
    publish: (r) => {
      published.push(r);
      if (mode === "publish_fails" && staged)
        throw Error("private-output-error");
    },
  };
  try {
    const result = await runStageOnlyPolicyEngine(
      input,
      templateReceipt,
      clock,
    );
    const names = readdirSync(directory);
    const modes = names.map((n) => statSync(join(directory, n)).mode & 0o777);
    const privateEvidence = names.map((n) =>
      openEnvelope(
        JSON.parse(readFileSync(join(directory, n), "utf8")),
        recipient.privateKeyPem,
      ).toString("utf8"),
    );
    return {
      result,
      calls,
      published,
      names,
      modes,
      privateEvidence,
      staged,
      pendingReads,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("stage composition uses exact stageOnly and stores private baseline without commit", async () => {
  const r = await scenario("valid");
  expect(r.result.state).toBe("staged_requires_review");
  expect(r.calls.filter((n) => n === "stageTemplate").length).toBe(1);
  expect(r.calls.some((n) => /commit|delete|lock|restore/i.test(n))).toBe(
    false,
  );
  expect(r.modes.every((n) => n === 0o600)).toBe(true);
  expect(r.privateEvidence.join()).toContain("private sentinel");
  expect(JSON.stringify(r.published)).not.toContain("private sentinel");
  expect(JSON.stringify(r.published)).not.toContain("private-workflow");
  expect(r.result.committed).toBe(false);
});
test("image-changing staged result remains prohibited with no commit or cleanup mutation", async () => {
  const r = await scenario("image");
  expect(r.result.state).toBe("staged_prohibited_change");
  expect(r.result.resourceCreationPossible).toBe(true);
  expect(r.names).toContain("stage-reconciliation.sealed.json");
  expect(r.calls.filter((n) => n === "stageTemplate").length).toBe(1);
});
test("uncertain stage reconciles privately and never retries or claims owned resources", async () => {
  const r = await scenario("uncertain");
  expect(r.staged).toBe(true);
  expect(r.result.state).toBe("creation_unconfirmed");
  expect(r.calls.filter((n) => n === "stageTemplate").length).toBe(1);
  expect(
    r.published.find((p) => p.purpose === "pitr_stage_reconciliation")
      ?.ownershipProven,
  ).toBe(false);
  expect(JSON.stringify(r.result)).not.toContain("private-provider");
});
test("initial provider failure and expired review refuse before any stage", async () => {
  for (const mode of ["preflight", "expired"] as const) {
    const r = await scenario(mode);
    expect(r.result.state).toBe("refused_before_stage");
    expect(r.result.resourceCreationPossible).toBe(false);
    expect(r.calls).not.toContain("stageTemplate");
    expect(JSON.stringify(r.result)).not.toContain("private-provider");
  }
});

test("backup expiry during final source freshness await prevents resource creation", async () => {
  const r = await scenario("backup_expires");
  expect(r.calls).not.toContain("stageTemplate");
  expect(r.staged).toBe(false);
  expect(r.result.state).not.toBe("staged_requires_review");
});

test("capture cannot relabel old config reads as fresh after slow later provider reads", async () => {
  const r = await scenario("stale_capture");
  expect(r.result.state).toBe("refused_before_stage");
  expect(r.calls).not.toContain("stageTemplate");
  expect(r.result.resourceCreationPossible).toBe(false);
});

test("evidence publication failure after submission cannot relabel resource creation as preflight", async () => {
  const r = await scenario("publish_fails");
  expect(r.staged).toBe(true);
  expect(r.result.resourceCreationPossible).toBe(true);
  expect(r.result.state).toBe("creation_unconfirmed");
  expect(r.names).toContain("stage-intent.sealed.json");
  expect(r.names).toContain("stage-workflow.sealed.json");
  expect(JSON.stringify(r.result)).not.toContain("private-output-error");
});
test("backup max-age crossing during final await prevents stage even with no expiry", async () => {
  const r = await scenario("backup_ages");
  expect(r.calls).not.toContain("stageTemplate");
  expect(r.staged).toBe(false);
});

test("post-submit interpretation failures retain actual encrypted observations", async () => {
  for (const mode of ["active_image", "post_backup_expired"] as const) {
    const r = await scenario(mode);
    expect(r.result.state).toBe("creation_unconfirmed");
    expect(r.result.resourceCreationPossible).toBe(true);
    expect(r.names).toContain("stage-raw-observation.sealed.json");
    expect(r.names).toContain("stage-raw-reconciliation.sealed.json");
    const sealed = r.privateEvidence
      .map((v) => JSON.parse(v))
      .find((v) => v.kind === "stage-raw-observation.json");
    expect(sealed.evidence.reads.environment).toBeDefined();
    if (mode === "active_image")
      expect(JSON.stringify(sealed)).toContain("unexpected-private-image");
    else expect(JSON.stringify(sealed)).toContain("1970-01-01T00:00:02.000Z");
    expect(JSON.stringify(r.published)).not.toContain(
      "unexpected-private-image",
    );
    expect(r.calls.filter((v) => v === "stageTemplate").length).toBe(1);
  }
});
test("failed parallel provider read aborts and awaits sibling retirement before return", async () => {
  const r = await scenario("siblings_fail");
  expect(r.pendingReads).toBe(0);
  expect(r.result.state).toBe("refused_before_stage");
  expect(r.calls).not.toContain("stageTemplate");
});
