import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  loadWalletTradingProfile,
  readWalletTradeLedgerStore,
  recordWalletTradeLedgerEntry,
  resolveWalletTradingProfileFilePath,
  updateWalletTradeLedgerEntryStatus,
} from "./trading-profile.ts";

const directories: string[] = [];
function stateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-ledger-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it("reopens persisted swaps and status transitions through the wallet-owned profile reader", () => {
  const stateDir = stateDirectory();
  expect(readWalletTradeLedgerStore(stateDir).entries).toEqual([]);
  recordWalletTradeLedgerEntry(
    {
      hash: "0xtransaction",
      source: "manual",
      side: "buy",
      tokenAddress: "0x1234567890123456789012345678901234567890",
      slippageBps: 50,
      route: ["BNB", "TOKEN"],
      quoteIn: { symbol: "BNB", amount: "1", amountWei: "1000000000000000000" },
      quoteOut: {
        symbol: "TOKEN",
        amount: "10",
        amountWei: "10000000000000000000",
      },
      status: "pending",
      confirmations: 0,
      nonce: 1,
      blockNumber: null,
      gasUsed: null,
      effectiveGasPriceWei: null,
      explorerUrl: "",
    },
    stateDir,
  );
  expect(readWalletTradeLedgerStore(stateDir).entries[0]).toMatchObject({
    hash: "0xtransaction",
    status: "pending",
  });
  updateWalletTradeLedgerEntryStatus(
    "0xtransaction",
    {
      status: "success",
      confirmations: 3,
      nonce: 1,
      blockNumber: 42,
      gasUsed: "21000",
      effectiveGasPriceWei: "1",
    },
    stateDir,
  );
  const reopened = readWalletTradeLedgerStore(stateDir);
  expect(reopened.entries).toHaveLength(1);
  expect(reopened.entries[0]).toMatchObject({
    status: "success",
    blockNumber: 42,
  });
  expect(loadWalletTradingProfile({ stateDir }).recentSwaps).toHaveLength(1);
});

it.each([
  "{broken",
  '{"version":2,"entries":[]}',
  '{"version":1,"entries":[{}]}',
])(
  "preserves invalid ledger bytes and refuses to treat them as an empty history: %s",
  (contents) => {
    const stateDir = stateDirectory();
    const file = resolveWalletTradingProfileFilePath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    expect(() => readWalletTradeLedgerStore(stateDir)).toThrow(
      expect.objectContaining({ code: "WALLET_LEDGER_READ_FAILED" }),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(contents);
  },
);
