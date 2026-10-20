import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafetyBackup } from "./pitr-safety-backup-operator";

async function fixture(
  work: (
    input: Parameters<typeof runSafetyBackup>[0],
    calls: string[],
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "pitr-backup-operator-"));
  const id = "11111111-1111-1111-1111-111111111111",
    volume = "22222222-2222-2222-2222-222222222222";
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify({
      checks: { railwayTarget: "match", protectedDatabaseAuthority: "match" },
      postgresMajor: { canonical: "18", protected: "18" },
    }),
  );
  const calls: string[] = [];
  let name: string | undefined, created: string | undefined;
  const input: Parameters<typeof runSafetyBackup>[0] = {
    directory,
    projectId: id,
    environmentId: id,
    serviceId: id,
    volumeReceipt: createHash("sha256").update(volume).digest("hex"),
    expiry: Date.now() + 60000,
    signal: new AbortController().signal,
    sourceFresh: async () => true,
    async api(op, variables) {
      calls.push(op);
      switch (op) {
        case "volumes":
          return {
            data: {
              environment: {
                id,
                volumeInstances: {
                  edges: [
                    {
                      node: {
                        id: volume,
                        volumeId: volume,
                        environmentId: id,
                        serviceId: id,
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
          };
        case "backupList":
          return {
            data: {
              volumeInstanceBackupList: name
                ? [{ id: "backup", name, createdAt: created, expiresAt: null }]
                : [],
            },
          };
        case "backupCreate":
          name = String(variables.name);
          created = new Date().toISOString();
          return {
            data: { volumeInstanceBackupCreate: { workflowId: "workflow" } },
          };
        case "workflowStatus":
          return { data: { workflowStatus: { status: "Complete" } } };
        default:
          throw Error("unexpected_operation");
      }
    },
  };
  try {
    await work(input, calls);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("protected glue creates one exact-volume backup and emits only safe receipts", async () => {
  await fixture(async (input, calls) => {
    const intents: unknown[] = [];
    input.publishIntent = (value) => intents.push(value);
    const result = await runSafetyBackup(input);
    expect(result.state).toBe("completed_retained");
    expect(calls.filter((v) => v === "backupCreate")).toHaveLength(1);
    expect(calls).not.toContain("stageTemplate");
    expect(intents).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(input.serviceId);
    expect(result.stagePerformed).toBe(false);
  });
});
test("wrong approved volume and failed source freshness prevent all creation", async () => {
  await fixture(async (input, calls) => {
    input.volumeReceipt = "0".repeat(64);
    await expect(runSafetyBackup(input)).rejects.toThrow(
      "volume_binding_mismatch",
    );
    expect(calls).not.toContain("backupCreate");
  });
  await fixture(async (input, calls) => {
    input.sourceFresh = async () => false;
    await expect(runSafetyBackup(input)).rejects.toThrow(
      "source_or_operation_unavailable",
    );
    expect(calls).not.toContain("backupCreate");
  });
});

test("authority expiry during precreation provider reads prevents backup mutation", async () => {
  await fixture(async (input, calls) => {
    const api = input.api;
    input.api = async (...args) => {
      const result = await api(...args);
      if (args[0] === "backupList") {
        const old = new Date(Date.now() - 61000);
        utimesSync(join(input.directory, "report.json"), old, old);
      }
      return result;
    };
    const result = await runSafetyBackup(input);
    expect(result.state).toBe("unconfirmed");
    expect(result.requestSubmitted).toBe(false);
    expect("phase" in result && result.phase).toBe("create_preflight");
    expect(calls).not.toContain("backupCreate");
  });
});

test("review expiry during the final source check prevents creation", async () => {
  await fixture(async (input, calls) => {
    let checks = 0;
    input.sourceFresh = async () => {
      if (++checks === 4) input.expiry = Date.now() - 1;
      return true;
    };
    const result = await runSafetyBackup(input);
    expect(result.state).toBe("unconfirmed");
    expect(result.requestSubmitted).toBe(false);
    expect("phase" in result && result.phase).toBe("create_preflight");
    expect(calls).not.toContain("backupCreate");
  });
});

test("retention expiring during final source check cannot publish completed proof", async () => {
  await fixture(async (input, calls) => {
    const api = input.api;
    const expiry = Date.now() + 120000;
    input.api = async (...args) => {
      const response = await api(...args);
      if (args[0] === "backupList") {
        const data = response as {
          data: {
            volumeInstanceBackupList: Array<{ expiresAt: string | null }>;
          };
        };
        for (const row of data.data.volumeInstanceBackupList)
          row.expiresAt = new Date(expiry).toISOString();
      }
      return response;
    };
    let checks = 0;
    let clock: ReturnType<typeof spyOn> | undefined;
    input.sourceFresh = async () => {
      if (++checks === 6)
        clock = spyOn(Date, "now").mockReturnValue(expiry + 1);
      return true;
    };
    try {
      expect((await runSafetyBackup(input)).state).toBe("unconfirmed");
      expect(calls.filter((v) => v === "backupCreate")).toHaveLength(1);
    } finally {
      clock?.mockRestore();
    }
  });
});

test("exact operation reconciliation reads only, distinguishes absent/unique/ambiguous and never claims Complete", async () => {
  await fixture(async (input, calls) => {
    const original = input.api,
      name = `alpha-pitr-safety-${"a".repeat(32)}`;
    input.reconcileOperationReceipt = createHash("sha256")
      .update(name)
      .digest("hex");
    for (const count of [0, 1, 2]) {
      calls.length = 0;
      input.api = async (op, vars, signal) => {
        if (op !== "backupList") return original(op, vars, signal);
        calls.push(op);
        return {
          data: {
            volumeInstanceBackupList: Array.from({ length: count }, (_, i) => ({
              id: `backup${i}`,
              name,
              createdAt: new Date(Date.now() - 1000).toISOString(),
              expiresAt: null,
            })),
          },
        };
      };
      const result = await runSafetyBackup(input);
      expect(result.state).toBe("observed_read_only");
      expect("matchingBackup" in result && result.matchingBackup).toBe(
        ["absent", "unique", "ambiguous"][count],
      );
      expect(result.requestSubmitted).toBe(false);
      expect(result.workflowComplete).toBe(false);
      expect("apiContract" in result && result.apiContract.available).toBe(
        false,
      );
      expect(
        calls.every((op) =>
          ["volumes", "backupList", "backupContract"].includes(op),
        ),
      ).toBe(true);
    }
  });
});
test("malformed reconciliation reference refuses instead of falling back to creation", async () => {
  await fixture(async (input, calls) => {
    input.reconcileOperationReceipt = "not-a-hash";
    await expect(runSafetyBackup(input)).rejects.toThrow(
      "reconcile_operation_invalid",
    );
    expect(calls).not.toContain("backupCreate");
  });
});
test("create uncertainty reports invocation boundary and finite failure only", async () => {
  await fixture(async (input, calls) => {
    const original = input.api;
    input.api = async (op, vars, signal) => {
      if (op === "backupCreate") {
        calls.push(op);
        throw Error("private provider value");
      }
      return original(op, vars, signal);
    };
    const result = await runSafetyBackup(input);
    expect(result.state).toBe("unconfirmed");
    expect(result.requestSubmitted).toBe(true);
    expect("phase" in result && result.phase).toBe("create_request");
    expect("failureCategory" in result && result.failureCategory).toBe(
      "unclassified_private_failure",
    );
    expect(JSON.stringify(result)).not.toContain("private provider value");
    expect(calls.filter((v) => v === "backupCreate")).toHaveLength(1);
  });
});

test("unique malformed backup identity cannot produce a retained reconciliation receipt", async () => {
  await fixture(async (input, calls) => {
    const original = input.api,
      name = `alpha-pitr-safety-${"b".repeat(32)}`;
    input.reconcileOperationReceipt = createHash("sha256")
      .update(name)
      .digest("hex");
    for (const id of [undefined, null, "", 42]) {
      input.api = async (op, vars, signal) =>
        op === "backupList"
          ? {
              data: {
                volumeInstanceBackupList: [
                  {
                    id,
                    name,
                    createdAt: new Date(Date.now() - 1000).toISOString(),
                    expiresAt: null,
                  },
                ],
              },
            }
          : original(op, vars, signal);
      await expect(runSafetyBackup(input)).rejects.toThrow(
        "reconcile_backup_identity_invalid",
      );
    }
    expect(calls).not.toContain("backupCreate");
  });
});

test("finite transport refusal survives the public receipt without retry", async () => {
  await fixture(async (input, calls) => {
    const original = input.api;
    input.api = async (op, vars, signal) => {
      if (op === "backupCreate") {
        calls.push(op);
        throw Error("private_provider_permission");
      }
      return original(op, vars, signal);
    };
    const result = await runSafetyBackup(input);
    expect(result.state).toBe("unconfirmed");
    expect("failureCategory" in result && result.failureCategory).toBe(
      "private_provider_permission",
    );
    expect(result.automaticRetryAllowed).toBe(false);
    expect(calls.filter((v) => v === "backupCreate")).toHaveLength(1);
  });
});
