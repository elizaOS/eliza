# App Store Considerations

## Apple App Store Review

### 1. WebView Wrapper Rejection

Apple rejects "simple website wrappers" that don't provide functionality beyond what a web browser offers. Guideline 4.2 requires apps to have sufficient native features.

**Our mitigation:** The app uses genuine native Capacitor plugins:
- Push notifications (APNs)
- Haptic feedback
- Biometric re-authentication (future)
- Native status bar control
- Android back button handling
- App lifecycle management
- Splash screen

**Recommendation:** Document native API usage in App Review notes when submitting.

### 2. In-App Purchase Requirement

If Feed sells points/credits for real money via Stripe in the app, Apple **requires** using their IAP system (30% cut). App Store Guidelines 3.1.1.

**Options:**
1. **Remove Stripe from mobile app** — link out to web for purchases. Users buy on web, use in app.
2. **Implement IAP** via `@capacitor-community/in-app-purchases` plugin. Apple gets 30% (15% for small business program).
3. **Only offer free features** in the mobile app. No purchases at all.

**Decision needed:** This is a business decision with revenue implications.

### 3. Prediction Markets / Crypto Policy

App Store Guidelines 3.1.1 (Payments) and 3.1.5 (Cryptocurrencies). Prediction markets may be classified as gambling.

**Key questions:**
- Does Feed involve real-money prediction markets?
- Are users wagering actual cryptocurrency?
- Do prediction market outcomes constitute "gambling" under Apple's definition?

**If classified as gambling:** Apple requires:
- Compliance with local gambling regulations
- Possible geographic restrictions
- Specific licensing in supported jurisdictions
- Age verification

**Recommendation:** Legal review before submission. Research precedent — apps like Polymarket, Kalshi, and Robinhood (options) for how they handle App Store compliance.

---

## Google Play Store

### Real-Money Gambling

Google has specific requirements in its [Gambling and Games policy](https://support.google.com/googleplay/android-developer/answer/9877032). If prediction markets qualify:
- Must apply to Google's Real-Money Games program
- Geographic restrictions may apply
- Age gates required

### Crypto Compliance

Google enforces local laws for crypto apps. Generally less restrictive than Apple but still enforced. Apps must comply with financial services regulations in each supported country.

---

## OTA Updates

Apple App Store Guidelines section 3.3.2 allows OTA JavaScript updates for WebView-based apps:

> "Interpreted code may only be used in an Application if [...] it is downloaded and run by Apple's built-in WebKit framework."

Capacitor apps use WebKit, so OTA JS updates via Capgo or Capacitor Live Update are permitted. This allows:
- Bug fixes without App Store review
- UI changes without resubmission
- Feature additions that don't require new native plugins

**Cannot be updated OTA:** Native plugin additions, app icon changes, permission changes — these require a new App Store submission.

---

## Submission Checklist

| Item | Status |
|------|--------|
| App icon (1024×1024) | ✅ Source image ready, `generate:assets` script ready |
| Splash screen | ✅ Configured in `capacitor.config.ts` |
| Screenshots (iPhone 6.7", 6.5", iPad) | ❌ Needs device captures |
| Screenshots (Android phone, tablet) | ❌ Needs device captures |
| App description | ❌ Needs copywriting |
| Keywords | ❌ Needs research |
| Privacy policy URL | ❌ Needs legal |
| Apple Developer account ($99/year) | ❌ Needs purchase |
| Google Play Developer account ($25 one-time) | ❌ Needs purchase |
| iOS code signing (certificates + provisioning profiles) | ❌ Needs Apple Developer portal |
| Android release keystore | ❌ Needs generation |
| `apple-app-site-association` TEAM_ID | ❌ Needs Apple Developer account |
| `assetlinks.json` SHA256 fingerprint | ❌ Needs Android signing key |
| Regulatory research | ❌ Needs legal review |
| Stripe IAP decision | ❌ Needs business decision |

