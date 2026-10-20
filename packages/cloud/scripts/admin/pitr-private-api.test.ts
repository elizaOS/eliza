import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privatePitrApi } from "./pitr-private-api";

async function fakeCli(source: string, work: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "pitr-api-fixture-"));
  const oldPath = process.env.PATH,
    oldToken = process.env.RAILWAY_TOKEN;
  try {
    const file = join(dir, "railway");
    writeFileSync(file, `#!/usr/bin/python3\n${source}\n`);
    chmodSync(file, 0o700);
    process.env.PATH = dir;
    process.env.RAILWAY_TOKEN = "synthetic-only";
    await work(dir);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldToken === undefined) delete process.env.RAILWAY_TOKEN;
    else process.env.RAILWAY_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
}
test("private CLI receives variables through stdin, never argv", async () => {
  await fakeCli(
    'import sys,json\nv=json.load(sys.stdin)\nassert "private-fixture" not in str(sys.argv)\nassert v["id"]=="private-fixture"\nprint(json.dumps({"data":{"workflowStatus":{"status":"Complete"}}}))',
    async () => {
      expect(
        await privatePitrApi("workflowStatus", { id: "private-fixture" }),
      ).toEqual({ data: { workflowStatus: { status: "Complete" } } });
    },
  );
});
test("private provider error and oversized output expose only finite error", async () => {
  for (const [script, category] of [
    [
      'import sys\nprint("private-fixture-secret",file=sys.stderr)\nsys.exit(1)',
      "private_provider_cli_exit",
    ],
    ['print("x"*5000000)', "private_provider_output_limit"],
  ])
    await fakeCli(script, async () => {
      await expect(privatePitrApi("template", {})).rejects.toThrow(category);
    });
});
test("aborted bounded request kills its owned child and rejects", async () => {
  await fakeCli("import time\ntime.sleep(30)", async () => {
    const abort = new AbortController();
    const promise = privatePitrApi("template", {}, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(promise).rejects.toThrow("private_provider_aborted");
  });
});

test("stage transport cannot omit stageOnly or substitute an unreviewed template", async () => {
  await expect(
    privatePitrApi("stageTemplate", { input: { stageOnly: false } }),
  ).rejects.toThrow("private_stage_input_refused");
  await expect(
    privatePitrApi("stageTemplate", {
      input: {
        stageOnly: true,
        existingRootServiceId: "root",
        environmentId: "env",
        projectId: "project",
        workspaceId: "workspace",
        templateId: "template",
        serializedConfig: {},
      },
    }),
  ).rejects.toThrow("private_stage_input_refused");
});

test("serialization and inherited operation failures are finite and precede spawn", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expect(privatePitrApi("template", circular)).rejects.toThrow(
    "private_provider_input_refused",
  );
  await expect(
    privatePitrApi("template", {
      toJSON() {
        throw Error("private-fixture-secret");
      },
    }),
  ).rejects.toThrow("private_provider_input_refused");
  await expect(
    privatePitrApi("template", { large: "x".repeat(5000000) }),
  ).rejects.toThrow("private_provider_input_refused");
  await expect(privatePitrApi("toString" as "template", {})).rejects.toThrow(
    "private_provider_configuration_missing",
  );
});
test("successful CLI exit with a surviving descendant is never reported successful", async () => {
  await fakeCli(
    'import os,time,json\nopen(__file__+".pgid","w").write(str(os.getpid()))\npid=os.fork()\nif pid==0:\n for fd in (0,1,2): os.close(fd)\n time.sleep(30)\nelse:\n print(json.dumps({"data":{}}))',
    async (dir) => {
      await expect(privatePitrApi("template", {})).rejects.toThrow(
        /private_provider_(descendants_retired|cleanup_unconfirmed)/,
      );
      const pgid = Number(readFileSync(join(dir, "railway.pgid"), "utf8"));
      expect(() => process.kill(-pgid, 0)).toThrow();
    },
  );
}, 10000);

// Real subprocess fixtures exercise the pinned CLI's stdout-before-nonzero contract.
test("nonzero structured errors classify only fixed codes and never succeed", async () => {
  for (const [code, expected] of [
    ["FORBIDDEN", "permission"],
    ["UNAUTHENTICATED", "authentication"],
    ["BAD_USER_INPUT", "bad_user_input"],
    ["GRAPHQL_VALIDATION_FAILED", "graphql_document"],
    ["RATE_LIMITED", "rate_limit"],
    ["private-fixture-secret", "graphql_unknown"],
  ])
    await fakeCli(
      `import sys,json\nprint(json.dumps({"data":{"workflowId":"private-id"},"errors":[{"message":"private-fixture-secret","extensions":{"code":"${code}","secret":"private-value"}}]}))\nsys.exit(1)`,
      async () => {
        let error: unknown;
        try {
          await privatePitrApi("backupCreate", {
            id: "private-id",
            name: "private-name",
          });
        } catch (e) {
          error = e;
        }
        expect(error instanceof Error ? error.message : null).toBe(
          `private_provider_${expected}`,
        );
        expect(String(error)).not.toContain("private-fixture-secret");
      },
    );
});
test("mixed or malformed GraphQL errors refuse and no nonzero data response succeeds", async () => {
  for (const [body, exit, category] of [
    [{ data: { workflowId: "secret" } }, 1, "cli_exit"],
    [
      {
        errors: [
          { extensions: { code: "FORBIDDEN" } },
          { extensions: { code: "unknown" } },
        ],
      },
      0,
      "graphql_unknown",
    ],
    [{ errors: "private-fixture-secret" }, 0, "graphql_unknown"],
    [{ errors: [{ extensions: { code: "FORBIDDEN" } }] }, 0, "permission"],
  ] as const)
    await fakeCli(
      `import sys\nprint(${JSON.stringify(JSON.stringify(body))})\nsys.exit(${exit})`,
      async () => {
        await expect(privatePitrApi("backupCreate", {})).rejects.toThrow(
          `private_provider_${category}`,
        );
      },
    );
});
test("exact pinned HTTP lines classify without leaking stderr; arbitrary text does not", async () => {
  for (const [line, category] of [
    ["Error: Railway API request failed with HTTP 403 Forbidden", "permission"],
    [
      "Railway API request failed with HTTP 500 Internal Server Error",
      "http_server",
    ],
    ["private-fixture-secret HTTP 403 Forbidden", "cli_exit"],
    [
      `${"x".repeat(150)}Railway API request failed with HTTP 403 Forbidden`,
      "cli_exit",
    ],
  ])
    await fakeCli(
      `import sys\nsys.stderr.write(${JSON.stringify(`${line}\n`)})\nsys.exit(1)`,
      async () => {
        await expect(privatePitrApi("backupCreate", {})).rejects.toThrow(
          `private_provider_${category}`,
        );
      },
    );
});

test("failure evidence callback is backup-error-only and never changes rejection", async () => {
  const script =
    'import sys,json\nprint(json.dumps({"data":{"secret":"never-captured"},"errors":[{"message":"constraint","extensions":{"code":"BAD_USER_INPUT"}}]}))\nsys.exit(1)';
  await fakeCli(script, async () => {
    const captured: unknown[] = [];
    await expect(
      privatePitrApi("backupCreate", {}, undefined, (e) => captured.push(e)),
    ).rejects.toThrow("private_provider_bad_user_input");
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured)).not.toContain("never-captured");
    await expect(
      privatePitrApi("backupList", {}, undefined, (e) => captured.push(e)),
    ).rejects.toThrow("private_provider_bad_user_input");
    expect(captured).toHaveLength(1);
    await expect(
      privatePitrApi("backupCreate", {}, undefined, () => {
        throw Error("private-observer-secret");
      }),
    ).rejects.toThrow("private_provider_bad_user_input");
  });
});
