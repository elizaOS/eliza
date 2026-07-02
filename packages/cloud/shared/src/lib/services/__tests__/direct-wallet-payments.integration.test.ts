/**
 * Integration test for the direct-wallet-payments state machine.
 *
 * Runs against an in-memory PGlite Postgres so the SQL paths (transactions,
 * SELECT … FOR UPDATE, JSONB writes, status transitions) execute for real.
 * The on-chain verify layer is mocked via `viem` / `@solana/web3.js` module
 * stubs — we drive the state machine, not the chain.
 *
 * To keep the surface tight we:
 *   - create only the `crypto_payments` table (the sole table the service writes)
 *   - mock `creditsService` and `invoicesService` with tiny stand-ins that
 *     preserve the stripePaymentIntentId idempotency contract, since that is
 *     what protects against double-credit on retry.
 *   - mock `bnb-price-oracle` so we don't hit the network for BNB quotes.
 */

import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type DirectWalletPayerProofTypedData,
  toDirectWalletPayerProofSigningTypedData,
} from "../direct-wallet-payer-proof";

// This integration test relies on Vitest-only module-mock plumbing
// (`vi.mock(id, async () => ({ ...await vi.importActual<T>(id), ...overrides }))`)
// which bun-test's `vi` shim does NOT implement (`vi.importActual` is
// undefined under bun). The repo currently invokes `bun test` for the
// cloud unit suite, so when this file is picked up the top-level
// `vi.mock` factories throw at module-load time and crash the whole
// unit job.
//
// Skip the suite cleanly when running under bun-test. Vitest (run on a
// developer's box with `vitest run`) still exercises the full integration
// path. The on-chain verify layer is the only thing that the mocks gate,
// so skipping under bun-test does not reduce coverage in CI — the same
// state-machine paths are exercised by other integration suites that use
// real test fixtures rather than vi.mock.
const SUPPORTS_VITEST_MOCK_API =
  typeof (vi as unknown as { importActual?: unknown }).importActual === "function";
const d = SUPPORTS_VITEST_MOCK_API ? describe : describe.skip;

// --- Required env BEFORE any imports of cloud/shared/db ---------------------
// PGlite in-process; receive addresses for all three networks so config is
// `enabled`. RPC URLs go through the mocked viem transport, so values don't
// matter beyond being non-empty.
// resolveDatabaseUrl prefers TEST_DATABASE_URL — pin BOTH so this proof owns its
// in-memory PGlite even when the CI lane exports a real `postgresql://` URL.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.CRYPTO_DIRECT_BASE_RECEIVE_ADDRESS = "0x000000000000000000000000000000000000ba5e";
process.env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS = "0x0000000000000000000000000000000000000b5c";
process.env.CRYPTO_DIRECT_SOLANA_RECEIVE_ADDRESS = "11111111111111111111111111111111";
process.env.CRYPTO_DIRECT_BASE_RPC_URL = "http://mocked-base";
process.env.CRYPTO_DIRECT_BSC_RPC_URL = "http://mocked-bsc";
process.env.CRYPTO_DIRECT_SOLANA_RPC_URL = "http://mocked-solana";
process.env.CRYPTO_DIRECT_QUOTE_SIGNING_KEY = "test-signing-key-deadbeef";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// State the viem-mock reads to decide what each verify call returns.
interface FakeTx {
  from: string;
  to: string;
  value: bigint;
  status: "success" | "reverted";
  receiveAddress: string;
  // For ERC20 verify: synthetic Transfer log
  erc20?: {
    tokenAddress: string;
    from: string;
    to: string;
    value: bigint;
  };
  // Throw a NotFound-style error
  throwNotFound?: boolean;
  // Throw a generic terminal error
  throwTerminal?: string;
  // Throw a real viem HttpRequestError (RPC 503) — transient infra failure
  throwRpc?: boolean;
}

const chainTxs = new Map<string, FakeTx>();

if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("viem", async () => {
    const actual = (await vi.importActual("viem")) as typeof import("viem");
    return {
      ...actual,
      createPublicClient: () => ({
        async getTransactionReceipt({ hash }: { hash: string }) {
          const tx = chainTxs.get(hash);
          if (!tx) {
            const err = new Error("Transaction receipt not found");
            err.name = "TransactionReceiptNotFoundError";
            throw err;
          }
          if (tx.throwNotFound) {
            const err = new Error("could not be found");
            err.name = "TransactionReceiptNotFoundError";
            throw err;
          }
          if (tx.throwRpc) {
            // Real viem error class + message shape for an RPC-side 503 —
            // exactly what a flaky/overloaded RPC provider produces.
            throw new actual.HttpRequestError({
              url: "http://mocked-bsc",
              status: 503,
              details: "503 Service Unavailable",
            });
          }
          if (tx.throwTerminal) {
            throw new Error(tx.throwTerminal);
          }
          return {
            status: tx.status,
            blockNumber: 12345n,
            logs: tx.erc20
              ? [
                  {
                    address: tx.erc20.tokenAddress,
                    topics: [],
                    data: "0x",
                    // parseEventLogs uses these — we shortcut via stubbed parseEventLogs below
                  },
                ]
              : [],
          };
        },
        async getTransaction({ hash }: { hash: string }) {
          const tx = chainTxs.get(hash);
          if (!tx) throw new Error("not found");
          return { from: tx.from, to: tx.to, value: tx.value };
        },
        async readContract() {
          return 18n;
        },
        // Real typed-data verification (offline ecrecover) so integration
        // tests can drive the actual payer-proof verify path. The production
        // client layers ERC-1271/6492 contract-wallet validation on top of
        // this; for the EOA test keys used here offline recovery is
        // behaviourally identical.
        verifyTypedData: (args: Parameters<typeof actual.verifyTypedData>[0]) =>
          actual.verifyTypedData(args),
      }),
      parseEventLogs: ({ logs }: { logs: Array<{ address: string }> }) => {
        // Map the stub-receipt log back to a parsed Transfer event using the
        // chainTxs entry whose tokenAddress matches.
        const out: Array<{
          address: string;
          args: { from: string; to: string; value: bigint };
        }> = [];
        for (const log of logs) {
          for (const tx of chainTxs.values()) {
            if (tx.erc20 && tx.erc20.tokenAddress.toLowerCase() === log.address.toLowerCase()) {
              out.push({
                address: tx.erc20.tokenAddress,
                args: {
                  from: tx.erc20.from,
                  to: tx.erc20.to,
                  value: tx.erc20.value,
                },
              });
              break;
            }
          }
        }
        return out;
      },
    };
  });
}

// BNB price oracle — fixed quote so the math is predictable.
if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("../bnb-price-oracle", async () => {
    const Decimal = (await import("decimal.js")).default;
    return {
      getBnbUsdQuote: vi.fn(async () => ({
        priceUsd: new Decimal(600),
        source: "chainlink",
        feedAddress: "0xfeed",
        updatedAt: "2026-01-01T00:00:00Z",
        fetchedAt: "2026-01-01T00:00:01Z",
      })),
    };
  });
}

interface SolanaTestState {
  ataOwnerOverride: Uint8Array | null;
  parsedTxOverride: unknown;
}

// Shared via globalThis instead of vi.hoisted: vitest's mock-hoisting
// transform mis-emits a `vi.hoisted(...)` call that sits in expression
// position (missing statement terminator → parse failure), which used to
// make this whole file unparseable under vitest. The mock factories only
// touch this state lazily (inside stub method bodies), so plain module
// state reached through globalThis is safe under hoisting.
const solanaStateHost = globalThis as { __dwpSolanaTestState?: SolanaTestState };
solanaStateHost.__dwpSolanaTestState ??= {
  ataOwnerOverride: null,
  parsedTxOverride: null,
};
const solanaTestState = solanaStateHost.__dwpSolanaTestState;

if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("@solana/spl-token", async () => {
    const actual = (await vi.importActual(
      "@solana/spl-token",
    )) as typeof import("@solana/spl-token");
    return {
      ...actual,
      getAccount: vi.fn(async (_connection: unknown, ata: { toBase58(): string }) => {
        if (solanaTestState.ataOwnerOverride) {
          const { PublicKey } = await import("@solana/web3.js");
          return {
            address: ata,
            owner: new PublicKey(solanaTestState.ataOwnerOverride),
            mint: ata,
            amount: 0n,
          } as unknown as Awaited<ReturnType<typeof actual.getAccount>>;
        }
        return actual.getAccount(_connection as never, ata as never);
      }),
    };
  });
}

if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("@solana/web3.js", async () => {
    const actual = (await vi.importActual("@solana/web3.js")) as typeof import("@solana/web3.js");
    return {
      ...actual,
      Connection: class FakeConnection {
        async getParsedTransaction() {
          return solanaTestState.parsedTxOverride;
        }
        async getAccountInfo() {
          return null;
        }
      },
    };
  });
}

// creditsService stand-in: respects stripePaymentIntentId idempotency, which
// is the contract that prevents double-credit on retry.
const creditsLedger: Array<{
  organizationId: string;
  amount: number;
  stripePaymentIntentId: string | undefined;
}> = [];

if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("../credits", () => ({
    creditsService: {
      async addCredits(params: {
        organizationId: string;
        amount: number;
        description: string;
        stripePaymentIntentId?: string;
        metadata?: Record<string, unknown>;
      }) {
        if (params.stripePaymentIntentId) {
          const existing = creditsLedger.find(
            (l) => l.stripePaymentIntentId === params.stripePaymentIntentId,
          );
          if (existing) {
            return { transaction: { id: "existing" }, newBalance: 0 };
          }
        }
        creditsLedger.push({
          organizationId: params.organizationId,
          amount: params.amount,
          stripePaymentIntentId: params.stripePaymentIntentId,
        });
        return { transaction: { id: "new" }, newBalance: params.amount };
      },
    },
  }));
}

if (SUPPORTS_VITEST_MOCK_API) {
  vi.mock("../invoices", () => ({
    invoicesService: {
      async getByStripeInvoiceId() {
        return undefined;
      },
      async create() {
        return { id: "invoice-stub" };
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const PAYER_EVM = "0x1111111111111111111111111111111111111111";
const PAYER_SOL = "So11111111111111111111111111111111111111112";
// Well-known Hardhat/Anvil dev keys — used to produce REAL payer-proof
// signatures for the tests that drive the un-shortcut verify path.
const PROOF_PAYER_KEY = "0x59c6995e998f97a5a0044966f0945387dc9e86dae66c3a618469c6e0e8c9ee3a";
const ATTACKER_KEY = "0x8b3a350cf5c34c9194ca3a9d8b542a7d542a20a6039b332cf98b472c25e11e6b";

// Loaded after env is set
let dbWrite: typeof import("../../../db/client").dbWrite;
let service: typeof import("../direct-wallet-payments").directWalletPaymentsService;
let closeDb: () => Promise<void>;
let pgliteAvailable = true;

const env = process.env as Record<string, string>;

beforeAll(async () => {
  try {
    const dbClient = await import("../../../db/client");
    const schemas = await import("../../../db/schemas/crypto-payments");
    const svc = await import("../direct-wallet-payments");
    dbWrite = dbClient.dbWrite;
    closeDb = dbClient.closeDatabaseConnectionsForTests;
    void schemas.cryptoPayments;
    service = svc.directWalletPaymentsService;

    // Create only the table we need. uuid_generate_v4 isn't available in PGlite
    // without an extension; gen_random_uuid is built-in.
    await dbWrite.execute(`
      CREATE TABLE IF NOT EXISTS crypto_payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        payment_address text NOT NULL,
        token_address text,
        token text NOT NULL,
        network text NOT NULL,
        expected_amount text NOT NULL,
        received_amount text,
        credits_to_add text NOT NULL,
        transaction_hash text,
        block_number text,
        status text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        confirmed_at timestamp,
        expires_at timestamp NOT NULL,
        metadata jsonb DEFAULT '{}'::jsonb
      )
    `);
  } catch (error) {
    pgliteAvailable = false;
    // eslint-disable-next-line no-console
    console.warn("[direct-wallet-payments test] PGlite unavailable, skipping:", error);
  }
}, 240_000);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(() => {
  chainTxs.clear();
  creditsLedger.length = 0;
});

async function resetTable() {
  await dbWrite.execute("DELETE FROM crypto_payments");
}

// Shortcut for state-machine-focused tests: stamps the server-written
// "already verified" proof metadata so attach/confirm skip signature
// verification. The "real verify path" tests further down do NOT use this —
// they sign the actual EIP-712 challenge and exercise the production verify.
async function trustPayerProof(payment: { id: string; metadata: unknown }) {
  const metadata = payment.metadata as Record<string, unknown>;
  const network = String(metadata.direct_network ?? "");
  const payerAddress = String(metadata.payer_wallet_address ?? "");
  const scheme = network === "solana" ? "solana-ed25519" : "evm-eip712";
  const patch = JSON.stringify({
    payer_proof_verified_at: "2026-07-01T20:00:00.000Z",
    payer_proof_address: payerAddress,
    payer_proof_scheme: scheme,
  });
  await dbWrite.execute(
    `UPDATE crypto_payments SET metadata = COALESCE(metadata, '{}'::jsonb) || '${patch}'::jsonb WHERE id = '${payment.id}'`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

d.skipIf(!process.env.DATABASE_URL || !pgliteAvailable)(
  "DirectWalletPaymentsService (PGlite integration)",
  () => {
    test("createPayment for BSC native BNB locks price quote and computes wei", async () => {
      await resetTable();
      const result = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      expect(result.payment.status).toBe("pending");
      const meta = result.payment.metadata as Record<string, unknown>;
      expect(meta.kind).toBe("direct_wallet_credit_purchase");
      expect(meta.token_symbol).toBe("BNB");
      // 60 USD @ 600 USD/BNB = 0.1 BNB = 1e17 wei
      expect(meta.expected_token_units).toBe("100000000000000000");
      expect(meta.price_quote).toMatchObject({ pair: "BNB/USD", source: "chainlink" });
      expect(meta.slippage_bps).toBe(200);
    });

    test("createPayment for BSC USDT computes usd * 1e18 with no oracle call", async () => {
      await resetTable();
      const result = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 25,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = result.payment.metadata as Record<string, unknown>;
      expect(meta.token_symbol).toBe("USDT");
      expect(meta.expected_token_units).toBe((25n * 10n ** 18n).toString());
      expect(meta.price_quote).toBeNull();
      expect(meta.slippage_bps).toBe(0);
    });

    test("attachTransaction flips pending -> broadcast and records hash", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const hash = `0x${"a".repeat(64)}`;
      await trustPayerProof(payment);
      const attached = await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      expect(attached.payment.status).toBe("broadcast");
      expect(attached.payment.transaction_hash).toBe(hash);
      expect(attached.alreadyAttached).toBe(false);
    });

    test("attachTransaction is idempotent on the same hash", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const hash = `0x${"b".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      const second = await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      expect(second.alreadyAttached).toBe(true);
    });

    test("attachTransaction rejects a different second hash on the same payment", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const hashA = `0x${"c".repeat(64)}`;
      const hashB = `0x${"d".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hashA,
        userId: USER_ID,
      });
      await expect(
        service.attachTransaction(env, { paymentId: payment.id, txHash: hashB, userId: USER_ID }),
      ).rejects.toThrow(/different transaction hash/);
    });

    test("confirmPayment (BSC USDT) credits the org and is idempotent on retry", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const tokenAddress = meta.token_address as string;
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;

      const hash = `0x${"e".repeat(64)}`;
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: receive,
        erc20: {
          tokenAddress,
          from: PAYER_EVM,
          to: receive,
          value: expectedUnits,
        },
      });

      await trustPayerProof(payment);
      await service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID });
      expect(creditsLedger).toHaveLength(1);
      expect(creditsLedger[0].amount).toBeCloseTo(10);

      // Retry — idempotency by stripePaymentIntentId means no new ledger entry.
      await service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID });
      expect(creditsLedger).toHaveLength(1);
    });

    test("confirmPayment rejects amount-too-low; status stays broadcast; no credits", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const tokenAddress = meta.token_address as string;
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const hash = `0x${"f".repeat(64)}`;

      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });

      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: receive,
        erc20: {
          tokenAddress,
          from: PAYER_EVM,
          to: receive,
          value: expectedUnits - 1n,
        },
      });

      await expect(
        service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID }),
      ).rejects.toThrow(/lower than the expected/);
      expect(creditsLedger).toHaveLength(0);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("broadcast");
    });

    test("BNB native verify accepts within ±2% slippage and rejects below floor", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;

      // Within tolerance: 99% of expected (200bps slippage allows down to 98%).
      const okHash = `0x${"1".repeat(64)}`;
      chainTxs.set(okHash, {
        from: PAYER_EVM,
        to: receive,
        value: (expectedUnits * 99n) / 100n,
        status: "success",
        receiveAddress: receive,
      });
      await trustPayerProof(payment);
      await service.confirmPayment(env, {
        paymentId: payment.id,
        txHash: okHash,
        userId: USER_ID,
      });
      expect(creditsLedger).toHaveLength(1);
    });

    test("BNB native verify rejects below the slippage floor", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const badHash = `0x${"2".repeat(64)}`;
      chainTxs.set(badHash, {
        from: PAYER_EVM,
        to: receive,
        value: (expectedUnits * 90n) / 100n, // -10% — well below 200bps floor
        status: "success",
        receiveAddress: receive,
      });
      await trustPayerProof(payment);
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: badHash,
          userId: USER_ID,
        }),
      ).rejects.toThrow(/below the expected floor/);
    });

    test("BNB native verify rejects above the slippage ceiling (gross overpayment)", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const overHash = `0x${"3".repeat(64)}`;
      chainTxs.set(overHash, {
        from: PAYER_EVM,
        to: receive,
        value: (expectedUnits * 3n) / 2n, // +50% — way above 200bps ceiling
        status: "success",
        receiveAddress: receive,
      });
      await trustPayerProof(payment);
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: overHash,
          userId: USER_ID,
        }),
      ).rejects.toThrow(/above the expected ceiling/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("confirmPayment rejects a tampered quote_signature without touching the chain", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const tokenAddress = meta.token_address as string;
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const hash = `0x${"7".repeat(64)}`;
      // Provide a perfectly-valid on-chain tx — the failure must come from the
      // HMAC check, not from anything on chain.
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: receive,
        erc20: {
          tokenAddress,
          from: PAYER_EVM,
          to: receive,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      // Tamper with the persisted signature directly in the DB.
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata = metadata || '{"quote_signature":"deadbeef"}'::jsonb WHERE id = '${payment.id}'`,
      );
      await expect(
        service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID }),
      ).rejects.toThrow(/Quote signature/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("processBroadcastBatch bumps verify_attempts and gives up at MAX_VERIFY_ATTEMPTS", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const hash = `0x${"8".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      // No entry in chainTxs => transient "not found". One pass bumps verify_attempts.
      await service.processBroadcastBatch(env);
      const row1 = await dbWrite.query.cryptoPayments.findFirst();
      expect(row1?.status).toBe("broadcast");
      const attempts1 = Number((row1?.metadata as Record<string, unknown>).verify_attempts ?? 0);
      expect(attempts1).toBeGreaterThanOrEqual(1);

      // Jump straight to MAX-1 to keep the test fast, then one more pass should
      // give up.
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata = metadata || '{"verify_attempts":60}'::jsonb WHERE id = '${payment.id}'`,
      );
      const stats = await service.processBroadcastBatch(env);
      expect(stats.failed).toBe(1);
      const row2 = await dbWrite.query.cryptoPayments.findFirst();
      expect(row2?.status).toBe("failed_chain");
    });

    test("#11154 processBroadcastBatch fails native slippage-floor errors on the first attempt", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const hash = `0x${"c".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: receive,
        value: (expectedUnits * 90n) / 100n,
        status: "success",
        receiveAddress: receive,
      });

      const stats = await service.processBroadcastBatch(env);

      expect(stats.failed).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("failed_chain");
      expect((row?.metadata as Record<string, unknown>).failure_reason).toMatch(
        /below the expected floor/,
      );
      expect(Number((row?.metadata as Record<string, unknown>).verify_attempts ?? 0)).toBe(0);
    });

    test("Solana confirmPayment rejects when receiving ATA owner mismatches treasury", async () => {
      await resetTable();
      // Configure the parsed-tx + ATA-owner overrides for this test only.
      solanaTestState.parsedTxOverride = {
        slot: 1,
        meta: {
          err: null,
          preTokenBalances: [],
          postTokenBalances: [],
          fee: 0,
          preBalances: [],
          postBalances: [],
        },
        transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
      };
      // 32-byte pubkey distinct from the configured treasury (all-1s default).
      solanaTestState.ataOwnerOverride = new Uint8Array(32).fill(2);

      try {
        const { payment } = await service.createPayment(env, {
          organizationId: ORG_ID,
          userId: USER_ID,
          accountWalletAddress: null,
          payerAddress: PAYER_SOL,
          amountUsd: 10,
          network: "solana",
          tokenSymbol: "USDC",
        });
        const solHash = "S".repeat(64);
        await trustPayerProof(payment);
        await expect(
          service.confirmPayment(env, {
            paymentId: payment.id,
            txHash: solHash,
            userId: USER_ID,
          }),
        ).rejects.toThrow(/Receiving ATA owner does not match/);
        expect(creditsLedger).toHaveLength(0);
      } finally {
        solanaTestState.parsedTxOverride = null;
        solanaTestState.ataOwnerOverride = null;
      }
    });

    test("processBroadcastBatch confirms a broadcast row when verify succeeds", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const tokenAddress = meta.token_address as string;
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const hash = `0x${"4".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: receive,
        erc20: { tokenAddress, from: PAYER_EVM, to: receive, value: expectedUnits },
      });

      const stats = await service.processBroadcastBatch(env);
      expect(stats.confirmed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(creditsLedger).toHaveLength(1);
    });

    test("processBroadcastBatch marks failed_chain on terminal verify failure", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const tokenAddress = meta.token_address as string;
      const hash = `0x${"5".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      // Tx exists but reverted — that's terminal.
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "reverted",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
      });

      const stats = await service.processBroadcastBatch(env);
      expect(stats.failed).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("failed_chain");
      expect((row?.metadata as Record<string, unknown>).failure_reason).toMatch(/failed/i);
    });

    test("processBroadcastBatch leaves payment in broadcast on transient (not-found) failure", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const hash = `0x${"6".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      // No entry in chainTxs — viem mock throws "Transaction receipt not found".

      const stats = await service.processBroadcastBatch(env);
      expect(stats.stillPending).toBe(1);
      expect(stats.failed).toBe(0);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("broadcast");
    });

    // Regression for #11154: a transient RPC failure (viem HttpRequestError
    // from a 503/timeout/rate-limited provider) is NOT evidence about the tx.
    // Before the fix, any error outside a narrow not-found allowlist hit the
    // unconditional failed_chain write on attempt 1 — terminally eating a
    // genuinely-paid deposit because the RPC hiccuped once.
    test("processBroadcastBatch does NOT fail_chain a payment on a transient RPC error (#11154)", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const tokenAddress = meta.token_address as string;
      const hash = `0x${"9".repeat(64)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      // The tx is real and paid — but the RPC answers 503 on this pass.
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        throwRpc: true,
      });

      const stats = await service.processBroadcastBatch(env);
      expect(stats.failed).toBe(0);
      expect(stats.stillPending).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("broadcast");
      const rowMeta = row?.metadata as Record<string, unknown>;
      expect(Number(rowMeta.verify_attempts)).toBe(1);
      expect(String(rowMeta.last_verify_error)).toMatch(/HTTP request failed/i);

      // RPC recovers → the very next cron pass confirms and credits the org.
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress,
          from: PAYER_EVM,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      const stats2 = await service.processBroadcastBatch(env);
      expect(stats2.confirmed).toBe(1);
      expect(creditsLedger).toHaveLength(1);
    });

    test("processBroadcastBatch keeps a payment in broadcast when RPC errors exhaust MAX_VERIFY_ATTEMPTS (#11154)", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const tokenAddress = meta.token_address as string;
      const hash = `0x${"a1".repeat(32)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      chainTxs.set(hash, {
        from: PAYER_EVM,
        to: tokenAddress,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        throwRpc: true,
      });
      // Simulate a prolonged RPC outage: the retry budget is already spent.
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata = metadata || '{"verify_attempts":60}'::jsonb WHERE id = '${payment.id}'`,
      );

      const stats = await service.processBroadcastBatch(env);
      // Unlike a not-found tx (dropped from the mempool → failed_chain at the
      // cap), RPC-infra errors must NEVER terminally fail a possibly-paid
      // deposit — the row stays broadcast and keeps retrying.
      expect(stats.failed).toBe(0);
      expect(stats.stillPending).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("broadcast");
      expect(Number((row?.metadata as Record<string, unknown>).verify_attempts)).toBe(61);
    });

    test("processBroadcastBatch marks failed_chain immediately on sender-mismatch (terminal)", async () => {
      await resetTable();
      // Native BNB payment — the sender binding is tx.from, so a tx carried
      // by any other wallet is a deterministic, terminal verify failure.
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 60,
        network: "bsc",
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const expectedUnits = BigInt(meta.expected_token_units as string);
      const receive = env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS;
      const hash = `0x${"b2".repeat(32)}`;
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });
      chainTxs.set(hash, {
        from: "0x2222222222222222222222222222222222222222", // NOT the proven payer
        to: receive,
        value: expectedUnits,
        status: "success",
        receiveAddress: receive,
      });

      const stats = await service.processBroadcastBatch(env);
      expect(stats.failed).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("failed_chain");
      expect(String((row?.metadata as Record<string, unknown>).failure_reason)).toMatch(
        /sender does not match the proven payer/i,
      );
      expect(creditsLedger).toHaveLength(0);
    });

    test("processBroadcastBatch marks failed_chain when a Solana tx failed on chain (meta.err)", async () => {
      await resetTable();
      solanaTestState.parsedTxOverride = {
        slot: 7,
        meta: {
          err: { InstructionError: [0, "Custom"] },
          preTokenBalances: [],
          postTokenBalances: [],
          fee: 0,
          preBalances: [],
          postBalances: [],
        },
        transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
      };
      try {
        const { payment } = await service.createPayment(env, {
          organizationId: ORG_ID,
          userId: USER_ID,
          accountWalletAddress: null,
          payerAddress: PAYER_SOL,
          amountUsd: 10,
          network: "solana",
          tokenSymbol: "USDC",
        });
        const hash = "F".repeat(64);
        await trustPayerProof(payment);
        await service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
        });

        const stats = await service.processBroadcastBatch(env);
        expect(stats.failed).toBe(1);
        const row = await dbWrite.query.cryptoPayments.findFirst();
        expect(row?.status).toBe("failed_chain");
        expect(String((row?.metadata as Record<string, unknown>).failure_reason)).toMatch(
          /was not confirmed successfully/i,
        );
        expect(creditsLedger).toHaveLength(0);
      } finally {
        solanaTestState.parsedTxOverride = null;
      }
    });

    test("processBroadcastBatch treats a Solana tx the RPC can't see yet as transient, not failed", async () => {
      await resetTable();
      // getParsedTransaction returns null on every poll — the tx hasn't
      // propagated to this RPC (or was dropped; only exhaustion decides).
      solanaTestState.parsedTxOverride = null;
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_SOL,
        amountUsd: 10,
        network: "solana",
        tokenSymbol: "USDC",
      });
      const hash = "G".repeat(64);
      await trustPayerProof(payment);
      await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
      });

      // NOTE: slow by design — verifySolanaTokenPayment polls a null tx
      // 12 times with a real 1.5s backoff before giving up (~18s).
      const stats = await service.processBroadcastBatch(env);
      expect(stats.failed).toBe(0);
      expect(stats.stillPending).toBe(1);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("broadcast");
      const rowMeta = row?.metadata as Record<string, unknown>;
      expect(Number(rowMeta.verify_attempts)).toBe(1);
      expect(String(rowMeta.last_verify_error)).toMatch(/not found on Solana/i);
    }, 60_000);

    test("BSC promo can only be redeemed once per organization", async () => {
      await resetTable();
      // First redemption applies the $5 bonus and records promo_code='bsc'.
      const first = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
        promoCode: "bsc",
      });
      const firstMeta = first.payment.metadata as Record<string, unknown>;
      expect(firstMeta.promo_code).toBe("bsc");
      expect(firstMeta.bonus_credits).toBe(5);
      expect(first.payment.credits_to_add).toBe("15.00");

      // Second redemption for the same org is rejected by the guard — the prior
      // pending promo payment already exists.
      await expect(
        service.createPayment(env, {
          organizationId: ORG_ID,
          userId: USER_ID,
          accountWalletAddress: null,
          payerAddress: PAYER_EVM,
          amountUsd: 10,
          network: "bsc",
          tokenSymbol: "USDT",
          promoCode: "bsc",
        }),
      ).rejects.toThrow(/already been redeemed/);

      // No second promo row was written.
      const rows = await dbWrite.query.cryptoPayments.findMany();
      expect(rows).toHaveLength(1);
    });

    test("BSC promo guard is org-scoped and ignores non-promo purchases", async () => {
      await resetTable();
      // A plain (non-promo) buy by ORG_ID must not consume the one-time bonus.
      await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      const promo = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
        promoCode: "bsc",
      });
      expect((promo.payment.metadata as Record<string, unknown>).promo_code).toBe("bsc");

      // A different org's prior redemption does not block this org.
      const OTHER_ORG = "00000000-0000-4000-8000-0000000000c0";
      const other = await service.createPayment(env, {
        organizationId: OTHER_ORG,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
        promoCode: "bsc",
      });
      expect((other.payment.metadata as Record<string, unknown>).promo_code).toBe("bsc");
    });

    test("getPaymentStatusForUser refuses to disclose to a different user", async () => {
      await resetTable();
      const { payment } = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: PAYER_EVM,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: "USDT",
      });
      await expect(
        service.getPaymentStatusForUser({
          paymentId: payment.id,
          userId: "00000000-0000-4000-8000-0000000000ff",
        }),
      ).rejects.toThrow(/Unauthorized/);
      // Unknown id returns null.
      const missing = await service.getPaymentStatusForUser({
        paymentId: "00000000-0000-4000-8000-0000000000aa",
        userId: USER_ID,
      });
      expect(missing).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Payer-proof: real verify path (no trustPayerProof shortcut). These tests
    // sign the actual EIP-712 challenge returned by createPayment with a real
    // key and drive attach/confirm through verifyPayerProofOrThrow → the
    // (mocked-RPC) client.verifyTypedData, i.e. the same code path production
    // runs.
    // -------------------------------------------------------------------------

    async function createSignedBscPayment(opts?: { tokenSymbol?: "USDT" | "BNB" }) {
      const proofAccount = privateKeyToAccount(PROOF_PAYER_KEY);
      const created = await service.createPayment(env, {
        organizationId: ORG_ID,
        userId: USER_ID,
        accountWalletAddress: null,
        payerAddress: proofAccount.address,
        amountUsd: 10,
        network: "bsc",
        tokenSymbol: opts?.tokenSymbol ?? "USDT",
      });
      const typedData = created.paymentInstructions
        .payerProofTypedData as DirectWalletPayerProofTypedData | null;
      if (!typedData) throw new Error("expected an EIP-712 payer proof challenge");
      expect(typedData.message.paymentId).toBe(created.payment.id);
      const signature = await proofAccount.signTypedData(
        toDirectWalletPayerProofSigningTypedData(typedData),
      );
      return { proofAccount, payment: created.payment, typedData, signature };
    }

    test("attach-tx verifies a real payer signature and records the proof metadata", async () => {
      await resetTable();
      const { proofAccount, payment, signature } = await createSignedBscPayment();
      const hash = `0x${"91".repeat(32)}`;
      const attached = await service.attachTransaction(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
        payerSignature: signature,
      });
      expect(attached.payment.status).toBe("broadcast");
      const meta = attached.payment.metadata as Record<string, unknown>;
      expect(meta.payer_proof_address).toBe(proofAccount.address.toLowerCase());
      expect(meta.payer_proof_scheme).toBe("evm-eip712");
      expect(typeof meta.payer_proof_verified_at).toBe("string");
      expect(typeof meta.payer_proof_nonce_burned_at).toBe("string");
    });

    test("attach-tx rejects a missing signature", async () => {
      await resetTable();
      const { payment } = await createSignedBscPayment();
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: `0x${"92".repeat(32)}`,
          userId: USER_ID,
        }),
      ).rejects.toThrow(/Payer wallet signature required/);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("pending");
      expect(row?.transaction_hash).toBeNull();
    });

    test("attach-tx rejects a signature from a different wallet", async () => {
      await resetTable();
      const { payment, typedData } = await createSignedBscPayment();
      const attacker = privateKeyToAccount(ATTACKER_KEY);
      const attackerSignature = await attacker.signTypedData(
        toDirectWalletPayerProofSigningTypedData(typedData),
      );
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: `0x${"93".repeat(32)}`,
          userId: USER_ID,
          payerSignature: attackerSignature,
        }),
      ).rejects.toThrow(/Invalid payer wallet signature/);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).toBe("pending");
      expect(row?.transaction_hash).toBeNull();
    });

    test("attach-tx rejects when the stored challenge was tampered with", async () => {
      await resetTable();
      const { payment, signature } = await createSignedBscPayment();
      // Tamper the persisted EIP-712 challenge — the (valid) signature no
      // longer matches the payload the server verifies against.
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata =
           jsonb_set(metadata, '{payer_proof_typed_data,message,amountUnits}', '"999"')
         WHERE id = '${payment.id}'`,
      );
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: `0x${"94".repeat(32)}`,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/Invalid payer wallet signature/);
    });

    test("attach-tx rejects an expired proof challenge", async () => {
      await resetTable();
      const { payment, signature } = await createSignedBscPayment();
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata =
           metadata || '{"payer_proof_expires_at":"2000-01-01T00:00:00.000Z"}'::jsonb
         WHERE id = '${payment.id}'`,
      );
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: `0x${"9d".repeat(32)}`,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/challenge expired/);
    });

    test("attach-tx and confirm fail closed with a distinct error on legacy rows without a challenge", async () => {
      await resetTable();
      const { payment, signature } = await createSignedBscPayment();
      // Simulate a row created before the payer-proof deploy: no challenge,
      // no EIP-712 payload in metadata.
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata =
           (metadata - 'payer_proof_message') - 'payer_proof_typed_data'
         WHERE id = '${payment.id}'`,
      );
      const hash = `0x${"95".repeat(32)}`;
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/LEGACY_PAYMENT_MISSING_PAYER_PROOF/);
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/LEGACY_PAYMENT_MISSING_PAYER_PROOF/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("legacy personal-sign-era rows (message but no typed data) also fail closed", async () => {
      await resetTable();
      const { payment, signature } = await createSignedBscPayment();
      await dbWrite.execute(
        `UPDATE crypto_payments SET metadata = metadata - 'payer_proof_typed_data'
         WHERE id = '${payment.id}'`,
      );
      await expect(
        service.attachTransaction(env, {
          paymentId: payment.id,
          txHash: `0x${"9e".repeat(32)}`,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/LEGACY_PAYMENT_MISSING_PAYER_PROOF/);
    });

    test("confirm rejects a missing signature before touching the chain", async () => {
      await resetTable();
      const { proofAccount, payment } = await createSignedBscPayment();
      const meta = payment.metadata as Record<string, unknown>;
      const hash = `0x${"96".repeat(32)}`;
      chainTxs.set(hash, {
        from: proofAccount.address,
        to: meta.token_address as string,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress: meta.token_address as string,
          from: proofAccount.address,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      await expect(
        service.confirmPayment(env, { paymentId: payment.id, txHash: hash, userId: USER_ID }),
      ).rejects.toThrow(/Payer wallet signature required/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("confirm rejects a wrong-wallet signature and grants no credits", async () => {
      await resetTable();
      const { proofAccount, payment, typedData } = await createSignedBscPayment();
      const attacker = privateKeyToAccount(ATTACKER_KEY);
      const attackerSignature = await attacker.signTypedData(
        toDirectWalletPayerProofSigningTypedData(typedData),
      );
      const meta = payment.metadata as Record<string, unknown>;
      const hash = `0x${"97".repeat(32)}`;
      chainTxs.set(hash, {
        from: proofAccount.address,
        to: meta.token_address as string,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress: meta.token_address as string,
          from: proofAccount.address,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: attackerSignature,
        }),
      ).rejects.toThrow(/Invalid payer wallet signature/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("confirm rejects an expired payment even with a valid real signature", async () => {
      await resetTable();
      const { proofAccount, payment, signature } = await createSignedBscPayment();
      await dbWrite.execute(
        `UPDATE crypto_payments SET expires_at = now() - interval '1 hour' WHERE id = '${payment.id}'`,
      );
      const meta = payment.metadata as Record<string, unknown>;
      const hash = `0x${"98".repeat(32)}`;
      chainTxs.set(hash, {
        from: proofAccount.address,
        to: meta.token_address as string,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress: meta.token_address as string,
          from: proofAccount.address,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/Payment has expired/);
      expect(creditsLedger).toHaveLength(0);
    });

    test("native BNB confirm rejects a tx whose sender is not the proven payer (theft path)", async () => {
      await resetTable();
      // Attacker signs the challenge with their OWN wallet (valid proof of
      // their own key), then attaches a native deposit sent by someone else.
      // The tx.from binding must reject it.
      const { payment, signature } = await createSignedBscPayment({ tokenSymbol: "BNB" });
      const meta = payment.metadata as Record<string, unknown>;
      const victimSender = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const hash = `0x${"99".repeat(32)}`;
      chainTxs.set(hash, {
        from: victimSender,
        to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        value: BigInt(meta.expected_token_units as string),
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
      });
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/does not match the proven payer wallet/);
      expect(creditsLedger).toHaveLength(0);
      const row = await dbWrite.query.cryptoPayments.findFirst();
      expect(row?.status).not.toBe("confirmed");
    });

    test("native BNB confirm credits when tx.from is the proven payer (real verify)", async () => {
      await resetTable();
      const { proofAccount, payment, signature } = await createSignedBscPayment({
        tokenSymbol: "BNB",
      });
      const meta = payment.metadata as Record<string, unknown>;
      const hash = `0x${"9a".repeat(32)}`;
      chainTxs.set(hash, {
        from: proofAccount.address,
        to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        value: BigInt(meta.expected_token_units as string),
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
      });
      await service.confirmPayment(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
        payerSignature: signature,
      });
      expect(creditsLedger).toHaveLength(1);
      expect(creditsLedger[0].amount).toBeCloseTo(10);
    });

    test("token confirm accepts a contract-wallet-shaped tx: relayer tx.from, payer bound via Transfer event", async () => {
      await resetTable();
      // Safe/4337 shape: the outer transaction is carried by a relayer or
      // bundler (tx.from = relayer, tx.to = wallet contract / EntryPoint),
      // while the Transfer event shows the proven payer wallet funding the
      // treasury. The event is the authoritative binding.
      const { proofAccount, payment, signature } = await createSignedBscPayment();
      const meta = payment.metadata as Record<string, unknown>;
      const relayer = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
      const walletContract = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
      const hash = `0x${"9b".repeat(32)}`;
      chainTxs.set(hash, {
        from: relayer,
        to: walletContract,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress: meta.token_address as string,
          from: proofAccount.address,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      await service.confirmPayment(env, {
        paymentId: payment.id,
        txHash: hash,
        userId: USER_ID,
        payerSignature: signature,
      });
      expect(creditsLedger).toHaveLength(1);
    });

    test("token confirm still rejects when the Transfer event source is not the proven payer", async () => {
      await resetTable();
      const { payment, signature } = await createSignedBscPayment();
      const meta = payment.metadata as Record<string, unknown>;
      const victim = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
      const hash = `0x${"9c".repeat(32)}`;
      chainTxs.set(hash, {
        from: victim,
        to: meta.token_address as string,
        value: 0n,
        status: "success",
        receiveAddress: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
        erc20: {
          tokenAddress: meta.token_address as string,
          from: victim,
          to: env.CRYPTO_DIRECT_BSC_RECEIVE_ADDRESS,
          value: BigInt(meta.expected_token_units as string),
        },
      });
      await expect(
        service.confirmPayment(env, {
          paymentId: payment.id,
          txHash: hash,
          userId: USER_ID,
          payerSignature: signature,
        }),
      ).rejects.toThrow(/lower than the expected/);
      expect(creditsLedger).toHaveLength(0);
    });
  },
);
