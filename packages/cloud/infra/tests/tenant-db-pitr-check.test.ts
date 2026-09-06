/** Exercises the real host check shell with a substituted pgBackRest transport and receipt failures. */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(
  new URL(
    "../cloud/terraform/hetzner/apps-shared/cloud-init/tenant-db-pitr-check.sh",
    import.meta.url,
  ),
  "utf8",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const now = 1_800_000_000;
function receipt() {
  return [
    {
      name: "tenant",
      status: { code: 0 },
      repo: [{ key: 1, status: { code: 0 } }],
      db: [{ id: 1, "repo-key": 1 }],
      backup: [
        {
          database: { id: 1, "repo-key": 1 },
          error: false,
          type: "full",
          label: "fixtureF",
          timestamp: { stop: now - 60 },
        },
      ],
    },
  ];
}
function run(value: ReturnType<typeof receipt>, failure = "") {
  const root = mkdtempSync(join(tmpdir(), "tenant-pitr-check-"));
  roots.push(root);
  writeFileSync(join(root, "receipt.json"), JSON.stringify(value));
  writeFileSync(join(root, "date"), `#!/bin/sh\nprintf '%s\\n' ${now}\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(root, "pgbackrest"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$*" in
  *" check") [ "$FAILURE" != archive ] || exit 19 ;;
  *" info") [ "$FAILURE" != info ] || exit 23; cat "$FIXTURE_ROOT/receipt.json" ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "bash",
    ["-c", script.replaceAll("/usr/bin/pgbackrest", join(root, "pgbackrest"))],
    {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        FIXTURE_ROOT: root,
        FAILURE: failure,
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return { ...result, calls: readFileSync(join(root, "calls"), "utf8") };
}
test("reports completed current-generation backups after archive delivery", () => {
  const result = run(receipt());
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    stanza: "tenant",
    backup: "fixtureF",
    checked_at: now,
  });
});
test("archive failure prevents a healthy backup receipt from masking delivery failure", () => {
  const result = run(receipt(), "archive");
  expect(result.status).toBe(19);
  expect(result.calls).not.toContain(" info");
});
test("repository read failure propagates through the shell pipeline", () => {
  expect(run(receipt(), "info").status).not.toBe(0);
});
for (const mode of [
  "missing",
  "stale",
  "future",
  "previous-generation",
  "errored",
  "repository-error",
  "old-full",
] as const) {
  test(`rejects ${mode} recovery evidence`, () => {
    const value = receipt();
    const stanza = value[0];
    if (mode === "missing") stanza.backup = [];
    if (mode === "stale") stanza.backup[0].timestamp.stop = now - 93601;
    if (mode === "future") stanza.backup[0].timestamp.stop = now + 1;
    if (mode === "previous-generation") stanza.db[0].id = 2;
    if (mode === "errored") stanza.backup[0].error = true;
    if (mode === "repository-error") stanza.repo[0].status.code = 1;
    if (mode === "old-full") {
      stanza.backup.push({
        ...stanza.backup[0],
        type: "diff",
        label: "fixtureD",
        timestamp: { stop: now - 60 },
      });
      stanza.backup[0].timestamp.stop = now - 777601;
    }
    expect(run(value).status).not.toBe(0);
  });
}
