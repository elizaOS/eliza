/**
 * Proves the protected Cloud release's temporary Git checkout against a real
 * authenticated HTTP remote while keeping credentials out of repository state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";

const repoRoot = new URL("../../../", import.meta.url);
const workflow = readFileSync(
  new URL(".github/workflows/cloud-cf-release.yml", repoRoot),
  "utf8",
);

function git(cwd: string, args: string[], extraEnv?: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function gitAsync(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
) {
  const process = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("Cloud CF temporary checkout authentication", () => {
  test("uses ephemeral Basic auth at both fetch sites", () => {
    expect(
      workflow.match(
        /checkout_basic_auth="\$\(printf 'x-access-token:%s' "\$CHECKOUT_TOKEN" \| base64 \| tr -d '\\n'\)"/g,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /http\.extraheader="AUTHORIZATION: basic \$\{checkout_basic_auth\}"/g,
      ),
    ).toHaveLength(2);
    expect(workflow.match(/::add-mask::\$checkout_basic_auth/g)).toHaveLength(
      2,
    );
    expect(workflow).not.toContain("AUTHORIZATION: bearer");
    expect(workflow).not.toMatch(
      /https:\/\/x-access-token:\$\{CHECKOUT_TOKEN\}@/,
    );
  });

  describe("real Git HTTP boundary", () => {
    const token = "checkout-test-token";
    const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
      "base64",
    );
    const expectedAuthorization = `basic ${basic}`;
    const root = mkdtempSync(join(tmpdir(), "eliza-checkout-auth-"));
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const checkout = join(root, "checkout");
    let server: ReturnType<typeof Bun.serve>;
    let remoteUrl: string;

    beforeAll(() => {
      mkdirSync(source);
      expect(git(source, ["init", "--initial-branch=main"]).exitCode).toBe(0);
      expect(
        git(source, ["config", "user.name", "Checkout Test"]).exitCode,
      ).toBe(0);
      expect(
        git(source, ["config", "user.email", "checkout-test@example.invalid"])
          .exitCode,
      ).toBe(0);
      writeFileSync(join(source, "receipt.txt"), "authenticated fetch\n");
      expect(git(source, ["add", "receipt.txt"]).exitCode).toBe(0);
      expect(
        git(source, ["commit", "-m", "seed authenticated remote"]).exitCode,
      ).toBe(0);
      expect(git(root, ["clone", "--bare", source, remote]).exitCode).toBe(0);
      expect(
        git(root, ["--git-dir", remote, "update-server-info"]).exitCode,
      ).toBe(0);

      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (request.headers.get("authorization") !== expectedAuthorization) {
            return new Response("authentication required", {
              status: 401,
              headers: { "www-authenticate": 'Basic realm="git"' },
            });
          }

          const pathname = decodeURIComponent(new URL(request.url).pathname);
          const relative = pathname.replace(/^\/+/, "");
          const resolved = normalize(join(root, relative));
          if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
            return new Response("invalid path", { status: 400 });
          }
          const file = Bun.file(resolved);
          return file
            .exists()
            .then((exists) =>
              exists
                ? new Response(file)
                : new Response("not found", { status: 404 }),
            );
        },
      });
      remoteUrl = `http://127.0.0.1:${server.port}/remote.git`;
    });

    afterAll(() => {
      server?.stop(true);
      rmSync(root, { force: true, recursive: true });
    });

    test("rejects bearer auth but fetches with the GitHub Basic scheme", async () => {
      const bearer = await gitAsync(root, [
        "-c",
        `http.extraheader=AUTHORIZATION: bearer ${token}`,
        "ls-remote",
        remoteUrl,
        "HEAD",
      ]);
      expect(bearer.exitCode).not.toBe(0);

      mkdirSync(checkout);
      expect(git(checkout, ["init"]).exitCode).toBe(0);
      expect(
        git(checkout, ["remote", "add", "origin", remoteUrl]).exitCode,
      ).toBe(0);
      const fetched = await gitAsync(checkout, [
        "-c",
        `http.extraheader=AUTHORIZATION: basic ${basic}`,
        "fetch",
        "--force",
        "--no-tags",
        "origin",
        "HEAD",
      ]);
      expect(fetched.exitCode).toBe(0);

      const config = readFileSync(join(checkout, ".git", "config"), "utf8");
      expect(config).toContain(remoteUrl);
      expect(config).not.toContain(token);
      expect(config).not.toContain(basic);
      expect(config).not.toContain("extraheader");
    });
  });
});
