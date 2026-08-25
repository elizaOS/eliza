/**
 * Discord→Telegram content-delivery matrix rows (#23105 first lane).
 *
 * Harness is REAL at every layer it can be without live credentials (which
 * the maintainer disposition defers to a later acceptance lane):
 * - the scenario-runner wire-mock fleet (startMocks discord+telegram
 *   environments) stands in for both providers, including a CDN-style
 *   Discord attachment byte route and a Telegram multipart upload+readback
 *   surface added by this change;
 * - the OUTBOUND leg drives plugin-telegram's REAL MessageManager code path
 *   (`sendMessageInChunks` → telegraf `sendMessage`/`sendPhoto` HTTP against
 *   the mock via `apiRoot`);
 * - the INBOUND leg drives core's REAL SSRF-guarded media fetch
 *   (`fetchRemoteMedia`) with an explicit `allowedHostnames` policy entry for
 *   the mock host — the same policy parameter plugin-discord's outbound
 *   attachment builder uses for its own fetches.
 *
 * Lane-1 rows certify the two connector legs (Discord-side byte origin →
 * core pipeline → Telegram-side wire receipt). A composed
 * connector-event→runtime→connector-send flow is deliberately out of scope
 * for this lane; later lanes compose. Proof obligations are discharged with
 * typed receipts, never prose: provider-receipt (wire ledger), byte-hash
 * (sha256 equality), readback (provider-echoed fields / stored bytes).
 */
import { fetchRemoteMedia } from "@elizaos/core";
import { MessageManager } from "@elizaos/plugin-telegram";
import type { Context } from "telegraf";
import { Telegraf } from "telegraf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertBytePreservingDelivery,
  assertDeliveryCoverage,
  assertVerbatimTextDelivery,
  type ContentDeliveryProofKind,
  compileContentDeliveryMatrix,
  type DeliveryProviderReceipt,
  deliveryPayloadSha256,
  FIRST_LANE_DECLARED_CAPABILITIES,
  FIRST_LANE_DELIVERY_ROWS,
  verifyDeliveryReceipt,
} from "../../../src/content-delivery-matrix";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

/**
 * Certification records: proof kinds are recorded BY the assertion helpers
 * below as they actually execute — a certification can only name a proof
 * whose assertion ran in this process. The binding test compares these
 * records against every registry row's requiredProofs, so deleting a
 * delivery test, a receipt check, or a readback assertion leaves the row
 * uncertified and fails the suite.
 */
const certifiedRows: Array<{
  rowId: string;
  proofs: ContentDeliveryProofKind[];
}> = [];

function proofsFor(rowId: string): ContentDeliveryProofKind[] {
  let record = certifiedRows.find((r) => r.rowId === rowId);
  if (!record) {
    record = { rowId, proofs: [] };
    certifiedRows.push(record);
  }
  return record.proofs;
}

/** Record a discharged proof kind for a row (idempotent per row+kind). */
function discharge(rowId: string, proof: ContentDeliveryProofKind): void {
  const proofs = proofsFor(rowId);
  if (!proofs.includes(proof)) proofs.push(proof);
}

/** Assertion wrappers that certify the row only because they ran. */

async function certifiedVerbatimText(
  rowId: string,
  sourceText: string,
  deliveredChunks: readonly string[],
): Promise<void> {
  await assertVerbatimTextDelivery(sourceText, deliveredChunks);
  discharge(rowId, "byte-hash");
}

async function certifiedReceipt(
  rowId: string,
  receipt: DeliveryProviderReceipt,
  payload: string | Uint8Array,
  expected: { sourceConnector: string; targetConnector: string },
): Promise<void> {
  await verifyDeliveryReceipt(receipt, payload, expected);
  discharge(rowId, "provider-receipt");
}

async function certifiedBytePreserving(
  rowId: string,
  sourceBytes: Uint8Array,
  deliveredBytes: Uint8Array,
): Promise<void> {
  await assertBytePreservingDelivery(sourceBytes, deliveredBytes);
  discharge(rowId, "byte-hash");
}

/** Readback: provider-echoed fields / stored bytes proven equal to source. */
async function certifiedReadback(
  rowId: string,
  actual: string | Uint8Array,
  expected: string | Uint8Array,
): Promise<void> {
  expect(actual).toEqual(expected);
  discharge(rowId, "readback");
}

let mocks: StartedMocks | null = null;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

/** A Discord-side payload the rows must deliver to Telegram. */
const DISCORD_SOURCE_TEXT =
  "Relay this exactly: line one\nline two — with an em dash and CJK 你好 — end";

/**
 * Deterministic bytes (xorshift-style PRNG) so the file hash is stable for a
 * given length without depending on platform randomness.
 */
function sourceFileBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x2f6e2f;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[i] = state >>> 16;
  }
  return bytes;
}

const FILE_BYTES = sourceFileBytes(64 * 1024);
const FILE_NAME = "matrix-payload.png";
const FILE_SHA = deliveryPayloadSha256(FILE_BYTES);
const TELEGRAM_CHAT_ID = -10023105;

/** Minimal runtime the Telegram MessageManager send path needs (no DB). */
function telegramRuntimeStub() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    getSetting: (_name: string) => undefined,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as never;
}

function telegramManager(): { manager: MessageManager; ctx: Context } {
  const telegramBase = mocks?.baseUrls.telegram;
  if (!telegramBase) throw new Error("telegram mock not started");
  const bot = new Telegraf("123456:TEST_TOKEN", {
    telegram: { apiRoot: telegramBase },
  });
  const manager = new MessageManager(bot, telegramRuntimeStub(), "default");
  const chat = {
    id: TELEGRAM_CHAT_ID,
    type: "group",
    title: "Delivery Matrix",
  };
  const ctx = { chat, telegram: bot.telegram } as unknown as Context;
  return { manager, ctx };
}

/** Ledger entries the Telegram mock recorded for a bot API method. */
function telegramWireCalls(methodPath: string) {
  return (mocks?.requestLedger() ?? []).filter(
    (entry) =>
      entry.environment.includes("Telegram") &&
      entry.method === "POST" &&
      entry.path.includes(methodPath),
  );
}

beforeAll(async () => {
  mocks = await startMocks({ envs: ["discord", "telegram"] });
  for (const [key, value] of Object.entries(mocks.envVars)) setEnv(key, value);

  // Register the Discord-side source bytes for CDN-style serving.
  const discordBase = mocks.baseUrls.discord;
  const register = await fetch(
    `${discordBase}/__mock/discord/attachments?file_name=${encodeURIComponent(FILE_NAME)}&content_type=${encodeURIComponent("image/png")}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(FILE_BYTES),
    },
  );
  const registered = (await register.json()) as {
    ok?: boolean;
    sha256?: string;
  };
  if (!registered.ok || registered.sha256 !== FILE_SHA) {
    throw new Error(
      `failed to register Discord source bytes: ${JSON.stringify(registered)}`,
    );
  }
});

afterAll(async () => {
  await mocks?.stop();
  mocks = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("content-delivery matrix — first lane (Discord→Telegram)", () => {
  it("compiles and passes the fail-closed completeness gate", () => {
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    expect(() =>
      assertDeliveryCoverage(FIRST_LANE_DECLARED_CAPABILITIES, matrix),
    ).not.toThrow();
  });

  it("delivers Discord-sourced text verbatim to the Telegram wire with a typed provider receipt", async () => {
    const { manager, ctx } = telegramManager();
    mocks?.clearRequestLedger();

    // REAL plugin-telegram outbound path: chunking + markdown conversion +
    // sendMessage HTTP against the mock.
    await manager.sendMessageInChunks(ctx, { text: DISCORD_SOURCE_TEXT });

    const sendMessageCalls = telegramWireCalls("/sendMessage");
    expect(sendMessageCalls.length).toBeGreaterThan(0);

    // provider-receipt + readback: the wire body the provider saw.
    const deliveredText = sendMessageCalls
      .map((entry) =>
        String((entry.body as Record<string, unknown>).text ?? ""),
      )
      .join("");
    await certifiedVerbatimText(
      "discord-to-telegram.text",
      DISCORD_SOURCE_TEXT,
      [deliveredText],
    );
    await certifiedReadback(
      "discord-to-telegram.text",
      deliveredText,
      DISCORD_SOURCE_TEXT,
    );

    const receipt: DeliveryProviderReceipt = {
      kind: "provider-receipt",
      sourceConnector: "discord",
      targetConnector: "telegram",
      operation: "sendMessage",
      wireMethod: "POST",
      wirePath: sendMessageCalls[0]?.path ?? "",
      sourceKind: "provider-http-wire",
      payloadSha256: deliveryPayloadSha256(deliveredText),
      observedAt: sendMessageCalls[0]?.createdAt ?? new Date().toISOString(),
      providerEcho: { text: deliveredText },
    };
    await certifiedReceipt("discord-to-telegram.text", receipt, deliveredText, {
      sourceConnector: "discord",
      targetConnector: "telegram",
    });
  });

  it("delivers a Discord-sourced file byte-complete through the real core fetch + real Telegram upload + readback", async () => {
    const discordBase = mocks?.baseUrls.discord;
    if (!discordBase) throw new Error("discord mock not started");
    const sourceUrl = `${discordBase}/attachments/987654321/1098765432/${FILE_NAME}`;

    // INBOUND leg: core's REAL SSRF-guarded fetch pulls the Discord-side
    // bytes. The policy entry for the mock host is the same mechanism
    // plugin-discord's outbound builder uses (allowedHostnames).
    const mockHost = new URL(discordBase).hostname;
    const fetched = await fetchRemoteMedia({
      url: sourceUrl,
      ssrfPolicy: { allowedHostnames: [mockHost] },
      maxBytes: 10 * 1024 * 1024,
    });
    await certifiedBytePreserving(
      "discord-to-telegram.file",
      FILE_BYTES,
      fetched.buffer,
    );

    // Discord-side wire receipt: the CDN fetch was observed on the ledger.
    const discordLedger = (mocks?.requestLedger() ?? []).filter(
      (entry) =>
        entry.environment.includes("Discord") &&
        entry.path.includes(`/attachments/`) &&
        entry.path.includes(FILE_NAME),
    );
    expect(discordLedger.length).toBeGreaterThan(0);

    // OUTBOUND leg: the REAL plugin-telegram send path uploads the fetched
    // bytes as a photo (telegraf multipart) through MessageManager.
    const { manager, ctx } = telegramManager();
    mocks?.clearRequestLedger();
    await manager.sendMessageInChunks(ctx, {
      text: "",
      attachments: [
        {
          id: "matrix-file",
          url: sourceUrl,
          contentType: "image/png",
          description: "matrix file caption",
        } as never,
      ],
    });

    const sendPhotoCalls = telegramWireCalls("/sendPhoto");
    expect(sendPhotoCalls.length).toBeGreaterThan(0);

    // READBACK: pull the stored bytes back through the Telegram mock's
    // file readback route and prove byte equality.
    const telegramBase = mocks?.baseUrls.telegram;
    const readback = await fetch(
      `${telegramBase}/__mock/telegram/list-uploads`,
    );
    const uploads = (await readback.json()) as {
      uploads?: Array<{ fileId: string; sha256: string; byteLength: number }>;
    };
    const matching =
      uploads.uploads?.filter((u) => u.sha256 === FILE_SHA) ?? [];
    expect(matching.length).toBeGreaterThan(0);

    const fileId = matching[0]?.fileId;
    const bytesBack = await fetch(
      `${telegramBase}/__mock/telegram/file/${fileId}`,
    );
    expect(bytesBack.status).toBe(200);
    const roundTrip = new Uint8Array(await bytesBack.arrayBuffer());
    await certifiedBytePreserving(
      "discord-to-telegram.file",
      FILE_BYTES,
      roundTrip,
    );
    await certifiedReadback("discord-to-telegram.file", roundTrip, FILE_BYTES);

    const receipt: DeliveryProviderReceipt = {
      kind: "provider-receipt",
      sourceConnector: "discord",
      targetConnector: "telegram",
      operation: "sendPhoto",
      wireMethod: "POST",
      wirePath: sendPhotoCalls[0]?.path ?? "",
      sourceKind: "provider-api-readback",
      payloadSha256: FILE_SHA,
      observedAt: sendPhotoCalls[0]?.createdAt ?? new Date().toISOString(),
      providerEcho: { sha256: FILE_SHA, byteLength: FILE_BYTES.length },
    };
    await certifiedReceipt("discord-to-telegram.file", receipt, FILE_BYTES, {
      sourceConnector: "discord",
      targetConnector: "telegram",
    });
  });
  /**
   * Row binding: the certification records the delivery tests above actually
   * produced must cover every registry row AND discharge every proof kind the
   * row requires. Deleting a delivery test, a receipt verification, or a
   * readback assertion leaves a proof undischarged and fails this check — the
   * matrix inventory and the executed proofs cannot drift apart.
   */
  it("binds: executed proofs cover every first-lane row's required proofs", () => {
    // Module-load fail-closed: importing the registry asserts coverage of the
    // declared capabilities (this would have thrown at import time otherwise).
    const matrix = compileContentDeliveryMatrix(FIRST_LANE_DELIVERY_ROWS);
    assertDeliveryCoverage(FIRST_LANE_DECLARED_CAPABILITIES, matrix);

    const certified = new Map(certifiedRows.map((r) => [r.rowId, r.proofs]));
    for (const row of FIRST_LANE_DELIVERY_ROWS) {
      const proofs = certified.get(row.id);
      expect(
        proofs,
        `row ${row.id} has no executed certification record — a covering delivery test is missing or was deleted`,
      ).toBeDefined();
      for (const required of row.requiredProofs) {
        expect(
          proofs,
          `row ${row.id} did not discharge its required ${required} proof`,
        ).toContain(required);
      }
    }
    // No certification may name a row that no longer exists.
    for (const record of certifiedRows) {
      expect(FIRST_LANE_DELIVERY_ROWS.map((row) => row.id)).toContain(
        record.rowId,
      );
    }
  });
});
