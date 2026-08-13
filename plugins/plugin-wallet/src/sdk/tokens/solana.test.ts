/**
 * SPL balance formatting (#19013). `formatSplBalance` is the pure production
 * formatter, and `SolanaWallet.getSplTokenBalance` is the live call path that
 * feeds it account/mint boundaries. A bug here misreports a wallet's balance.
 * Both surfaces now go through the bigint-safe `toHuman`, so pin the failure
 * modes it removes: 0-decimal balances losing significant trailing zeros
 * (multiples of ten), and positive-decimal `u64` values above
 * Number.MAX_SAFE_INTEGER being rounded by a Number() conversion. Also pin the
 * unchanged spelling for whole and zero decimal balances ("1.0" -> "1").
 *
 * The getSplTokenBalance suite mocks only Solana account/mint I/O so the real
 * method body (including formatSplBalance) still runs. Reverting production to
 * the old Number/toFixed/trailing-zero logic must fail these cases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "Owner1111111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";
const ATA = "Ata1111111111111111111111111111111111111111";

const solanaMocks = vi.hoisted(() => {
  class PublicKey {
    constructor(readonly value: string) {}
    toBase58() {
      return this.value;
    }
  }

  class Connection {
    constructor(
      readonly rpcUrl: string,
      readonly commitment?: string,
    ) {}
  }

  return {
    PublicKey,
    Connection,
    getAssociatedTokenAddress: vi.fn(async () => new PublicKey(ATA)),
    getAccount: vi.fn(),
    getMint: vi.fn(),
  };
});

vi.mock("@solana/web3.js", () => ({
  PublicKey: solanaMocks.PublicKey,
  Connection: solanaMocks.Connection,
}));

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: solanaMocks.getAssociatedTokenAddress,
  getAccount: solanaMocks.getAccount,
  getMint: solanaMocks.getMint,
}));

import { formatSplBalance, SolanaWallet } from "./solana.ts";

describe("formatSplBalance", () => {
  it("keeps significant trailing zeros for 0-decimal tokens", () => {
    // The original `toFixed(0).replace(/\.?0+$/, "")` stripped these to
    // "1", "12", and "1" respectively.
    expect(formatSplBalance(100n, 0)).toBe("100");
    expect(formatSplBalance(1200n, 0)).toBe("1200");
    expect(formatSplBalance(1_000_000n, 0)).toBe("1000000");
  });

  it("handles the 0-decimal zero/one boundaries", () => {
    expect(formatSplBalance(0n, 0)).toBe("0");
    expect(formatSplBalance(1n, 0)).toBe("1");
  });

  it("stays exact for 0-decimal balances above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 — routing this through Number() would round to
    // "9007199254740992"; the bigint path keeps it exact.
    expect(formatSplBalance(9_007_199_254_740_993n, 0)).toBe(
      "9007199254740993",
    );
  });

  it("formats tokens with decimals unchanged", () => {
    expect(formatSplBalance(1_500_000n, 6)).toBe("1.5");
    // Whole nonzero-decimal amounts keep their existing "1" rendering
    // (the decimals path is intentionally untouched by the 0-decimal fix).
    expect(formatSplBalance(1_000_000n, 6)).toBe("1");
    // A zero balance on a decimal token falls back to "0".
    expect(formatSplBalance(0n, 6)).toBe("0");
  });

  it("stays exact for positive-decimal balances above Number.MAX_SAFE_INTEGER", () => {
    // A Number() conversion rounds this to "9007199254.740992"; delegating to
    // the bigint-safe toHuman keeps the trailing 3 exact.
    expect(formatSplBalance(9_007_199_254_740_993n, 6)).toBe(
      "9007199254.740993",
    );
  });

  it("formats negative decimal amounts", () => {
    expect(formatSplBalance(-2_500_000n, 6)).toBe("-2.5");
  });
});

describe("SolanaWallet.getSplTokenBalance", () => {
  const wallet = new SolanaWallet({ rpcUrl: "http://localhost:8899" });

  beforeEach(() => {
    solanaMocks.getAssociatedTokenAddress.mockClear();
    solanaMocks.getAccount.mockReset();
    solanaMocks.getMint.mockReset();
    solanaMocks.getAssociatedTokenAddress.mockImplementation(
      async () => new solanaMocks.PublicKey(ATA),
    );
  });

  async function balanceFor(
    amount: bigint,
    decimals: number,
  ): Promise<{
    mint: string;
    rawBalance: bigint;
    humanBalance: string;
    decimals: number;
  }> {
    solanaMocks.getAccount.mockResolvedValue({ amount });
    solanaMocks.getMint.mockResolvedValue({ decimals });
    return wallet.getSplTokenBalance(MINT, OWNER);
  }

  it("keeps significant trailing zeros for 0-decimal token accounts", async () => {
    // Old path: Number(amount).toFixed(0).replace(/\.?0+$/, "") → "1" / "12".
    await expect(balanceFor(100n, 0)).resolves.toMatchObject({
      mint: MINT,
      rawBalance: 100n,
      humanBalance: "100",
      decimals: 0,
    });
    await expect(balanceFor(1200n, 0)).resolves.toMatchObject({
      humanBalance: "1200",
      decimals: 0,
    });
  });

  it("handles 0-decimal zero/one account boundaries", async () => {
    await expect(balanceFor(0n, 0)).resolves.toMatchObject({
      humanBalance: "0",
      decimals: 0,
    });
    await expect(balanceFor(1n, 0)).resolves.toMatchObject({
      humanBalance: "1",
      decimals: 0,
    });
  });

  it("stays exact above Number.MAX_SAFE_INTEGER on the live path", async () => {
    // 2^53 + 1 — Number() rounds this to 9007199254740992.
    await expect(balanceFor(9_007_199_254_740_993n, 0)).resolves.toMatchObject({
      rawBalance: 9_007_199_254_740_993n,
      humanBalance: "9007199254740993",
      decimals: 0,
    });

    // Number(raw)/1e6.toFixed(6).replace(...) would yield "9007199254.740992".
    await expect(balanceFor(9_007_199_254_740_993n, 6)).resolves.toMatchObject({
      humanBalance: "9007199254.740993",
      decimals: 6,
    });
  });

  it("formats nonzero-decimal mint balances (e.g. 1.5 USDC)", async () => {
    await expect(balanceFor(1_500_000n, 6)).resolves.toMatchObject({
      rawBalance: 1_500_000n,
      humanBalance: "1.5",
      decimals: 6,
    });
  });

  it("wires owner/mint through ATA lookup before formatting", async () => {
    solanaMocks.getAccount.mockResolvedValue({ amount: 100n });
    solanaMocks.getMint.mockResolvedValue({ decimals: 0 });

    await wallet.getSplTokenBalance(MINT, OWNER);

    expect(solanaMocks.getAssociatedTokenAddress).toHaveBeenCalledTimes(1);
    const [mintKey, ownerKey] =
      solanaMocks.getAssociatedTokenAddress.mock.calls[0] ?? [];
    expect(mintKey).toBeInstanceOf(solanaMocks.PublicKey);
    expect(ownerKey).toBeInstanceOf(solanaMocks.PublicKey);
    expect((mintKey as { value: string }).value).toBe(MINT);
    expect((ownerKey as { value: string }).value).toBe(OWNER);
    expect(solanaMocks.getAccount).toHaveBeenCalledWith(
      expect.any(solanaMocks.Connection),
      expect.objectContaining({ value: ATA }),
    );
    expect(solanaMocks.getMint).toHaveBeenCalledWith(
      expect.any(solanaMocks.Connection),
      expect.objectContaining({ value: MINT }),
    );
  });
});
