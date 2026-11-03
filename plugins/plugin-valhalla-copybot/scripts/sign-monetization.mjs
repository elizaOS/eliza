import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import vm from "node:vm";

const sandbox = vm.createContext({ TextEncoder, atob });
vm.runInContext(readFileSync(new URL("../extension/trust.js", import.meta.url), "utf8"), sandbox);
const trust = sandbox.ValhallaTrust;

let raw = process.env.MONETIZATION_SIGNING_KEY || "";
if (!raw) {
  console.error("MONETIZATION_SIGNING_KEY is not set. The bundled signed config was left unchanged.");
  process.exit(0);
}
if (!raw.includes("BEGIN")) {
  try {
    raw = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    raw = "";
  }
}
let key;
try {
  key = createPrivateKey(raw);
  const pub = createPublicKey(key).export({ format: "jwk" });
  const pubB64 = Buffer.from(pub.x, "base64url").toString("base64");
  if (pubB64 !== trust.PUBLIC_KEY_B64) {
    console.error("The signing key does not match the committed public key. Nothing was signed.");
    process.exit(1);
  }
} catch {
  console.error("The signing key was not accepted. Nothing was signed.");
  process.exit(1);
}

const root = new URL("../", import.meta.url);
const doc = JSON.parse(readFileSync(new URL("./monetization.json", root), "utf8"));
delete doc.signature;
doc.offersSignature = sign(null, Buffer.from(trust.canonicalOffers(doc.offers)), key).toString("base64");
doc.signature = sign(null, Buffer.from(trust.canonicalMonetization(doc)), key).toString("base64");
const pretty = `${JSON.stringify(doc, null, 2)}\n`;
writeFileSync(new URL("./monetization.json", root), pretty);
writeFileSync(new URL("./extension/monetization.json", root), pretty);
const offersDoc = { offers: doc.offers, signature: doc.offersSignature };
const prettyOffers = `${JSON.stringify(offersDoc, null, 2)}\n`;
writeFileSync(new URL("./offers.json", root), prettyOffers);
writeFileSync(new URL("./extension/offers.json", root), prettyOffers);
console.log("Signed monetization.json and offers.json.");
