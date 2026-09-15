/**
 * Pins that the consumer usage log writer isolates a crash-torn line: the
 * record written after an interrupted append lands on its own line and stays
 * parseable. The reader's tolerance of the torn line itself is a separate
 * contract (#30530); this file asserts on the bytes the writer produces. Real
 * temp state directory, no transport.
 */
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAccountPoolConsumerMeteringForTests,
  createAccountPoolConsumerKey,
  recordAccountPoolConsumerUsage,
} from "./account-pool-consumer-metering.js";

let stateDir: string;
let prevStateDir: string | undefined;
let prevBrokerSecret: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevBrokerSecret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  stateDir = mkdtempSync(path.join(tmpdir(), "consumer-metering-torn-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET =
    "admin-broker-secret-admin-broker-secret";
  __resetAccountPoolConsumerMeteringForTests();
});

afterEach(() => {
  __resetAccountPoolConsumerMeteringForTests();
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevBrokerSecret === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = prevBrokerSecret;
  rmSync(stateDir, { recursive: true, force: true });
});

async function seedRecord(consumerId: string, tokens: number): Promise<void> {
  await recordAccountPoolConsumerUsage({
    ts: 1_800_000_000_000,
    consumerId,
    consumerLabel: "torn-append",
    model: "claude-test",
    streaming: false,
    status: 200,
    latencyMs: 5,
    usage: {
      input_tokens: tokens,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

describe("consumer usage log after a crash-torn line", () => {
  it("writes the next record on its own line, intact", async () => {
    const created = createAccountPoolConsumerKey({ label: "torn" });
    if (!created) throw new Error("failed to create key");
    await seedRecord(created.consumer.id, 10);

    // An append interrupted before its trailing newline. The bytes stay in
    // place; the next append must not land on the same line.
    const dir = path.join(stateDir, "account-pool", "consumer-usage");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const file = path.join(dir, files[0]);
    const torn = `{"consumerId":"${created.consumer.id}","ts":1`;
    appendFileSync(file, torn);

    await seedRecord(created.consumer.id, 7);

    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(torn);
    const intact = JSON.parse(lines[2]) as { totalTokens: number };
    expect(intact.totalTokens).toBe(7);
    expect(JSON.parse(lines[0])).toMatchObject({ totalTokens: 10 });
  });
});
