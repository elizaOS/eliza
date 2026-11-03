import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify } from "node:crypto";
import vm from "node:vm";

const plugin = new URL("../", import.meta.url);
const sandbox = vm.createContext({ TextEncoder, atob });
vm.runInContext(readFileSync(new URL("./extension/trust.js", plugin), "utf8"), sandbox);
const trust = sandbox.ValhallaTrust;
const errors = [];

function fail(message) {
  errors.push(message);
}

function verifySig(message, signature) {
  const raw = Buffer.from(trust.PUBLIC_KEY_B64, "base64");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
}

const money = JSON.parse(readFileSync(new URL("./monetization.json", plugin), "utf8"));
const offers = JSON.parse(readFileSync(new URL("./offers.json", plugin), "utf8"));
if (money.adsenseClient !== trust.ADSENSE_CLIENT) fail("adsense client is not the Valhalla publisher");
if (!verifySig(trust.canonicalMonetization(money), money.signature)) fail("monetization.json signature does not verify");
if (!verifySig(trust.canonicalOffers(offers.offers), offers.signature)) fail("offers.json signature does not verify");
if (trust.canonicalOffers(money.offers) !== trust.canonicalOffers(offers.offers)) {
  fail("offers.json does not match monetization.json");
}
const deskTrust = readFileSync(new URL("./src/monetization-trust.ts", plugin), "utf8");
if (!deskTrust.includes(trust.PUBLIC_KEY_B64)) fail("the desk public key does not match trust.js");
const checkout = readFileSync(new URL("./src/checkout.ts", plugin), "utf8");
if (!checkout.includes(money.checkoutUrl)) fail("checkout.ts does not use the signed checkout URL");

const own = "6504655762357230";
const idRe = /ca-(?:app-)?pub-(\d{16})/g;
const roots = [
  "extension",
  "android/app",
  "mobile",
  "public",
  "src",
  "monetization.json",
  "offers.json",
  "ads.txt",
  "app-ads.txt",
];

function walk(rel, out) {
  const full = path.join(fileURLToPath(plugin), rel);
  let st;
  try {
    st = statSync(full);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(full)) {
      if (name === "node_modules" || name === "vendor" || name === "build") continue;
      walk(path.join(rel, name), out);
    }
    return;
  }
  if (/\.(png|jpg|ico|webp|jar)$/.test(rel)) return;
  out.push(rel);
}

const files = [];
for (const rel of roots) walk(rel, files);
let sawOwn = false;
for (const rel of files) {
  const text = readFileSync(path.join(fileURLToPath(plugin), rel), "utf8");
  for (const match of text.matchAll(idRe)) {
    if (match[1] === own) sawOwn = true;
    else fail(`${rel} contains a different publisher id`);
  }
}
if (!sawOwn) fail("the Valhalla publisher id is missing from the app tree");
const receive = String(money.cryptoReceiveAddress || "");
if (receive.length < 32) fail("crypto receive address is missing from the signed config");
for (const rel of files) {
  if (rel.endsWith("monetization.json")) continue;
  const text = readFileSync(path.join(fileURLToPath(plugin), rel), "utf8");
  if (text.includes(receive)) fail(`${rel} hardcodes the crypto receive address`);
}

for (const name of ["ads.txt", "app-ads.txt"]) {
  const text = readFileSync(new URL(`./${name}`, plugin), "utf8");
  if (!text.includes(`pub-${own}`)) fail(`${name} is missing the Valhalla publisher`);
  if (/pub-\d{16}/.test(text.replaceAll(`pub-${own}`, ""))) fail(`${name} lists another publisher`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Monetization id check passed");
