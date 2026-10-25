/** Narrow Android platform Credential Manager routing; no GMS spoof or provider readiness claim. */
const prefix =
  "components/webauthn/android/java/src/org/chromium/components/webauthn/";
export function applyStandaloneCredMan(edit, replaceOnce) {
  edit(`${prefix}cred_man/CredManSupportProvider.java`, (source) => {
    source = replaceOnce(
      source,
      "    @CalledByNative\n    public static @CredManSupport int getCredManSupport() {",
      `    /** Dispatch capability only. Public Android APIs cannot attest another provider's readiness. */
    public static boolean canDispatchStandaloneCredMan() {
        int mode = WebauthnModeProvider.getInstance().getGlobalWebauthnMode();
        return (mode == WebauthnMode.CHROME || mode == WebauthnMode.CHROME_3PP_ENABLED)
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
                && GmsCoreUtils.getGmsCoreVersion() < 0
                && ContextUtils.getApplicationContext().getSystemService(Context.CREDENTIAL_SERVICE)
                        != null;
    }

    @CalledByNative
    public static @CredManSupport int getCredManSupport() {
        if (canDispatchStandaloneCredMan()) {
            // No cached provider claim: the platform still owns selection, UI and verification.
            return CredManSupport.FULL_UNLESS_INAPPLICABLE;
        }`,
      "standalone platform dispatch support",
    );
    return source;
  });
  edit(`${prefix}AuthenticatorImpl.java`, (source) => {
    source = replaceOnce(
      source,
      "import org.chromium.components.password_manager.BrowserAssistedLoginType;",
      "import org.chromium.components.password_manager.BrowserAssistedLoginType;\nimport org.chromium.components.webauthn.cred_man.CredManSupportProvider;",
      "standalone support import",
    );
    source = replaceOnce(
      source,
      "    private boolean couldSupportConditionalMediation() {",
      `    private boolean canDispatchStandaloneCredMan() {
        return isChrome(mWebContents) && CredManSupportProvider.canDispatchStandaloneCredMan();
    }

    private boolean couldSupportConditionalMediation() {`,
      "browser-only standalone dispatch",
    );
    source = replaceOnce(
      source,
      `        if (!GmsCoreUtils.isWebauthnSupported()
                || (!isChrome(mWebContents) && !GmsCoreUtils.isResultReceiverSupported())) {`,
      `        if ((!GmsCoreUtils.isWebauthnSupported() && !canDispatchStandaloneCredMan())
                || (!isChrome(mWebContents) && !GmsCoreUtils.isResultReceiverSupported())
                || (canDispatchStandaloneCredMan()
                        && (options.isConditional || options.isPaymentCredentialCreation))) {`,
      "standalone mediated create gate",
    );
    source = replaceOnce(
      source,
      `        if (!GmsCoreUtils.isWebauthnSupported()
                || (!isChrome(mWebContents) && !GmsCoreUtils.isResultReceiverSupported())
                || (options.publicKey == null && !isPasswordOnlyFlux)) {`,
      `        if ((!GmsCoreUtils.isWebauthnSupported() && !canDispatchStandaloneCredMan())
                || (!isChrome(mWebContents) && !GmsCoreUtils.isResultReceiverSupported())
                || (options.publicKey == null && !isPasswordOnlyFlux)
                || (canDispatchStandaloneCredMan()
                        && (options.publicKey == null || mPayment != null
                                || options.mediation == Mediation.CONDITIONAL
                                || options.mediation == Mediation.IMMEDIATE))) {`,
      "standalone mediated get gate",
    );
    source = replaceOnce(
      source,
      `        mPendingFido2CredentialRequest = getFido2CredentialRequest();
        mPendingFido2CredentialRequest.handleReportRequest(options, assertNonNull(mOrigin));`,
      `        if (!GmsCoreUtils.isWebauthnSupported()) {
            mRequestCallback.onComplete(WebauthnRequestResponse.forReport(AuthenticatorStatus.NOT_IMPLEMENTED));
            return;
        }
        mPendingFido2CredentialRequest = getFido2CredentialRequest();
        mPendingFido2CredentialRequest.handleReportRequest(options, assertNonNull(mOrigin));`,
      "GMS-only report gate",
    );
    source = replaceOnce(
      source,
      "AuthenticatorConstants.CAPABILITY_HYBRID_TRANSPORT, true)",
      "AuthenticatorConstants.CAPABILITY_HYBRID_TRANSPORT, GmsCoreUtils.isWebauthnSupported())",
      "no invented standalone hybrid",
    );
    source = replaceOnce(
      source,
      "createWebAuthnClientCapability(AuthenticatorConstants.CAPABILITY_PPAA, true)",
      "createWebAuthnClientCapability(AuthenticatorConstants.CAPABILITY_PPAA, GmsCoreUtils.isWebauthnSupported())",
      "no invented standalone platform availability",
    );
    source = replaceOnce(
      source,
      `        // This assumes GMSCore is available and up-to-date, hence this should report "true". This
        // assumption should be revisited if it proves insufficient.`,
      `        // Preserve GMS-backed capabilities, but do not invent an authenticator/provider on AOSP.`,
      "capability documentation",
    );
    source = replaceOnce(
      source,
      `        // Since we assume that hybridTransport is always true on Android,
        // passkeyPlatformAuthenticator is also always true.`,
      `        // Standalone dispatch alone cannot prove configured provider/user-verification readiness.`,
      "readiness documentation",
    );
    return source;
  });
  edit(`${prefix}Fido2CredentialRequest.java`, (source) => {
    source = replaceOnce(
      source,
      `        if (!rkDiscouraged
                && !options.isPaymentCredentialCreation
                && getBarrierMode() == Barrier.Mode.ONLY_CRED_MAN) {`,
      `        if ((!rkDiscouraged || CredManSupportProvider.canDispatchStandaloneCredMan())
                && !options.isPaymentCredentialCreation
                && getBarrierMode() == Barrier.Mode.ONLY_CRED_MAN) {`,
      "standalone creation options preserved",
    );
    source = replaceOnce(
      source,
      `            } else {
                if (is(mAuthenticationContextProvider.getWebContents(), WebauthnMode.CHROME)) {
                    // WebauthnMode.CHROME_3PP_ENABLED will keep using CredMan's no credentials UI.`,
      `            } else {
                if (mPlayServicesAvailable
                        && is(mAuthenticationContextProvider.getWebContents(), WebauthnMode.CHROME)) {
                    // Without GMS, keep the platform's genuine no-credentials/provider UI.`,
      "no absent-GMS fallback",
    );
    source = replaceOnce(
      source,
      `        boolean chromeRequest = isChrome(mAuthenticationContextProvider.getWebContents());
        if ((!chromeRequest`,
      `        boolean chromeRequest = isChrome(mAuthenticationContextProvider.getWebContents());
        if (chromeRequest && CredManSupportProvider.canDispatchStandaloneCredMan()) {
            // Android public APIs cannot enumerate another app's enabled/UV-capable providers.
            callback.onIsUserVerifyingPlatformAuthenticatorAvailableResponse(false);
            return;
        }
        if ((!chromeRequest`,
      "conservative standalone UV readiness",
    );
    return source;
  });
}
