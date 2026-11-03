# Monetization signing key

Valhalla keeps publisher ids, AdMob unit ids, affiliate URLs, and Lemon Squeezy checkout URLs in `plugins/plugin-valhalla-copybot/monetization.json`. That file is signed with an Ed25519 key. Apps embed only the public key. A config whose signature does not verify is ignored. The app then uses the signed copy that was bundled at build time. It never uses an unsigned value.

The private key is not in this repo. Do not commit it. Do not paste it into chat, an issue, or a log.

## One-time setup

1. On your own computer, create a key. This command writes a private key file and prints only the public key:

```bash
openssl genpkey -algorithm ED25519 -out monetization-private.pem
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { createPrivateKey, createPublicKey } from "node:crypto"; const key = createPrivateKey(readFileSync("monetization-private.pem")); const pub = createPublicKey(key).export({ format: "jwk" }); console.log(Buffer.from(pub.x, "base64url").toString("base64"));'
```

2. Keep `monetization-private.pem` offline. Put the same PEM text into a GitHub Actions secret named `MONETIZATION_SIGNING_KEY` on an environment named `release`. In the environment protection rule, require your review before a job can use the secret.

3. Replace the public key in `extension/trust.js` and `src/monetization-trust.ts` with the public key from step 1. Then sign and commit:

```bash
MONETIZATION_SIGNING_KEY="$(cat monetization-private.pem)" node plugins/plugin-valhalla-copybot/scripts/sign-monetization.mjs
```

4. Open a pull request. GitHub CODEOWNERS asks for your review on the monetization files. Approve it, then run the "Valhalla monetization" workflow by hand. That job uses the `release` environment, so it waits for your approval. Until the secret exists, the workflow signs nothing and release builds keep the signed file already in the repo.

## Branch protection

On `develop`, turn on these rules:

- Require a pull request before merging.
- Require review from code owners.
- Do not allow force pushes.
- Require the "Valhalla monetization" check to pass.

## What a bad edit does

If a build or a remote `offers.json` has a bad signature, ads turn off. Affiliate links turn off. The Pro-trade allowance falls back to the last signed bundle, or to zero when that bundle also fails. The app reports `monetization-tamper`. It does not swap in a different publisher id.

`ads.txt` and `app-ads.txt` list only `pub-6504655762357230`.

The crypto receive address is only in `monetization.json`. Checkout code reads it after the signature verifies. There is no private key for that address. Receiving does not need one. If the signature fails, crypto checkout turns off.
