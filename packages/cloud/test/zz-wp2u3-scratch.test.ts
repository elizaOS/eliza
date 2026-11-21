import { describe, expect, it } from "vitest";
import * as oracle from "../gen/cloud__nativeClients__deviceKeys.ts";
import { driver, options } from "./drivers/cloud__nativeClients__deviceKeys.ts";

const view = { kind: "RequestSession", found: true, live: true, expiresAt: 900000, issuedAt: 1, revokedBefore: 0, accountStatus: "RequestAccountActive", authAt: 1, stepUpAt: 1, mfaAt: 1 } as const;
const ok = { client: { tag: "ClientAdmitted" }, method: "S256", hasState: true } as const;
const day = 86_400_000;
const traces: Record<string, oracle.Event[]> = {
  connected: [
    { type: "connect", view, codeRequest: ok, credentialTtl: day, deviceEpoch: 0 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "VerifierDiffers", credentialId: "k1", deviceEpoch: 0 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 0 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k2", deviceEpoch: 0 },
    { type: "ack", client: { tag: "ClientAdmitted" }, proofMatches: false, deviceEpoch: 0 },
    { type: "ack", client: { tag: "ClientAdmitted" }, proofMatches: true, deviceEpoch: 0 },
    { type: "selfRevoke", deviceEpoch: 0 },
    { type: "selfRevoke", deviceEpoch: 0 },
  ],
  lapse: [
    { type: "connect", view, codeRequest: ok, credentialTtl: day, deviceEpoch: 0 },
    { type: "lapse" },
    { type: "elapse", elapsed: 300000 },
    { type: "lapse" },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 0 },
  ],
  expire: [
    { type: "connect", view, codeRequest: ok, credentialTtl: day, deviceEpoch: 0 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 0 },
    { type: "ack", client: { tag: "ClientAdmitted" }, proofMatches: true, deviceEpoch: 0 },
    { type: "elapse", elapsed: 2592000000 },
    { type: "expire" },
  ],
  revoked: [
    { type: "connect", view, codeRequest: { ...ok, method: "PlainMethod" }, credentialTtl: day, deviceEpoch: 0 },
    { type: "connect", view, codeRequest: ok, credentialTtl: day, deviceEpoch: 0 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 1 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 0 },
  ],
  connectAtEpoch: [
    { type: "connect", view, codeRequest: ok, credentialTtl: day, deviceEpoch: 1 },
    { type: "token", client: { tag: "ClientAdmitted" }, binding: "BindingMatches", credentialId: "k1", deviceEpoch: 1 },
  ],
  native: [
    { type: "signInNatively", codeRequest: ok, nativeGoogle: "GoogleNotOffered", verdict: "NativeAccepted", yielded: "DeviceKeyYield", serverCode: "NoServerCode", credentialTtl: day, credentialId: "k1", deviceEpoch: 0 },
    { type: "signInNatively", codeRequest: ok, nativeGoogle: "NativeGoogleOpen", verdict: "NativeProofWrong", yielded: "DeviceKeyYield", serverCode: "NoServerCode", credentialTtl: day, credentialId: "k1", deviceEpoch: 0 },
    { type: "signInNatively", codeRequest: ok, nativeGoogle: "NativeGoogleOpen", verdict: "NativeAccepted", yielded: "SecondFactorYield", serverCode: "NoServerCode", credentialTtl: day, credentialId: "k1", deviceEpoch: 0 },
    { type: "signInNatively", codeRequest: ok, nativeGoogle: "NativeGoogleOpen", verdict: "NativeAccepted", yielded: "DeviceKeyYield", serverCode: "WithServerCode", credentialTtl: day, credentialId: "k1", deviceEpoch: 0 },
    { type: "ack", client: { tag: "ClientAdmitted" }, proofMatches: true, deviceEpoch: 0 },
  ],
};

describe("wp2u3 scratch", () => {
  for (const [name, trace] of Object.entries(traces)) {
    it(name, async () => {
      const lines: string[] = [];
      try {
        await driver.reset();
        let state = oracle.initial;
        for (const [i, event] of trace.entries()) {
          const allowed = oracle.enabled(state, event);
          let did: string;
          try { did = await driver.dispatch("device", event); } catch (error) { lines.push(`${i} ${event.type}: THREW ${(error as Error).message.slice(0, 600)}`); break; }
          state = oracle.step(state, event).state;
          const seen = await driver.observe("device").catch((error: Error) => `OBSERVE THREW ${error.message.slice(0, 400)}`);
          const same = JSON.stringify(seen) === JSON.stringify(options.view!(state));
          lines.push(`${i} ${event.type}: spec ${allowed ? "accepts" : "refuses"}, app ${did}${same ? "" : `; seen ${JSON.stringify(seen)} spec ${JSON.stringify(options.view!(state))}`}`);
        }
      } finally {
        console.log(`${name}\n${lines.join("\n")}`);
      }
      expect(true).toBe(true);
    }, 120_000);
  }
});
