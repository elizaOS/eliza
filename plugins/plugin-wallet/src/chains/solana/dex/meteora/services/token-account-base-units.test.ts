import { describe, expect, it } from "vitest";
import {
  parsedTokenAccountBaseUnits,
  sumParsedTokenAccountBaseUnits,
  withdrawalReceivedBaseUnits,
} from "./token-account-base-units.ts";

const parsedAccount = (amount: string) => ({
  account: {
    data: {
      parsed: {
        info: {
          mint: "mint",
          owner: "owner",
          tokenAmount: {
            amount,
            decimals: 6,
            uiAmount: Number(amount) / 1e6,
            uiAmountString: String(Number(amount) / 1e6),
          },
        },
      },
    },
  },
});

describe("parsedTokenAccountBaseUnits", () => {
  it("reads the integer amount and ignores a missing top-level uiAmount", () => {
    const info = parsedAccount("1500000").account.data.parsed.info;
    const asInfo = info as { uiAmount?: number; decimals?: number };
    expect(asInfo.uiAmount).toBeUndefined();
    expect(asInfo.uiAmount * 10 ** asInfo.decimals).toBeNaN();
    expect(parsedTokenAccountBaseUnits(info)).toBe(1_500_000n);
  });

  it("sums every token account for the mint", () => {
    expect(sumParsedTokenAccountBaseUnits([parsedAccount("1000"), parsedAccount("2000")])).toBe(
      3_000n
    );
  });

  it("returns zero when the account list is empty", () => {
    expect(sumParsedTokenAccountBaseUnits([])).toBe(0n);
  });

  it("leaves the received amount unknown when either balance read failed", () => {
    expect(withdrawalReceivedBaseUnits(null, 1_000_000n)).toBeNull();
    expect(withdrawalReceivedBaseUnits(2_500_000n, null)).toBeNull();
    expect(withdrawalReceivedBaseUnits(2_500_000n, 1_000_000n)).toBe("1500000");
  });
});
