import process from "node:process";

import { z } from "zod";

export type Command = "help" | "verify" | "once" | "run";

export type CliOptions = {
  readonly execute: boolean;
  readonly network: boolean;
  readonly intervalMs: number;
  readonly iterations: number;
  readonly orderSize: number;
  readonly maxPages: number;
  readonly chain: string;
  readonly rpcUrl: string | null;
  readonly privateKey: string | null;
  readonly clobApiUrl: string | null;
};

export type EnvConfig = {
  readonly privateKey: string;
  readonly clobApiUrl: string;
  readonly creds:
    | {
        readonly key: string;
        readonly secret: string;
        readonly passphrase: string;
      }
    | null;
};

export const PrivateKeySchema = z
  .string()
  .transform((v) => (v.startsWith("0x") ? v : `0x${v}`))
  .pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/));

export function parseArgs(argv: readonly string[]): { command: Command; options: CliOptions } {
  const [rawCommand, ...rest] = argv;
  const command = (rawCommand ?? "help") as Command;

  const defaults: CliOptions = {
    execute: false,
    network: false,
    intervalMs: 30_000,
    iterations: 10,
    orderSize: 1,
    maxPages: 1,
    chain: "polygon",
    rpcUrl: null,
    privateKey: null,
    clobApiUrl: null,
  };

  const mutable: {
    execute: boolean;
    network: boolean;
    intervalMs: number;
    iterations: number;
    orderSize: number;
    maxPages: number;
    chain: string;
    rpcUrl: string | null;
    privateKey: string | null;
    clobApiUrl: string | null;
  } = { ...defaults };

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--execute") {
      mutable.execute = true;
      continue;
    }
    if (a === "--network") {
      mutable.network = true;
      continue;
    }
    if (a === "--interval-ms") {
      const v = rest[i + 1];
      if (typeof v === "string") {
        const parsed = Number(v);
        if (Number.isFinite(parsed) && parsed > 0) mutable.intervalMs = parsed;
        i += 1;
      }
      continue;
    }
    if (a === "--iterations") {
      const v = rest[i + 1];
      if (typeof v === "string") {
        const parsed = Number(v);
        if (Number.isFinite(parsed) && parsed > 0) mutable.iterations = Math.floor(parsed);
        i += 1;
      }
      continue;
    }
    if (a === "--order-size") {
      const v = rest[i + 1];
      if (typeof v === "string") {
        const parsed = Number(v);
        if (Number.isFinite(parsed) && parsed > 0) mutable.orderSize = parsed;
        i += 1;
      }
      continue;
    }
    if (a === "--max-pages") {
      const v = rest[i + 1];
      if (typeof v === "string") {
        const parsed = Number(v);
        if (Number.isFinite(parsed) && parsed > 0) mutable.maxPages = Math.floor(parsed);
        i += 1;
      }
      continue;
    }
    if (a === "--chain") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.trim().length > 0) {
        mutable.chain = v.trim();
        i += 1;
      }
      continue;
    }
    if (a === "--rpc-url") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.trim().length > 0) {
        mutable.rpcUrl = v.trim();
        i += 1;
      }
      continue;
    }
    if (a === "--private-key") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.trim().length > 0) {
        mutable.privateKey = v.trim();
        i += 1;
      }
      continue;
    }
    if (a === "--clob-api-url") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.trim().length > 0) {
        mutable.clobApiUrl = v.trim();
        i += 1;
      }
      continue;
    }
  }

  if (!["help", "verify", "once", "run"].includes(command)) {
    return { command: "help", options: defaults };
  }
  return { command, options: mutable };
}

export function loadEnvConfig(options: CliOptions): EnvConfig {
  const privateKeyRaw =
    options.privateKey ??
    process.env.EVM_PRIVATE_KEY ??
    process.env.POLYMARKET_PRIVATE_KEY ??
    process.env.WALLET_PRIVATE_KEY ??
    process.env.PRIVATE_KEY;

  if (typeof privateKeyRaw !== "string") {
    throw new Error(
      "Missing private key. Set EVM_PRIVATE_KEY (recommended) or POLYMARKET_PRIVATE_KEY."
    );
  }

  const privateKey = PrivateKeySchema.parse(privateKeyRaw);

  const clobApiUrlRaw =
    options.clobApiUrl ?? process.env.CLOB_API_URL ?? "https://clob.polymarket.com";
  const clobApiUrl = z.string().url().parse(clobApiUrlRaw);

  const key = process.env.CLOB_API_KEY;
  const secret = process.env.CLOB_API_SECRET ?? process.env.CLOB_SECRET;
  const passphrase = process.env.CLOB_API_PASSPHRASE ?? process.env.CLOB_PASS_PHRASE;

  const creds =
    typeof key === "string" && typeof secret === "string" && typeof passphrase === "string"
      ? {
          key: z.string().min(1).parse(key),
          secret: z.string().min(1).parse(secret),
          passphrase: z.string().min(1).parse(passphrase),
        }
      : null;

  if (options.execute && creds === null) {
    throw new Error(
      "Missing CLOB API credentials for --execute. Set CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE."
    );
  }

  return { privateKey, clobApiUrl, creds };
}

