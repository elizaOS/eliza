import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserWorkspaceVaultDeps,
  type BrowserWorkspaceVaultLogin,
  browserWorkspaceWalletGrantKey,
  parseBrowserWorkspaceInputUrl,
  resolveBrowserWorkspaceSite,
  resolveBrowserWorkspaceVaultAutofill,
} from "./browser-workspace-host-identity.ts";

const BANK_LOGIN: BrowserWorkspaceVaultLogin = {
  source: "in-house",
  identifier: "bank.example:alice",
  domain: "bank.example",
  username: "alice",
  title: "Bank",
  updatedAt: 1,
};

function vaultDeps(
  urls: string[],
  calls: string[],
): BrowserWorkspaceVaultDeps<BrowserWorkspaceVaultLogin> {
  let reads = 0;
  return {
    readTabUrl: () => urls[Math.min(reads++, urls.length - 1)] ?? null,
    listSavedLogins: async (domain) => {
      calls.push(`list:${domain}`);
      return { logins: [BANK_LOGIN] };
    },
    getAutofillAllowed: async () => true,
    confirm: async () => true,
    revealSavedLogin: async (login) => {
      calls.push(`reveal:${login.identifier}`);
      return { username: "alice", password: "hunter2" };
    },
  };
}

const HINTS = [
  { kind: "username" as const, selector: "#user" },
  { kind: "password" as const, selector: "#pass" },
];

test("a claimed domain that differs from the tab's URL is refused", async () => {
  const calls: string[] = [];
  const outcome = await resolveBrowserWorkspaceVaultAutofill(
    { topFrame: true, claimedDomain: "bank.example", fieldHints: HINTS },
    vaultDeps(["https://evil.example/login"], calls),
  );
  assert.ok("refused" in outcome);
  assert.deepEqual(calls, []);
});

test("autofill uses the tab's site and fills on a match", async () => {
  const calls: string[] = [];
  const outcome = await resolveBrowserWorkspaceVaultAutofill(
    { topFrame: true, claimedDomain: "bank.example", fieldHints: HINTS },
    vaultDeps(["https://www.bank.example/login"], calls),
  );
  assert.deepEqual(outcome, {
    fields: { "#user": "alice", "#pass": "hunter2" },
  });
  assert.deepEqual(calls, [
    "list:www.bank.example",
    "reveal:bank.example:alice",
  ]);
});

test("a subframe or a non-web tab URL gets nothing", async () => {
  for (const [topFrame, url] of [
    [false, "https://bank.example/"],
    [true, "about:blank"],
    [true, "javascript:alert(1)"],
  ] as const) {
    const calls: string[] = [];
    const outcome = await resolveBrowserWorkspaceVaultAutofill(
      { topFrame, fieldHints: HINTS },
      vaultDeps([url], calls),
    );
    assert.ok("refused" in outcome, `${topFrame} ${url}`);
    assert.deepEqual(calls, []);
  }
});

test("navigation during consent is refused before the reveal", async () => {
  const calls: string[] = [];
  const outcome = await resolveBrowserWorkspaceVaultAutofill(
    { topFrame: true, fieldHints: HINTS },
    vaultDeps(["https://bank.example/login", "https://evil.example/"], calls),
  );
  assert.ok("refused" in outcome);
  assert.deepEqual(calls, ["list:bank.example"]);
});

test("a login saved for another subdomain is not offered", async () => {
  const calls: string[] = [];
  const outcome = await resolveBrowserWorkspaceVaultAutofill(
    { topFrame: true, fieldHints: HINTS },
    vaultDeps(["https://evil.bank.example/"], calls),
  );
  assert.deepEqual(outcome, { fields: {} });
  assert.deepEqual(calls, ["list:evil.bank.example"]);
});

test("wallet grants are keyed per wallet kind and full origin", () => {
  const key = (kind: "evm" | "solana", url: string) => {
    const site = resolveBrowserWorkspaceSite(url);
    assert.ok(site, url);
    return browserWorkspaceWalletGrantKey(kind, site);
  };
  const keys = new Set([
    key("evm", "https://app.example/"),
    key("evm", "http://app.example/"),
    key("evm", "https://app.example:8443/"),
    key("solana", "https://app.example/"),
  ]);
  assert.equal(keys.size, 4);
  assert.equal(
    key("evm", "https://app.example/a"),
    key("evm", "https://app.example/b"),
  );
  assert.equal(
    resolveBrowserWorkspaceSite("http://app.example/")?.label,
    "http://app.example",
  );
  assert.equal(
    resolveBrowserWorkspaceSite("https://app.example:8443/")?.label,
    "app.example:8443",
  );
  assert.equal(resolveBrowserWorkspaceSite("file:///etc/passwd"), null);
  assert.equal(resolveBrowserWorkspaceSite(null), null);
});

test("address bar input: host:port is a host, other schemes are rejected", () => {
  assert.deepEqual(parseBrowserWorkspaceInputUrl("localhost:3000"), {
    ok: true,
    url: "https://localhost:3000/",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("example.com:8443/x"), {
    ok: true,
    url: "https://example.com:8443/x",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("http://localhost:3000/a"), {
    ok: true,
    url: "http://localhost:3000/a",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("about:blank"), {
    ok: true,
    url: "about:blank",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("javascript:alert(1)"), {
    ok: false,
    reason: "unsupported",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("mailto:a@example.com"), {
    ok: false,
    reason: "unsupported",
  });
  assert.deepEqual(parseBrowserWorkspaceInputUrl("   "), {
    ok: false,
    reason: "empty",
  });
});
