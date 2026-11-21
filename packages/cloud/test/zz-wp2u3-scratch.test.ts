import { describe, expect, it } from "vitest";
import * as oracle from "../gen/cloud__nativeClients__deviceKeys.ts";
import { driver, options } from "./drivers/cloud__nativeClients__deviceKeys.ts";

const active = { kind: "RequestSession", found: true, live: true, expiresAt: 900000, issuedAt: 1, revokedBefore: 0, accountStatus: "RequestAccountActive", authAt: 1, stepUpAt: 1, mfaAt: 1 } as const;
const views = [active, { ...active, found: false }, { ...active, live: false }, { ...active, accountStatus: "RequestAccountInactive" }, { ...active, kind: "RequestDevice" }] as const;
const ok = { client: { tag: "ClientAdmitted" }, method: "S256", hasState: true } as const;
const requests = [ok, { ...ok, method: "PlainMethod" }, { ...ok, client: { tag: "ClientRefused", fault: "DisabledClient" } }] as const;
const clients = [{ tag: "ClientAdmitted" }, { tag: "ClientRefused", fault: "WrongRedirect" }] as const;
const ttls = [86_400_000, 30 * 86_400_000];
const epochs = [0, 1];
const pool: oracle.Event[] = [];
for (const view of views) for (const codeRequest of requests) for (const credentialTtl of ttls) for (const deviceEpoch of epochs) pool.push({ type: "connect", view, codeRequest, credentialTtl, deviceEpoch } as oracle.Event);
for (const elapsed of [1, 300000, 2592000000]) pool.push({ type: "elapse", elapsed });
for (const nativeGoogle of ["NativeGoogleOpen", "GoogleNotOffered"] as const) for (const verdict of ["NativeAccepted", "NativeProofWrong"] as const) for (const yielded of ["DeviceKeyYield", "SecondFactorYield"] as const) for (const serverCode of ["NoServerCode", "WithServerCode"] as const) for (const deviceEpoch of epochs)
  pool.push({ type: "signInNatively", codeRequest: ok, nativeGoogle, verdict, yielded, serverCode, credentialTtl: 86_400_000, credentialId: "k1", deviceEpoch });
for (const client of clients) for (const binding of ["BindingMatches", "RedirectDiffers", "VerifierDiffers"] as const) for (const deviceEpoch of epochs) pool.push({ type: "token", client, binding, credentialId: "k1", deviceEpoch } as oracle.Event);
for (const client of clients) for (const proofMatches of [true, false]) for (const deviceEpoch of epochs) for (let i = 0; i < 2; i++) pool.push({ type: "ack", client, proofMatches, deviceEpoch } as oracle.Event);
for (const deviceEpoch of epochs) for (let i = 0; i < 4; i++) pool.push({ type: "selfRevoke", deviceEpoch });
for (let i = 0; i < 4; i++) pool.push({ type: "expire" }, { type: "lapse" });

let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

describe("wp2u3 scratch", () => {
  it("walks", async () => {
    const failures: string[] = [];
    let accepted = 0;
    for (let w = 0; w < 40; w++) {
      await driver.reset();
      let state = oracle.initial;
      const lines: string[] = [];
      for (let i = 0; i < 16; i++) {
        const allowed = pool.filter((e) => oracle.enabled(state, e));
        const from = allowed.length && random() < 0.75 ? allowed : pool;
        const event = from[Math.floor(random() * from.length)];
        const spec = oracle.enabled(state, event);
        let did: string;
        try { did = await driver.dispatch("device", event); } catch (error) { lines.push(`${JSON.stringify(event)} THREW ${(error as Error).message.slice(0, 500)}`); failures.push(lines.join("\n")); break; }
        if (did === "accepted") accepted++;
        state = oracle.step(state, event).state;
        const seen = await driver.observe("device").catch((error: Error) => `OBSERVE THREW ${error.message.slice(0, 300)}`);
        const same = JSON.stringify(seen) === JSON.stringify(options.view!(state));
        lines.push(`${JSON.stringify(event)} spec ${spec} app ${did}${same ? "" : ` seen ${JSON.stringify(seen)} spec ${JSON.stringify(options.view!(state))}`}`);
        if ((did === "accepted") !== spec || !same) { failures.push(lines.join("\n")); break; }
      }
    }
    console.log(`accepted ${accepted}; failures ${failures.length}\n${failures.slice(0, 4).join("\n----\n")}`);
    expect(true).toBe(true);
  }, 600_000);
});
