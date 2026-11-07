import { expect, test } from "bun:test";
import { normalizeStageObservation } from "./pitr-stage-observation";

function fixture() {
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
      expiresAtMs: null,
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
            expiresAt: null,
          },
        ],
      },
    },
    pitr: {
      isHaCluster: false,
    },
  };
}
test("private observation preserves credential config and old bucket env config in hashes", () => {
  const f = fixture(),
    a = normalizeStageObservation(f);
  expect(a.snapshot.binding.backupCompleted).toBe(true);
  f.environment.data.environment.config.services.db.variables.PGPASSWORD.value =
    "changed";
  expect(normalizeStageObservation(f).snapshot.preservedConfigSha256).not.toBe(
    a.snapshot.preservedConfigSha256,
  );
  f.environment.data.environment.config.buckets.old.region = "changed";
  expect(normalizeStageObservation(f).privateBuckets.old).not.toEqual(
    a.privateBuckets.old,
  );
  expect(JSON.stringify(a.snapshot)).not.toContain("private sentinel");
});
test("stale authority, incomplete inventory, wrong image or backup and HA refuse", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.now = 70000;
    },
    (f: ReturnType<typeof fixture>) => {
      f.project.data.project.buckets.pageInfo.hasNextPage = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.environment.data.environment.config.services.db.source.image = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.backups.data.volumeInstanceBackupList[0].id = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.pitr.isHaCluster = true;
    },
  ]) {
    const f = fixture();
    change(f);
    expect(() => normalizeStageObservation(f)).toThrow(
      "stage_observation_invalid",
    );
  }
});
