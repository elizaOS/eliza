import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateMasterKey } from "../src/crypto.js";
import {
  BackendNotSignedInError,
  type ExecFn,
  listBitwardenLogins,
  listOnePasswordLogins,
  revealBitwardenLogin,
  revealOnePasswordLogin,
} from "../src/external-credentials.js";
import { inMemoryMasterKey } from "../src/master-key.js";
import { createVault, type Vault } from "../src/vault.js";

interface ExecCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

function fakeExec(
  responses: ReadonlyArray<{
    readonly match: (cmd: string, args: readonly string[]) => boolean;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly throws?: Error;
  }>,
  calls: ExecCall[],
): ExecFn {
  return async (cmd, args, opts) => {
    calls.push({
      cmd,
      args,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    const matched = responses.find((r) => r.match(cmd, args));
    if (!matched) {
      throw new Error(`unexpected exec call: ${cmd} ${args.join(" ")}`);
    }
    if (matched.throws) throw matched.throws;
    return {
      stdout: matched.stdout ?? "",
      stderr: matched.stderr ?? "",
    };
  };
}

describe("external-credentials — 1Password", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-extcreds-op-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /**
   * 1Password call helpers. Every `op` invocation now begins with:
   *   1. `op account list --format=json` → pick the first account's
   *      shorthand to disambiguate. Empty array means no account; we
   *      drop the --account flag.
   *   2. `op [--account=<sh>] whoami` → desktop-integration probe.
   *
   * `whoamiFails` / `whoamiOk` match either form (with or without the
   * --account flag) so individual cases pick which side to test.
   */
  const accountListEmpty = {
    match: (_cmd: string, args: readonly string[]) =>
      args[0] === "account" && args[1] === "list",
    stdout: "[]",
  };
  /** Account-list responder for tests that exercise the desktop-integration
   * path. Provides one registered shorthand so the desktop probe can run. */
  const accountListMy = {
    match: (_cmd: string, args: readonly string[]) =>
      args[0] === "account" && args[1] === "list",
    stdout: JSON.stringify([
      { shorthand: "my", url: "my.1password.com", account_uuid: "abc" },
    ]),
  };
  /**
   * `whoamiFails` / `whoamiOk` model the desktop-integration probe.
   * The probe runs `op vault list --format=json` rather than `whoami`
   * because `op whoami` always demands a session token even when
   * desktop integration is active for vault queries.
   */
  const whoamiFails = {
    match: (_cmd: string, args: readonly string[]) =>
      args.includes("vault") && args.includes("list"),
    throws: new Error("not signed in"),
  };
  const whoamiOk = {
    match: (_cmd: string, args: readonly string[]) =>
      args.includes("vault") && args.includes("list"),
    stdout: "[]",
  };

  it("throws BackendNotSignedInError when no session is stored", async () => {
    const calls: ExecCall[] = [];
    // Empty account list → desktop-integration probe is skipped (no
    // shorthand to disambiguate against), session lookup hits the empty
    // vault and raises.
    const exec = fakeExec([accountListEmpty, whoamiFails], calls);
    await expect(listOnePasswordLogins(vault, exec)).rejects.toBeInstanceOf(
      BackendNotSignedInError,
    );
    // One call: just the account list probe. The vault probe is skipped
    // because no account is registered.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["account", "list", "--format=json"]);
  });

  it("uses 1Password desktop-app integration when whoami succeeds without session", async () => {
    // No session stored, but a 1P account IS registered → desktop probe
    // runs with --account=my and succeeds; list call must omit --session.
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListMy,
        whoamiOk,
        {
          match: (_cmd, args) => args.includes("list"),
          stdout: JSON.stringify([
            {
              id: "abc111",
              title: "GitHub",
              category: "LOGIN",
              additional_information: "alice",
              updated_at: "2024-06-01T12:00:00Z",
              urls: [{ href: "https://github.com" }],
            },
          ]),
        },
      ],
      calls,
    );
    const out = await listOnePasswordLogins(vault, exec);
    expect(out).toHaveLength(1);
    const listCall = calls.find(
      (c) => c.args.includes("item") && c.args.includes("list"),
    );
    expect(
      listCall?.args.some((a) => a.startsWith("--session=")),
      "desktop-app path must NOT pass --session",
    ).toBe(false);
  });

  it("returns metadata for Login items, never passwords", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });

    // op item list --format=json returns additional_information populated
    // with the username for Login items. No per-item enrichment needed for
    // the listing view.
    const listJson = JSON.stringify([
      {
        id: "abc111",
        title: "GitHub",
        category: "LOGIN",
        additional_information: "alice",
        updated_at: "2024-06-01T12:00:00Z",
        urls: [{ href: "https://github.com/login", primary: true }],
      },
      {
        id: "def222",
        title: "Slack",
        category: "LOGIN",
        additional_information: "bob@example.com",
        updated_at: "2024-05-01T12:00:00Z",
        urls: [{ href: "https://example.slack.com" }],
      },
    ]);

    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListEmpty,
        whoamiFails,
        {
          match: (_cmd, args) => args.includes("item") && args.includes("list"),
          stdout: listJson,
        },
      ],
      calls,
    );

    const out = await listOnePasswordLogins(vault, exec);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: "1password",
      externalId: "abc111",
      title: "GitHub",
      username: "alice",
      domain: "github.com",
      url: "https://github.com/login",
    });
    expect(out[1]).toMatchObject({
      source: "1password",
      externalId: "def222",
      title: "Slack",
      username: "bob@example.com",
      domain: "example.slack.com",
    });
    // Session token must be passed via --session=, not BW_SESSION env.
    const listCall = calls.find(
      (c) => c.args.includes("item") && c.args.includes("list"),
    );
    expect(listCall?.args).toContain("--session=TOKEN-OP");
    // No password field is included in any list response. The JSON
    // serialization mentions "1password" (the source id) but never carries
    // a `password` field key or any password value.
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/"password"\s*:/);
  });

  it("handles items without URLs (domain: null)", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListEmpty,
        whoamiFails,
        {
          match: (_cmd, args) => args.includes("list"),
          stdout: JSON.stringify([
            { id: "no-url", title: "Internal", category: "LOGIN", urls: [] },
          ]),
        },
        {
          match: (_cmd, args) => args.includes("get"),
          stdout: JSON.stringify([
            {
              id: "no-url",
              title: "Internal",
              fields: [{ purpose: "USERNAME", label: "username", value: "u" }],
            },
          ]),
        },
      ],
      calls,
    );
    const out = await listOnePasswordLogins(vault, exec);
    expect(out).toHaveLength(1);
    expect(out[0]?.domain).toBeNull();
    expect(out[0]?.url).toBeNull();
  });

  it("returns [] for empty list (skips enrichment)", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListEmpty,
        whoamiFails,
        { match: (_cmd, args) => args.includes("list"), stdout: "[]" },
      ],
      calls,
    );
    const out = await listOnePasswordLogins(vault, exec);
    expect(out).toEqual([]);
    // No account registered → desktop probe is skipped. Calls:
    // account list + item list (with stored session) = 2.
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.args.includes("get"))).toHaveLength(0);
  });

  it("throws on malformed JSON", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListEmpty,
        whoamiFails,
        { match: (_cmd, args) => args.includes("list"), stdout: "not-json" },
      ],
      calls,
    );
    await expect(listOnePasswordLogins(vault, exec)).rejects.toThrow();
  });

  it("reveals password for a single item", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const itemJson = JSON.stringify({
      id: "abc111",
      title: "GitHub",
      updated_at: "2024-06-01T12:00:00Z",
      urls: [{ href: "https://github.com/login", primary: true }],
      fields: [
        { purpose: "USERNAME", label: "username", value: "alice" },
        { purpose: "PASSWORD", label: "password", value: "hunter2" },
        { label: "one-time password", value: "TOTP-SEED" },
      ],
    });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListEmpty,
        whoamiFails,
        {
          match: (_cmd, args) =>
            args.includes("get") && args.includes("abc111"),
          stdout: itemJson,
        },
      ],
      calls,
    );
    const out = await revealOnePasswordLogin(vault, exec, "abc111");
    expect(out.password).toBe("hunter2");
    expect(out.username).toBe("alice");
    expect(out.totp).toBe("TOTP-SEED");
    expect(out.domain).toBe("github.com");
  });

  it("reveal throws when no externalId provided", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const exec = fakeExec([], []);
    await expect(
      revealOnePasswordLogin(vault, exec, ""),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("reveal uses desktop-app integration when whoami succeeds", async () => {
    // No session stored, but account is registered → desktop probe runs.
    const itemJson = JSON.stringify({
      id: "abc111",
      title: "GitHub",
      fields: [
        { purpose: "USERNAME", value: "alice" },
        { purpose: "PASSWORD", value: "hunter2" },
      ],
    });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        accountListMy,
        whoamiOk,
        {
          match: (_cmd, args) =>
            args.includes("get") && args.includes("abc111"),
          stdout: itemJson,
        },
      ],
      calls,
    );
    const out = await revealOnePasswordLogin(vault, exec, "abc111");
    expect(out.password).toBe("hunter2");
    const getCall = calls.find((c) => c.args.includes("get"));
    expect(
      getCall?.args.some((a) => a.startsWith("--session=")),
      "desktop-app reveal must NOT pass --session",
    ).toBe(false);
  });
});

describe("external-credentials — Bitwarden", () => {
  let workDir: string;
  let vault: Vault;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(join(tmpdir(), "eliza-extcreds-bw-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it("throws BackendNotSignedInError when no session is stored", async () => {
    const exec = fakeExec([], []);
    await expect(listBitwardenLogins(vault, exec)).rejects.toBeInstanceOf(
      BackendNotSignedInError,
    );
  });

  it("filters non-login items and returns metadata only", async () => {
    await vault.set("pm.bitwarden.session", "BW-TOKEN", { sensitive: true });
    const itemsJson = JSON.stringify([
      {
        id: "bw-1",
        name: "GitHub",
        type: 1,
        revisionDate: "2024-04-01T00:00:00Z",
        login: {
          username: "alice",
          password: "VERY-SECRET",
          uris: [{ uri: "https://github.com" }],
        },
      },
      {
        id: "bw-2",
        name: "A note",
        type: 2, // secure note — must be filtered out
      },
      {
        id: "bw-3",
        name: "Multi-URL",
        type: 1,
        revisionDate: "2024-04-02T00:00:00Z",
        login: {
          username: "bob",
          password: "ALSO-SECRET",
          uris: [
            { uri: "https://primary.example.com" },
            { uri: "https://alt.example.com" },
          ],
        },
      },
    ]);
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        {
          match: (cmd, args) => cmd === "bw" && args[0] === "list",
          stdout: itemsJson,
        },
      ],
      calls,
    );
    const out = await listBitwardenLogins(vault, exec);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: "bitwarden",
      externalId: "bw-1",
      username: "alice",
      domain: "github.com",
    });
    expect(out[1]?.domain).toBe("primary.example.com");
    // BW_SESSION is set in env — never passed as a flag.
    expect(calls[0]?.env?.BW_SESSION).toBe("BW-TOKEN");
    const text = JSON.stringify(out);
    expect(text).not.toContain("VERY-SECRET");
    expect(text).not.toContain("ALSO-SECRET");
  });

  it("returns [] when no items at all", async () => {
    await vault.set("pm.bitwarden.session", "BW-TOKEN", { sensitive: true });
    const exec = fakeExec(
      [
        {
          match: (cmd, args) => cmd === "bw" && args[0] === "list",
          stdout: "[]",
        },
      ],
      [],
    );
    expect(await listBitwardenLogins(vault, exec)).toEqual([]);
  });

  it("reveals a single Bitwarden item", async () => {
    await vault.set("pm.bitwarden.session", "BW-TOKEN", { sensitive: true });
    const itemJson = JSON.stringify({
      id: "bw-9",
      name: "Slack",
      type: 1,
      revisionDate: "2024-04-10T00:00:00Z",
      login: {
        username: "user@x.com",
        password: "p4ssw0rd",
        totp: "TOTP-SEED",
        uris: [{ uri: "https://slack.com" }],
      },
    });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
        {
          match: (cmd, args) => cmd === "bw" && args.includes("get"),
          stdout: itemJson,
        },
      ],
      calls,
    );
    const out = await revealBitwardenLogin(vault, exec, "bw-9");
    expect(out.password).toBe("p4ssw0rd");
    expect(out.totp).toBe("TOTP-SEED");
    expect(out.username).toBe("user@x.com");
    expect(out.domain).toBe("slack.com");
  });

  it("reveal throws when item is not a login", async () => {
    await vault.set("pm.bitwarden.session", "BW-TOKEN", { sensitive: true });
    const exec = fakeExec(
      [
        {
          match: (cmd, args) => cmd === "bw" && args.includes("get"),
          stdout: JSON.stringify({ id: "x", type: 2 }),
        },
      ],
      [],
    );
    await expect(revealBitwardenLogin(vault, exec, "x")).rejects.toThrow(
      /not a login/,
    );
  });

  it("reveal throws when password is empty", async () => {
    await vault.set("pm.bitwarden.session", "BW-TOKEN", { sensitive: true });
    const exec = fakeExec(
      [
        {
          match: (cmd, args) => cmd === "bw" && args.includes("get"),
          stdout: JSON.stringify({
            id: "x",
            type: 1,
            login: { username: "u", password: "" },
          }),
        },
      ],
      [],
    );
    await expect(revealBitwardenLogin(vault, exec, "x")).rejects.toThrow(
      /no password/,
    );
  });
});
