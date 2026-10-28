import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshStageAuthority } from "./pitr-stage-authority";

const projectId = "11111111-1111-1111-1111-111111111111",
  environmentId = "22222222-2222-2222-2222-222222222222",
  serviceId = "33333333-3333-3333-3333-333333333333";
async function fixture(
  mode: "valid" | "failure" | "abort",
  run: (result: Promise<unknown>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "pitr-authority-fixture-"));
  const original = {
    PATH: process.env.PATH,
    RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,
    DATABASE_URL: process.env.DATABASE_URL,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  const status = {
    id: projectId,
    environments: {
      edges: [{ node: { id: environmentId, name: "production" } }],
    },
    services: { edges: [{ node: { id: serviceId } }] },
  };
  const services = [
    { id: serviceId, source: { image: "ghcr.io/railwayapp/postgres:18" } },
  ];
  const railway = `#!${process.execPath}\nconst args=process.argv.slice(2);if(process.env.GITHUB_TOKEN||process.env.DATABASE_URL)process.exit(9);${mode === "failure" ? 'console.error("private-provider-secret");process.exit(1);' : ""}${mode === "abort" ? "setTimeout(()=>{},60000);" : `const value=args[0]==="status"?${JSON.stringify(status)}:args[0]==="service"?${JSON.stringify(services)}:args[0]==="variable"?{DATABASE_PUBLIC_URL:"postgres://private-secret@db.example/test"}:{isHaCluster:false};console.log(JSON.stringify(value));`}`;
  writeFileSync(join(root, "railway"), railway, { mode: 0o700 });
  writeFileSync(
    join(root, "bun"),
    `#!${process.execPath}\nif(process.argv[2]!=="--no-env-file"||process.env.GITHUB_TOKEN||process.env.RAILWAY_TOKEN||process.env.GITHUB_STEP_SUMMARY)process.exit(9);console.log(JSON.stringify({checks:{railwayTarget:"match",protectedDatabaseAuthority:"match"},postgresMajor:{canonical:"18",protected:"18"}}));process.exit(1);`,
    { mode: 0o700 },
  );
  process.env.PATH = `${root}:${original.PATH}`;
  process.env.RAILWAY_TOKEN = "private-provider-token";
  process.env.DATABASE_URL = "postgres://private-protected@db.example/test";
  process.env.GITHUB_TOKEN = "must-not-reach-child";
  const controller = new AbortController();
  const before = readdirSync(tmpdir()).filter((n) =>
    n.startsWith("pitr-stage-authority-"),
  );
  try {
    const result = refreshStageAuthority({
      projectId,
      environmentId,
      serviceId,
      signal: controller.signal,
    });
    if (mode === "abort") setTimeout(() => controller.abort(), 20);
    await run(result);
    expect(
      readdirSync(tmpdir()).filter((n) =>
        n.startsWith("pitr-stage-authority-"),
      ),
    ).toEqual(before);
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
test("fresh private capture uses bounded reads and no-env audit, accepts authority despite schema exit1", async () => {
  await fixture("valid", async (result) => {
    const r = (await result) as {
      authority: unknown;
      pitr: unknown;
      authorityObservedAtMs: number;
    };
    expect(r.authority).toMatchObject({
      checks: { protectedDatabaseAuthority: "match" },
    });
    expect(r.pitr).toEqual({ isHaCluster: false });
    expect(r.authorityObservedAtMs).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(r)).not.toContain("private-secret");
  });
});
test("provider failure and cancellation retire reads, clean private files and expose finite errors", async () => {
  for (const mode of ["failure", "abort"] as const)
    await fixture(mode, async (result) => {
      await expect(result).rejects.toThrow("stage_authority_unavailable");
    });
});
