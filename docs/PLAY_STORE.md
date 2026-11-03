# Put Valhalla on Google Play

The phone app is a monitor. It does not hold keys and it does not exchange or take custody of funds. Trading, if you arm it, stays on the computer. Read this list in order. The steps marked "you" cannot be done from the repository.

## What you must do yourself

1. Pay for a Google Play Console organization account. The developer name on the store is TokenJunction LLC. Google charges a one-time fee. The Apple seller name is also TokenJunction LLC. The public site is https://valhalla-app.xyz. Support is hello@valhalla-app.xyz. Fill `{BUSINESS_ADDRESS}` only in a private copy of `docs/play/listing.md`. Do not commit a street address or an EIN.
2. Create an AdMob account, add a payment profile, register the app, and create the ad units. Until you do that, the build uses Google's test IDs and does not pay.
3. Create an upload keystore on your computer. Do not commit it. In the GitHub repository secrets, set `VALHALLA_KEYSTORE_BASE64` (base64 of the .jks file), `VALHALLA_KEYSTORE_PASSWORD`, `VALHALLA_KEY_ALIAS`, and `VALHALLA_KEY_PASSWORD`.
4. Turn on Play App Signing when you upload the first bundle. Google holds the app signing key. You keep only the upload key. If you lose the upload key, ask Google to reset it. Do not put either key in git.
5. Invite at least 12 testers and run a closed test for 14 days in a row before you can apply for production. This rule is for new personal developer accounts. The testers must opt in and stay opted in. You cannot skip this with a second personal account.
6. Complete the Data safety form from `docs/DATA_SAFETY.md`, the ads declaration, and the content rating questionnaire. Rate the app 18+.
7. Set the Play privacy URL to https://valhalla-app.xyz/privacy-policy.md. The page is the site on the `docs/site` branch. Enable Pages from GitHub Actions, then set the custom domain to valhalla-app.xyz.
8. Host `android/app-ads.txt.example` as `https://YOUR-DOMAIN/app-ads.txt` after you replace the publisher id. AdMob checks this file.
9. For the internal track upload, create a Play service account with release permission and set `PLAY_SERVICE_ACCOUNT_JSON` to that file's path on the machine that runs Fastlane. Do not commit the JSON file.

## Build facts already in the project

- `targetSdk` and `compileSdk` are 36. From 31 August 2026, Play requires API 36 for new apps and updates. An extension to 1 November 2026 was possible from the Play Console. Today is after that extension date, so ship API 36.
- `minSdk` is 26.
- `versionCode` is `VERSION_CODE` in the environment. The Play workflow sets it from the GitHub run number so each release bundle is higher than the last.
- Release builds use R8. Native code is limited to `arm64-v8a` and `x86_64`. 32-bit libraries are excluded.
- Permissions: internet, notifications, camera for the desk QR only, the advertising-id permission because of AdMob, and the foreground-service permissions the watch notice needs. There is no send, withdraw, or wallet-key permission.
- The camera feature is optional, so a phone without a camera can still install the app.

## Policy notes for a crypto companion

Play and AdMob restrict apps that exchange, trade, or hold crypto for other people. This app does not do those things. Say that clearly in the store listing and in the declaration forms:

- The phone never holds a key.
- There is no send, withdraw, transfer, or custody path.
- Any trade is armed on the computer, not on the phone.
- Some countries still require a license for software that helps someone trade. If you are unsure, ask a lawyer before you list the app in that country. The repository cannot make that decision.

A personal Play account can publish the app. Use an organization account if the store name must be a company. The 12-tester and 14-day closed test applies to new personal accounts.

## Closed test, then production

1. Build the signed Android App Bundle with the Play workflow, or run `./gradlew bundleRelease` in `plugins/plugin-valhalla-copybot/android` after you point `VALHALLA_KEYSTORE` at the upload key.
2. In Play Console, create the app. Upload the `.aab` to the internal testing track first.
3. Open a closed test. Add at least 12 testers who will stay opted in for 14 days. Send them the opt-in link.
4. Fill in the listing from `docs/play/listing.md`. Upload the icon, the feature graphic, and the phone screenshots in `docs/play/listing/`.
5. Finish Data safety, ads, content rating, and the privacy URL.
6. After 14 days with 12 testers still opted in, apply for production access. Google reviews the request. Do not promise a date.

## Fastlane

From `plugins/plugin-valhalla-copybot/android`, after the bundle exists:

```bash
export VALHALLA_AAB=app/build/outputs/bundle/release/app-release.aab
export PLAY_SERVICE_ACCOUNT_JSON=/path/to/play-service-account.json
bundle exec fastlane internal
```

That uploads to the internal track only. It does not publish to production.

## Pre-launch checklist

- [ ] `bun plugins/plugin-valhalla-copybot/scripts/play-prelaunch.ts` prints "Play prelaunch checks passed".
- [ ] The app opens to the pairing screen and does not crash with the desk off.
- [ ] Delete phone data clears the address and the error log.
- [ ] Scan desk QR accepts only an http or https address.
- [ ] Recover agent is visible with no ad on top of it.
- [ ] A break ad does not appear while the offline or stalled alert is showing.
- [ ] The signed bundle installs, and Play App Signing is on.
- [ ] Privacy URL, Data safety, ads declaration, and 18+ content rating are submitted.
- [ ] 12 testers have been opted in for 14 days before you request production.
- [ ] No keystore, API secret, or wallet key is in the git history of this branch.

## Crash-free startup

The prelaunch script checks the manifest and the build file. It does not boot a phone. After you upload the bundle, open Play Console pre-launch report and confirm the crawl does not crash on startup. On a phone, force-stop the app, open it with no desk running, and confirm the pairing screen appears.
