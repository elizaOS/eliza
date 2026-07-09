/** Signal credential probes exercise linked-account checks without network. */
import assert from "node:assert/strict";
import test from "node:test";
import { probeSignal } from "./credential-probes.mjs";

function lookup(values) {
  return (name) => values[name];
}

test("Signal REST probe requires at least one linked account", async () => {
  const urls = [];
  const result = await probeSignal(
    lookup({ SIGNAL_HTTP_URL: "http://signal" }),
    {
      fetchJsonFn: async (url) => {
        urls.push(url);
        return url.endsWith("/v1/about")
          ? { httpOk: true, status: 200, body: { version: "0.13" } }
          : { httpOk: true, status: 200, body: [] };
      },
    },
  );
  assert.deepEqual(urls, [
    "http://signal/v1/about",
    "http://signal/v1/accounts",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "no linked Signal account");
});

test("Signal REST probe verifies the selected account without exposing it", async () => {
  const account = "+15551234567";
  const result = await probeSignal(
    lookup({
      SIGNAL_HTTP_URL: "http://signal/",
      SIGNAL_ACCOUNT_NUMBER: account,
    }),
    {
      fetchJsonFn: async (url) => ({
        httpOk: true,
        status: 200,
        body: url.endsWith("/v1/accounts") ? [account] : { version: "0.13" },
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.match(result.detail, /1 linked account/);
  assert.match(result.detail, /…4567 present/);
  assert.equal(result.detail.includes(account), false);
});

test("Signal CLI probe runs version and listAccounts before passing", async () => {
  const calls = [];
  const result = await probeSignal(
    lookup({
      SIGNAL_CLI_PATH: "/opt/signal-cli",
      SIGNAL_ACCOUNT_NUMBER: "+15551234567",
    }),
    {
      spawnSyncFn: (command, args) => {
        calls.push([command, ...args]);
        return args[0] === "--version"
          ? { status: 0, stdout: "signal-cli 0.13.20\n" }
          : { status: 0, stdout: "Number: +15551234567\n" };
      },
    },
  );
  assert.deepEqual(calls, [
    ["/opt/signal-cli", "--version"],
    ["/opt/signal-cli", "listAccounts"],
  ]);
  assert.equal(result.ok, true);
  assert.match(result.detail, /…4567 present/);
  assert.equal(result.detail.includes("+15551234567"), false);
});

test("Signal CLI probe rejects warning-only account output", async () => {
  const result = await probeSignal(
    lookup({
      SIGNAL_CLI_PATH: "signal-cli",
      SIGNAL_ACCOUNT_NUMBER: "+15551234567",
    }),
    {
      spawnSyncFn: (_command, args) =>
        args[0] === "--version"
          ? { status: 0, stdout: "signal-cli 0.13.20\n" }
          : { status: 0, stdout: "WARN no account configured\n" },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.detail, "no linked Signal account");
});
