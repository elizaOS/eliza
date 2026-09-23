/** Exercises real Ed25519 verification and policy-file replacement at host admission. */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type ApprovedProcessorPolicy,
  CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN,
  type ConfidentialHostConfiguration,
  createConfidentialHostPolicy,
} from "./confidential-host-policy";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eliza-processor-policy-"));
  directories.push(directory);
  const keys = generateKeyPairSync("ed25519");
  const identity = {
    appId: "ab12",
    composeHash: "a".repeat(64),
    osImageHash: "b".repeat(64),
    variant: "dstack-tdx" as const,
  };
  const config: ConfidentialHostConfiguration = {
    schema: "eliza-confidential-host-v1",
    agentId: randomUUID(),
    deploymentId: "synthetic-deployment",
    stateDirectory: directory,
    processorPolicyPath: join(directory, "policy.json"),
    processorPolicyPublicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    allowedRegions: ["eu-test"],
    verifier: {
      verifierPath: "/measured/bin/verifier",
      verifierSha256: "c".repeat(64),
      verifierConfigPath: "/measured/verifier.json",
      verifierConfigSha256: "d".repeat(64),
      ...identity,
    },
    listen: { host: "127.0.0.1", port: 0 },
    character: {
      name: "Synthetic host",
      bio: ["Synthetic fixture"],
      system: "Preserve context.",
    },
  };
  const policy: ApprovedProcessorPolicy = {
    schema: "eliza-confidential-processors-v1",
    agentId: config.agentId,
    deploymentId: config.deploymentId,
    revision: "revision-1",
    notBefore: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    routes: [
      {
        id: "text-primary",
        endpoint: "https://inference.example.test/v1/chat/completions",
        model: "reviewed-model",
        modelTypes: ["TEXT_LARGE"],
        adapter: "openai-compatible",
        transportIdentity: identity,
        processorApproval: {
          provider: "synthetic-provider",
          service: "private-inference",
          region: "eu-test",
          contractRef: "contract-fixture",
          approvalRef: "approval-fixture",
          expiresAt: Date.now() + 45_000,
        },
      },
    ],
  };
  async function publish(value: object = policy) {
    const payload = JSON.stringify(value);
    await writeFile(
      config.processorPolicyPath,
      JSON.stringify({
        payload,
        signature: sign(
          null,
          Buffer.from(CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN + payload),
          keys.privateKey,
        ).toString("base64"),
      }),
    );
  }
  await publish();
  return { config, policy, publish };
}

it("admits a real signed policy and binds the profile to its complete approval", async () => {
  const f = await fixture();
  const authority = createConfidentialHostPolicy(f.config);
  const first = authority.currentProfile();
  expect(first.routes).toEqual([
    {
      id: "text-primary",
      endpoint: f.policy.routes[0].endpoint,
      model: "reviewed-model",
      modelTypes: ["TEXT_LARGE"],
    },
  ]);
  expect(first.expiresAt).toBe(f.policy.routes[0].processorApproval.expiresAt);
  f.policy.routes[0].processorApproval.contractRef = "new-reviewed-contract";
  await f.publish();
  expect(authority.currentProfile().revision).not.toBe(first.revision);
});

const invalidPolicies: Array<
  [string, (policy: ApprovedProcessorPolicy) => void]
> = [
  [
    "another agent",
    (p) => {
      p.agentId = randomUUID();
    },
  ],
  [
    "another deployment",
    (p) => {
      p.deploymentId = "other";
    },
  ],
  [
    "expired policy",
    (p) => {
      p.expiresAt = Date.now() - 1;
    },
  ],
  [
    "future policy",
    (p) => {
      p.notBefore = Date.now() + 30_000;
    },
  ],
  [
    "expired contract approval",
    (p) => {
      p.routes[0].processorApproval.expiresAt = Date.now() - 1;
    },
  ],
  [
    "unapproved region",
    (p) => {
      p.routes[0].processorApproval.region = "unapproved";
    },
  ],
  [
    "unapproved measured inference identity",
    (p) => {
      p.routes[0].transportIdentity.composeHash = "e".repeat(64);
    },
  ],
  [
    "missing contract reference",
    (p) => {
      p.routes[0].processorApproval.contractRef = "";
    },
  ],
  [
    "plain HTTP",
    (p) => {
      p.routes[0].endpoint =
        "http://inference.example.test/v1/chat/completions";
    },
  ],
  [
    "duplicate route identity",
    (p) => {
      p.routes.push(structuredClone(p.routes[0]));
    },
  ],
];
it.each(invalidPolicies)(
  "rejects %s even with a valid signature",
  async (_name, mutate) => {
    const f = await fixture();
    mutate(f.policy);
    await f.publish();
    expect(() => createConfidentialHostPolicy(f.config)).toThrowError(
      expect.objectContaining({ code: "CONFIDENTIAL_HOST_POLICY_REJECTED" }),
    );
  },
);

it("rejects substituted signing authority and a replaced policy file", async () => {
  const f = await fixture();
  const authority = createConfidentialHostPolicy(f.config);
  const other = generateKeyPairSync("ed25519");
  expect(() =>
    createConfidentialHostPolicy({
      ...f.config,
      processorPolicyPublicKey: other.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    }),
  ).toThrow();
  await writeFile(
    f.config.processorPolicyPath,
    '{"payload":"synthetic-sensitive-control-input","signature":"invalid"}',
  );
  expect(() => authority.currentProfile()).toThrowError(
    expect.objectContaining({ code: "CONFIDENTIAL_HOST_POLICY_REJECTED" }),
  );
  try {
    authority.currentProfile();
  } catch (error) {
    // error-policy:J1 The test inspects the public sanitized boundary error.
    expect(String(error)).not.toContain("synthetic-sensitive-control-input");
  }
});

it("rejects signed fields outside the reviewed policy contract", async () => {
  const f = await fixture();
  await f.publish({ ...f.policy, allowUnapprovedPlugins: true });
  expect(() => createConfidentialHostPolicy(f.config)).toThrow();
});

it("keeps measured configuration immutable after construction", async () => {
  const f = await fixture();
  const authority = createConfidentialHostPolicy(f.config);
  const expected = authority.currentProfile();
  f.config.allowedRegions.push("unapproved-region");
  f.config.deploymentId = "changed-by-caller";
  expect(authority.currentProfile()).toEqual(expected);
  expect(() =>
    authority.config.allowedRegions.push("unapproved-region"),
  ).toThrow();
  expect(
    Reflect.set(authority.config, "deploymentId", "changed-deployment"),
  ).toBe(false);
  expect(Reflect.set(authority.config.verifier, "appId", "different-app")).toBe(
    false,
  );
  f.policy.routes[0].processorApproval.region = "unapproved-region";
  await f.publish();
  expect(() => authority.currentProfile()).toThrowError(
    expect.objectContaining({ code: "CONFIDENTIAL_HOST_POLICY_REJECTED" }),
  );
});
