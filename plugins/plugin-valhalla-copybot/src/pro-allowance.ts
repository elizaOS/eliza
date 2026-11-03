import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readSignedAllowance } from "./monetization-trust.ts";

const PUBLIC_KEY_B64 = "3Y25V3M5MkK354P3Ghw2BnA8locVlep3q86GTOD/EKU=";
const FILE = "pro-trades.json";

export interface ProTradeState {
  identity: string;
  remaining: number;
  allowance: number;
  used: string[];
  signature?: string;
}

export function allowanceMessage(allowance: number, trialDays: number): string {
  return `proTradeAllowance=${allowance}\ntrialDays=${trialDays}`;
}

export function counterMessage(state: Pick<ProTradeState, "identity" | "remaining" | "allowance">): string {
  return `identity=${state.identity}\nremaining=${state.remaining}\nallowance=${state.allowance}`;
}

function publicKey() {
  const raw = Buffer.from(PUBLIC_KEY_B64, "base64");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}

export function verifySigned(message: string, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    return verify(null, Buffer.from(message), publicKey(), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

async function readState(dataDir: string, allowance: number): Promise<ProTradeState> {
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir, FILE), "utf8")) as ProTradeState;
    const remaining = Number(raw.remaining);
    const safe = Number.isFinite(remaining) ? Math.max(0, Math.min(allowance, remaining)) : allowance;
    const signedOk = verifySigned(counterMessage({ ...raw, remaining: safe, allowance }), raw.signature);
    return {
      identity: raw.identity || randomUUID(),
      remaining: signedOk ? remaining : safe,
      allowance,
      used: Array.isArray(raw.used) ? raw.used.map(String) : [],
      signature: signedOk ? raw.signature : undefined,
    };
  } catch {
    return { identity: randomUUID(), remaining: allowance, allowance, used: [] };
  }
}

async function writeState(dataDir: string, state: ProTradeState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, FILE), JSON.stringify(state));
}

export async function proTradeView(dataDir: string, allowance = readSignedAllowance()): Promise<ProTradeState> {
  const state = await readState(dataDir, allowance);
  await writeState(dataDir, state);
  return state;
}

/** One count per live trade id. A repeated id does not decrement again. */
export async function recordLiveTrade(
  dataDir: string,
  tradeId: string,
  allowance = readSignedAllowance(),
  brainUrl = process.env.VALHALLA_BRAIN_URL
): Promise<ProTradeState> {
  const state = await readState(dataDir, allowance);
  if (!state.used.includes(tradeId) && state.remaining > 0) {
    state.used.push(tradeId);
    state.remaining -= 1;
    state.signature = undefined;
  }
  if (brainUrl) {
    try {
      const response = await fetch(`${brainUrl.replace(/\/$/, "")}/v1/pro-trades/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: state.identity, tradeId }),
      });
      if (response.ok) {
        const body = (await response.json()) as ProTradeState;
        if (
          body.identity === state.identity &&
          verifySigned(counterMessage(body), body.signature) &&
          body.allowance === allowance
        ) {
          state.remaining = body.remaining;
          state.signature = body.signature;
        }
      }
    } catch {
      // Keep the local count. The next live Brain reply can replace it.
    }
  }
  await writeState(dataDir, state);
  return state;
}

export function liveTradeBlocked(state: ProTradeState): boolean {
  return state.remaining <= 0;
}
