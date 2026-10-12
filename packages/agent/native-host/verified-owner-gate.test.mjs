import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCredentialGate } from "./gateway.mjs";

test("verified owner survives credential rotation while session fingerprint fences stale processes", async () => {
  let key = "credential-one",
    bindingKey = key;
  let record = {
    version: 1,
    credentialId: "id",
    credential: key,
    owner: {
      authority: "https://api.example.test",
      userId: "a:b",
      organizationId: "c",
    },
  };
  const gate = createCredentialGate({
    readBinding: async () => ({
      mode: "cloud",
      fingerprint: createHash("sha256").update(bindingKey).digest("hex"),
    }),
    readCredential: async () => key,
    readVerifiedAccount: async () => record,
    verifyProcess: false,
    localMode: "local",
    localOwner: "local",
  });
  const first = await gate();
  assert.match(first, /^cloud-owner-v1:[a-f0-9]{64}$/);
  key = "credential-two";
  record = { ...record, credential: key };
  await assert.rejects(gate(), (e) => e.status === 409);
  bindingKey = key;
  assert.equal(await gate(), first);
  record.owner = { ...record.owner, userId: "a", organizationId: "b:c" };
  assert.notEqual(await gate(), first);
  record.owner = { ...record.owner, authority: "https://other.example.test" };
  const other = await gate();
  assert.notEqual(other, first);
  record.owner.extra = true;
  await assert.rejects(gate());
  delete record.owner.extra;
  record.credential = "old";
  await assert.rejects(gate());
  record.credential = key;
  record.owner.authority = "https://api.example.test/path";
  await assert.rejects(gate());
  record = null;
  await assert.rejects(gate());
});
