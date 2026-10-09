// @vitest-environment node
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  executeSignedInstall,
  type SignedInstallInput,
} from "./signed-install";

const executable = vi.hoisted(() => ({ path: "" }));
vi.mock("./signed-release", () => ({
  signedInstallerPath: () => executable.path,
}));
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(serial = "success"): Promise<SignedInstallInput> {
  const root = await mkdtemp(join(tmpdir(), "elizaos-signed-handoff-"));
  directories.push(root);
  executable.path = join(root, "executor.mjs");
  await writeFile(
    executable.path,
    `
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
for (const key of ['--device','--artifact-dir','--manifest','--expected-subject-sha256','--tool-dir','--recovery-dir','--journal','--health-token-file','--execute','--confirm-flash','--reboot-after-flash']) {
  if (!args.includes(key)) throw new Error('missing '+key);
}
const serial = value('--device');
const subjectSha256 = 'a'.repeat(64);
const events = [{event:'authorized', serial, subjectSha256}];
if (serial === 'failed-event') events.push({event:'failed'});
events.push({event: serial === 'unverified' ? 'installed-awaiting-boot-validation' : 'installed-runtime-verified', subjectSha256:serial === 'wrong-subject' ? 'b'.repeat(64) : subjectSha256});
if (serial === 'wrong-serial') events[0].serial = 'other-device';
fs.writeFileSync(value('--journal'),events.map(e=>JSON.stringify(e)).join('\\n') + (serial === 'partial' ? '' : '\\n'),{flag:'wx',mode:0o600});
console.log('fixture executor output');
if (serial === 'exit-failure') process.exitCode=1;
`,
  );
  return {
    serial,
    artifactDir: root,
    manifestPath: join(root, "manifest.json"),
    subjectSha256: "a".repeat(64),
    toolDir: root,
    healthTokenFile: join(root, "private-token"),
    stateDirectory: join(root, "state"),
    wipe: true,
  };
}

test.runIf(process.platform === "linux")(
  "handoff waits for the child and retains a private matching runtime receipt",
  async () => {
    const input = await fixture();
    const journal = await executeSignedInstall(input);
    expect((await stat(input.stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(journal)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(join(journal, "..", "executor.log"), "utf8"),
    ).toContain("fixture executor output");
    expect(
      JSON.parse(
        (await readFile(journal, "utf8")).trim().split("\n").at(-1) ?? "null",
      ).event,
    ).toBe("installed-runtime-verified");
  },
);

test.runIf(process.platform === "linux")(
  "exit failure, incomplete or mismatched receipts never report installation success",
  async () => {
    for (const serial of [
      "exit-failure",
      "unverified",
      "wrong-subject",
      "wrong-serial",
      "failed-event",
      "partial",
    ]) {
      const input = await fixture(serial);
      await expect(executeSignedInstall(input)).rejects.toThrow(
        "Installation evidence:",
      );
      expect(await readdir(input.stateDirectory)).toHaveLength(1);
    }
  },
);

test.runIf(process.platform === "linux")(
  "missing post-boot credential is rejected before allocating or launching execution",
  async () => {
    const input = await fixture();
    input.healthTokenFile = "";
    await expect(executeSignedInstall(input)).rejects.toThrow("health-token");
    await expect(stat(input.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
