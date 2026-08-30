/**
 * Behavioral tests for the bundled Xquik request script. The harness replaces
 * curl at the transport boundary and inspects argument-safe request assembly.
 */
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../skills/xquik",
);
const scriptPath = join(skillDir, "scripts/xquik-read.sh");

interface ScriptResult {
  args: string[];
  status: number | null;
  stderr: string;
  stdout: string;
}

function runScript(
  args: string[],
  options: { includeKey?: boolean } = {},
): ScriptResult {
  const tempDir = mkdtempSync(join(tmpdir(), "eliza-xquik-skill-"));
  const capturePath = join(tempDir, "curl-args");
  const curlPath = join(tempDir, "curl");
  writeFileSync(
    curlPath,
    `#!/bin/sh
printf '%s\\0' "$@" > "$CAPTURE_FILE"
printf '%s\\n' '{"tweets":[],"has_next_page":false,"next_cursor":""}'
`,
  );
  chmodSync(curlPath, 0o755);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CAPTURE_FILE: capturePath,
    PATH: `${tempDir}:${process.env.PATH ?? ""}`,
  };
  if (options.includeKey !== false) {
    environment.XQUIK_API_KEY = "xq_test_key";
  } else {
    delete environment.XQUIK_API_KEY;
  }

  try {
    const result = spawnSync("/bin/sh", [scriptPath, ...args], {
      encoding: "utf8",
      env: environment,
    });
    const captured = existsSync(capturePath)
      ? readFileSync(capturePath, "utf8").split("\0").filter(Boolean)
      : [];
    return {
      args: captured,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function valueAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index + 1 < args.length ? [args[index + 1] as string] : [],
  );
}

describe("xquik-read.sh", () => {
  it("keeps reserved search characters inside encoded curl data arguments", () => {
    const query = 'elizaOS & from:test? "agents"';
    const cursor = "opaque+/=";
    const result = runScript(["search", query, "Top", "20", cursor]);

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(valueAfter(result.args, "--data-urlencode"), [
      `q=${query}`,
      "queryType=Top",
      "limit=20",
      `cursor=${cursor}`,
    ]);
    assert.ok(result.args.includes("https://xquik.com/api/v1/x/tweets/search"));
    assert.ok(!result.args.some((arg) => arg.includes(`?q=${query}`)));
    assert.match(result.stdout, /"tweets":\[\]/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /xq_test_key/);
  });

  it("rejects missing credentials before invoking the transport", () => {
    const result = runScript(["search", "elizaOS"], { includeKey: false });

    assert.strictEqual(result.status, 2);
    assert.deepStrictEqual(result.args, []);
    assert.match(result.stderr, /XQUIK_API_KEY is required/);
  });

  it("rejects invalid request bounds before invoking the transport", () => {
    const cases = [
      ["search", "elizaOS", "Popular"],
      ["search", "elizaOS", "Latest", "0"],
      ["tweet", "not-a-tweet-id"],
      ["thread", "123"],
      ["user", "user/name"],
      ["trends", "1", "51"],
    ];

    for (const args of cases) {
      const result = runScript(args);
      assert.strictEqual(result.status, 2, args.join(" "));
      assert.deepStrictEqual(result.args, [], args.join(" "));
      assert.notStrictEqual(result.stderr, "", args.join(" "));
    }
  });

  it("passes thread cursors as opaque query values", () => {
    const cursor = "DAACCgACGRElMJcAAA+/=";
    const result = runScript(["thread", "1893456789012345678", cursor]);

    assert.strictEqual(result.status, 0);
    assert.ok(
      result.args.includes(
        "https://xquik.com/api/v1/x/tweets/1893456789012345678/thread",
      ),
    );
    assert.deepStrictEqual(valueAfter(result.args, "--data-urlencode"), [
      `cursor=${cursor}`,
    ]);
  });

  it("builds direct post and profile lookup URLs", () => {
    const tweet = runScript(["tweet", "1893456789012345678"]);
    const user = runScript(["user", "elizaOS"]);

    assert.strictEqual(tweet.status, 0);
    assert.ok(
      tweet.args.includes(
        "https://xquik.com/api/v1/x/tweets/1893456789012345678",
      ),
    );
    assert.strictEqual(user.status, 0);
    assert.ok(user.args.includes("https://xquik.com/api/v1/x/users/elizaOS"));
  });

  it("builds bounded regional trend requests", () => {
    const result = runScript(["trends", "23424977", "20"]);

    assert.strictEqual(result.status, 0);
    assert.ok(result.args.includes("https://xquik.com/api/v1/trends"));
    assert.deepStrictEqual(valueAfter(result.args, "--data-urlencode"), [
      "woeid=23424977",
      "count=20",
    ]);
  });
});
