import assert from "node:assert/strict";
import test from "node:test";
import { createProviderKeySession } from "./provider-key-session.mjs";

test("mode changes retain independent keys and status never discloses them", () => {
  const session = createProviderKeySession();
  const call = (name, input) =>
    session[name]({ ...input, expectedRevision: session.status().revision });
  call("edit", {
    textKey: "synthetic-text-key",
    voiceKey: "synthetic-voice-key",
  });
  call("select", { mode: "own" });
  assert.equal(session.launchKeys().apiKey, "synthetic-text-key");
  call("select", { mode: "cloud" });
  assert.equal(session.launchKeys(), null);
  assert.deepEqual(session.status().keys, {
    text: { configured: true },
    voice: { configured: true },
  });
  call("edit", { textKey: "synthetic-replacement" });
  assert.equal(call("reveal", { key: "voice" }).value, "synthetic-voice-key");
  call("select", { mode: "own" });
  call("remove", { key: "text" });
  assert.equal(session.status().mode, "own");
  assert.equal(session.launchKeys().apiKey, undefined);
  assert.equal(session.launchKeys().cartesiaKey, "synthetic-voice-key");
  assert.equal(JSON.stringify(session.status()).includes("synthetic"), false);
});
test("stale owner/key revisions refuse mutation and disclosure; blank is not removal", () => {
  const session = createProviderKeySession(),
    expectedRevision = session.status().revision;
  session.edit({ expectedRevision, textKey: "synthetic-text-key" });
  for (const name of ["edit", "select", "remove", "reveal"])
    assert.throws(
      () =>
        session[name]({
          expectedRevision,
          key: "text",
          mode: "cloud",
          textKey: "synthetic-other",
        }),
      /changed/,
    );
  const current = session.status().revision;
  assert.throws(
    () => session.edit({ expectedRevision: current, textKey: "" }),
    /valid provider key/,
  );
  assert.equal(
    session.reveal({ expectedRevision: current, key: "text" }).value,
    "synthetic-text-key",
  );
  session.invalidate();
  assert.throws(
    () => session.reveal({ expectedRevision: current, key: "text" }),
    /changed/,
  );
  assert.equal(session.status().keys.text.configured, true);
  session.close();
  assert.throws(() => session.status(), /changed/);
  assert.throws(() => session.launchKeys(), /changed/);
});
