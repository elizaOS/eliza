import process from "node:process";

import { parseArgs } from "./lib";
import { once, run, verify } from "./runner";

type Command = "help" | "verify" | "once" | "run";

function usage(): void {
  const text = [
    "Polymarket demo agent (TypeScript)",
    "",
    "Commands:",
    "  verify                 Validate config and wallet derivation (offline unless --network)",
    "  once --network         One market tick (dry-run unless --execute)",
    "  run --network          Loop market ticks",
    "",
    "Flags:",
    "  --network              Perform network calls (CLOB API)",
    "  --execute              Place orders (requires CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE)",
    "  --interval-ms <n>      Loop delay for `run` (default 30000)",
    "  --iterations <n>       Loop count for `run` (default 10)",
    "  --order-size <n>       Order size in shares (default 1)",
    "  --max-pages <n>        Pages to scan for an active market (default 1)",
    "  --chain <name>         EVM chain name for wallet provider (default polygon)",
    "  --rpc-url <url>        Custom RPC URL for the chain",
    "  --private-key <hex>    Private key (overrides env vars; accepts with/without 0x)",
    "  --clob-api-url <url>   CLOB API URL (overrides env var)",
    "",
    "Env:",
    "  EVM_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY)",
    "  CLOB_API_URL (optional; default https://clob.polymarket.com)",
    "  CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE (required for --execute)",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.log(text);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "help") {
    usage();
    return;
  }

  if (command === "verify") {
    await verify(options);
    return;
  }

  if (command === "once") {
    await once(options);
    return;
  }

  if (command === "run") {
    await run(options);
    return;
  }

  usage();
}

await main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});

