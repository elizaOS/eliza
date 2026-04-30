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
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-extcreds-op-"));
    vault = createVault({
      workDir,
      masterKey: inMemoryMasterKey(generateMasterKey()),
    });
  });
  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /**
   * 1Password call helpers: every `op` invocation now starts with a
   * `whoami` probe to detect desktop-app integration. These responders
   * model the two paths:
   *   - `whoamiFails` → desktop-app inactive; CLI falls back to stored session
   *   - `whoamiOk`    → desktop-app active; no `--session=` flag is passed
   */
  const whoamiFails = {
    match: (_cmd: string, args: readonly string[]) =>
      args.length === 1 && args[0] === "whoami",
    throws: new Error("not signed in"),
  };
  const whoamiOk = {
    match: (_cmd: string, args: readonly string[]) =>
      args.length === 1 && args[0] === "whoami",
    stdout:
      '{"user_uuid":"u","account_uuid":"a","url":"my.1password.com","email":"x@y","user_type":"REGULAR"}',
  };

  it("throws BackendNotSignedInError when no session is stored", async () => {
    const calls: ExecCall[] = [];
    // Desktop-app probe fails (CLI not integrated), then session lookup
    // hits the empty vault and throws.
    const exec = fakeExec([whoamiFails], calls);
    await expect(listOnePasswordLogins(vault, exec)).rejects.toBeInstanceOf(
      BackendNotSignedInError,
    );
    // Exactly one call: the desktop-app whoami probe. The session
    // lookup happens against the vault (no exec call) and raises.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["whoami"]);
  });

  it("uses 1Password desktop-app integration when whoami succeeds without session", async () => {
    // No session stored. Desktop-app probe succeeds → list call must
    // omit any `--session=...` flag.
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
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
    const listCall = calls.find((c) => c.args.includes("list"));
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
        whoamiFails,
        {
          match: (_cmd, args) => args.includes("list"),
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
    const listCall = calls.find((c) => c.args.includes("list"));
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
              fields: [
                { purpose: "USERNAME", label: "username", value: "u" },
              ],
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
        whoamiFails,
        { match: (_cmd, args) => args.includes("list"), stdout: "[]" },
      ],
      calls,
    );
    const out = await listOnePasswordLogins(vault, exec);
    expect(out).toEqual([]);
    // Critically: we never invoke `op item get -` for an empty list.
    // The whoami probe + the list call = 2 calls; no enrichment.
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.args.includes("get"))).toHaveLength(0);
  });

  it("throws on malformed JSON", async () => {
    await vault.set("pm.1password.session", "TOKEN-OP", { sensitive: true });
    const calls: ExecCall[] = [];
    const exec = fakeExec(
      [
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
        whoamiFails,
        {
          match: (_cmd, args) => args.includes("get") && args.includes("abc111"),
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
    await expect(revealOnePasswordLogin(vault, exec, "")).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("reveal uses desktop-app integration when whoami succeeds", async () => {
    // No session stored.
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
        whoamiOk,
        {
          match: (_cmd, args) => args.includes("get") && args.includes("abc111"),
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
    workDir = await fs.mkdtemp(join(tmpdir(), "milady-extcreds-bw-"));
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
    await expect(revealBitwardenLogin(vault, exec, "x")).rejects.toThrow(/not a login/);
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
    await expect(revealBitwardenLogin(vault, exec, "x")).rejects.toThrow(/no password/);
  });
});
