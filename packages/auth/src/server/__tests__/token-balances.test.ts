import { afterEach, expect, test } from "bun:test";
import { encodeFunctionResult, toFunctionSelector } from "viem";
import { ERC20_ABI, getTokenBalances } from "../wallet/tokens";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
});

function rpc(failure?: "symbol" | "balanceOf") {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        id: number;
        params: [{ data: string }];
      };
      const name = ERC20_ABI.find((item) =>
        body.params[0].data.startsWith(toFunctionSelector(item)),
      )?.name;
      if (!name) return new Response("Unknown method", { status: 400 });
      if (name === failure)
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unavailable" },
        });
      const result =
        name === "symbol"
          ? encodeFunctionResult({
              abi: ERC20_ABI,
              functionName: "symbol",
              result: "USDC",
            })
          : name === "decimals"
            ? encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "decimals",
                result: 6,
              })
            : encodeFunctionResult({
                abi: ERC20_ABI,
                functionName: "balanceOf",
                result: 1234567n,
              });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return server.url.toString();
}
const address = "0x0000000000000000000000000000000000000001";

test("BSC testnet uses contract decimals for custom token balances", async () => {
  expect(await getTokenBalances(address, 97, [address], rpc())).toEqual([
    {
      token: address,
      symbol: "USDC",
      balance: "1234567",
      formatted: "1.234567",
      decimals: 6,
    },
  ]);
});

test("metadata failure cannot fabricate 18 decimals", async () => {
  await expect(
    getTokenBalances(address, 97, [address], rpc("symbol")),
  ).rejects.toMatchObject({ code: "LOGIN_TOKEN_METADATA_FAILED" });
});

test("balance failure cannot become a successful empty list", async () => {
  await expect(
    getTokenBalances(address, 97, [address], rpc("balanceOf")),
  ).rejects.toMatchObject({ code: "LOGIN_TOKEN_BALANCE_FAILED" });
});
