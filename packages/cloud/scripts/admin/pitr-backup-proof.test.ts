import { expect, test } from "bun:test";
import {
  type BackupTransport,
  createPitrSafetyBackup,
} from "./pitr-backup-proof";

function fixture() {
  const binding = {
    projectId: "private-project",
    environmentId: "private-env",
    serviceId: "private-service",
    volumeId: "private-volume",
  };
  const operationName = `alpha-pitr-safety-${"a".repeat(32)}`;
  let lists = 0;
  let creates = 0;
  let proofs = 0;
  const transport: BackupTransport = {
    async binding() {
      return binding;
    },
    async list() {
      return lists++
        ? [
            {
              id: "private-new",
              name: operationName,
              volumeId: binding.volumeId,
              createdAtMs: 1000,
              expiresAtMs: null,
            },
          ]
        : [];
    },
    async persistIntent() {},
    async create() {
      creates++;
      return { workflowId: "private-workflow" };
    },
    async status() {
      return "Complete";
    },
    async persistProof() {
      proofs++;
    },
  };
  return {
    binding,
    operationName,
    expiresAtMs: 2000,
    now: () => 1000,
    transport,
    counts: () => ({ creates, proofs }),
  };
}
test("completion requires actual workflow Complete and exact new retained volume backup", async () => {
  const f = fixture();
  const result = await createPitrSafetyBackup(f);
  expect(result.state).toBe("completed_retained");
  expect(f.counts()).toEqual({ creates: 1, proofs: 1 });
  expect(JSON.stringify(result)).not.toContain("private");
});
test("unconfirmed workflow, wrong volume, expired retention and duplicate rows never yield proof", async () => {
  for (const kind of ["status", "volume", "expiry", "duplicate"]) {
    const f = fixture();
    if (kind === "status") f.transport.status = async () => "unconfirmed";
    else {
      let calls = 0;
      f.transport.list = async () => {
        if (!calls++) return [];
        const b = {
          id: "new",
          name: f.operationName,
          volumeId: kind === "volume" ? "wrong" : f.binding.volumeId,
          createdAtMs: 1000,
          expiresAtMs: kind === "expiry" ? 1500 : null,
        };
        return kind === "duplicate" ? [b, b] : [b];
      };
    }
    expect((await createPitrSafetyBackup(f)).state).toBe("unconfirmed");
    expect(f.counts().proofs).toBe(0);
  }
});
test("lost create response is private and not retried; existing operation name refuses before creation", async () => {
  const f = fixture();
  f.transport.create = async () => {
    throw Error("private-secret");
  };
  expect((await createPitrSafetyBackup(f)).state).toBe("unconfirmed");
  const g = fixture();
  g.transport.list = async () => [
    {
      id: "old",
      name: g.operationName,
      volumeId: g.binding.volumeId,
      createdAtMs: 1,
      expiresAtMs: null,
    },
  ];
  expect((await createPitrSafetyBackup(g)).state).toBe("refused");
  expect(g.counts().creates).toBe(0);
});

test("partial bindings and backups expired at actual completion cannot qualify", async () => {
  const f = fixture();
  delete (f.binding as Partial<typeof f.binding>).volumeId;
  expect((await createPitrSafetyBackup(f)).state).toBe("refused");
  expect(f.counts().creates).toBe(0);
  const g = fixture();
  let time = 1000;
  g.now = () => time;
  g.transport.status = async () => {
    time = 4000;
    return "Complete";
  };
  let lists = 0;
  g.transport.list = async () =>
    lists++
      ? [
          {
            id: "new",
            name: g.operationName,
            volumeId: g.binding.volumeId,
            createdAtMs: 1000,
            expiresAtMs: 3000,
          },
        ]
      : [];
  expect((await createPitrSafetyBackup(g)).state).toBe("unconfirmed");
  expect(g.counts().proofs).toBe(0);
});
