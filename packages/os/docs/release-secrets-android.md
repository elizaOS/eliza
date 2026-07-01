# Maintainer: Android release credentials

Playbook for the secrets `android-release.yml` consumes to build a **signed**
AAB + APK and upload to the Google Play Store. Same shape as the apt-repo
playbook ([admin-apt-repo-setup.md](./admin-apt-repo-setup.md)): generate →
set the repo secret → sanity-run → rotate/revoke.

There are two independent credential groups:

1. **Upload keystore** — signs the artifacts. Without it the signing preflight
   fails loudly and the build aborts.
2. **Play Store service account** — uploads the AAB to a Play track. Optional:
   when absent, the workflow still builds + attaches signed artifacts to the
   GitHub Release and only skips the `publish-play-store` job (with a warning).

## Secrets this workflow reads

| Secret | Required? | Used as |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Yes — sign-blocking | base64 of the upload keystore `.jks`, decoded to `/tmp/elizaos-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Yes — sign-blocking | `ELIZAOS_KEYSTORE_PASSWORD` |
| `ANDROID_KEY_ALIAS` | Yes — sign-blocking | `ELIZAOS_KEY_ALIAS` |
| `ANDROID_KEY_PASSWORD` | Yes — sign-blocking | `ELIZAOS_KEY_PASSWORD` |
| `PLAY_STORE_SERVICE_ACCOUNT_JSON` | Optional (gates Play upload) | base64 of the service-account JSON, decoded for `fastlane supply` |

The signing preflight (`bun run preflight:android:sideload`) checks all four
keystore inputs and exits with `::error::Missing Android release signing
inputs: …` if any is empty, so a half-configured repo fails inside the job
rather than producing an unsigned build.

## Step 1 — Generate the upload keystore

Generate a dedicated upload key on a trusted machine (not the runner). Keep it
out of git. Play App Signing re-signs with Google's app key, so this is the
*upload* key — protect it but it is independently rotatable through Play
Console if leaked.

```sh
keytool -genkeypair -v \
  -keystore elizaos-upload.jks \
  -alias elizaos-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype JKS
```

`keytool` prompts for the **keystore password** and the **key password** (you
may set them the same). Record:

- keystore password → `ANDROID_KEYSTORE_PASSWORD`
- key alias (`elizaos-upload` above) → `ANDROID_KEY_ALIAS`
- key password → `ANDROID_KEY_PASSWORD`

Base64-encode the keystore for storage as a secret string:

```sh
base64 -w0 elizaos-upload.jks > elizaos-upload.jks.b64   # Linux
# macOS: base64 -i elizaos-upload.jks -o elizaos-upload.jks.b64
```

`ANDROID_KEYSTORE_BASE64` is the contents of `elizaos-upload.jks.b64`.

## Step 2 — Create the Play Store service account (optional)

Only needed to upload to the Play Store; skip if you only want signed artifacts
on the GitHub Release.

1. In the Google Play Console: **Setup → API access** → link or create a Google
   Cloud project.
2. In Google Cloud Console: **IAM & Admin → Service Accounts → Create**. Name it
   e.g. `elizaos-play-ci`. No project roles needed here.
3. On the service account → **Keys → Add key → JSON**. The JSON downloads once.
4. Back in Play Console → **Users and permissions → Invite new users**, add the
   service account email, and grant release permissions for the app (at minimum
   "Release to testing tracks" / "Release to production" as appropriate).

Base64 the JSON the same way:

```sh
base64 -w0 play-ci.json > play-ci.json.b64
```

`PLAY_STORE_SERVICE_ACCOUNT_JSON` is the contents of `play-ci.json.b64`.

The workflow uploads with `fastlane supply … --package_name "app.eliza"`, so the
service account must have permission on the `app.eliza` Play listing.

## Step 3 — Set the GitHub secrets

At `https://github.com/elizaOS/eliza/settings/secrets/actions`, add each of the
five secrets from the table above. Then shred the local copies:

```sh
shred -u elizaos-upload.jks elizaos-upload.jks.b64 play-ci.json play-ci.json.b64
```

## Step 4 — Sanity-trigger the workflow

```sh
gh workflow run android-release.yml \
  --repo elizaOS/eliza \
  --field version_name=2.0.0-beta.0 \
  --field track=internal
gh run watch --repo elizaOS/eliza
```

A green run:

1. Builds and **signs** the AAB + APK (signing preflight passes).
2. Attaches `Eliza-<version>.aab/.apk` + `…SHA256SUMS.txt` + the sideload APK to
   the `v<version>` GitHub Release (the release tag must already exist).
3. If `PLAY_STORE_SERVICE_ACCOUNT_JSON` is set, runs `publish-play-store` and
   uploads to the chosen track.

Symptoms of misconfiguration:

- `::error::Missing Android release signing inputs: …` → a keystore secret is
  empty or the base64 didn't decode to a non-empty `.jks`.
- `play_store_ready=false` + a warning, Play job skipped → service account JSON
  not set (artifacts still attach; this is fine if you only wanted the APK/AAB).

## Rotating the upload key

If you must rotate the upload key (e.g. before expiry or after suspected
exposure), use **Play Console → App integrity → request upload key reset**;
Google issues a new upload certificate. Then regenerate the keystore (Step 1),
update the four keystore secrets, and sanity-run.

For the service account, add a new JSON key in Google Cloud, update
`PLAY_STORE_SERVICE_ACCOUNT_JSON`, verify a run, then delete the old key.

## Revoking a compromised credential

- **Service account leaked:** delete the key in Google Cloud (Service Accounts →
  Keys) — it stops working immediately. Issue a fresh key and update the secret.
- **Upload key leaked:** request an upload key reset in Play Console (above).
  Play App Signing means the *app* signing key is held by Google, so a leaked
  upload key cannot ship a malicious update once reset.

## Related

- [release-secrets-checklist.md](./release-secrets-checklist.md) — every secret,
  every channel.
- `android-release.yml` — the workflow this configures.
