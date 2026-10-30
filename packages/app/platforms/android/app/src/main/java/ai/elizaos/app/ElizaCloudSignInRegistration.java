package ai.elizaos.app;

import ai.eliza.auth.cloud.CloudSignInConfig;
import ai.eliza.auth.cloud.CloudSignInEnvironment;

/**
 * Eliza's registration with the shared native Eliza Cloud sign-in client (packages/auth/android,
 * {@code ai.eliza.auth.cloud}). Pure: no Android class, so it is checked on a plain JVM.
 *
 * - App Auth client {@code ai.elizaos.app}, whose registered return is
 *   {@code https://eliza.app/auth/callback} in both deployments (Cloud's reserved first-party
 *   mobile client). The return is the App Auth binding string only: email codes, SMS codes and the
 *   native Google account picker never open a browser, so no App Link is declared for it.
 * - Deployments: production through {@code cloud.eliza.app}; staging through
 *   {@code cloud-staging.eliza.app}, admitted only in development builds.
 * - Installed storage names below are compatibility identifiers: changing one abandons a saved
 *   sign-in, an acknowledgement receipt or the readiness cache on installed phones.
 *
 * No credential value is part of this registration.
 */
final class ElizaCloudSignInRegistration {
    private ElizaCloudSignInRegistration() {}

    static final String CLIENT_ID = "ai.elizaos.app";
    static final String PRODUCT_NAME = "Eliza";
    /** Device label on the minted key; the hosted sign-in this replaces used the same label. */
    static final String DEVICE_NAME = "Android";
    /** Steward app client of Eliza's Android app for native Google. */
    static final String GOOGLE_CLIENT_ID = "eliza-app";
    static final String SERVICE_NAME = "Eliza Cloud";
    static final String CALLBACK_HOST = "eliza.app";
    static final String CALLBACK_PATH = "/auth/callback";

    static final String PRODUCTION_API_HOST = "cloud.eliza.app";
    static final String PRODUCTION_TENANT = "elizacloud";
    static final String STAGING_API_HOST = "cloud-staging.eliza.app";
    static final String STAGING_TENANT = "elizacloud-staging";

    static final String LOG_TAG = "ElizaCloudSignIn";
    static final String READINESS_PREFERENCES = "eliza-cloud-signin-readiness";
    static final String PENDING_SLOT = "cloud-signin:v1:pending";
    static final String RECEIPT_SLOT_PREFIX = "cloud-signin:v1:ack:";
    static final String CREDENTIAL_SLOT_PREFIX = "cloud:";
    /**
     * Native-only record of which deployment the shared session token was minted for, by digest. The
     * token itself lives where the renderer reads it (the secure store's session.steward_token).
     */
    static final String TOKEN_OWNER_SLOT = "cloud-signin:v1:token-owner";

    static final CloudSignInEnvironment PRODUCTION = new CloudSignInEnvironment(
        "production", PRODUCTION_API_HOST, CALLBACK_HOST, PRODUCTION_TENANT, SERVICE_NAME, CALLBACK_PATH);
    static final CloudSignInEnvironment STAGING = new CloudSignInEnvironment(
        "staging", STAGING_API_HOST, CALLBACK_HOST, STAGING_TENANT, SERVICE_NAME, CALLBACK_PATH);

    /** Production always; staging only when this build admits it (development builds). */
    static CloudSignInConfig registration(boolean admitStaging) {
        CloudSignInConfig.Builder builder = CloudSignInConfig.builder()
            .clientId(CLIENT_ID)
            .deviceName(DEVICE_NAME)
            .productName(PRODUCT_NAME)
            .googleClientId(GOOGLE_CLIENT_ID)
            .logTag(LOG_TAG)
            .readinessPreferences(READINESS_PREFERENCES)
            .pendingSlot(PENDING_SLOT)
            .receiptSlotPrefix(RECEIPT_SLOT_PREFIX)
            .credentialSlotPrefix(CREDENTIAL_SLOT_PREFIX)
            .environment(PRODUCTION);
        if (admitStaging) builder.environment(STAGING);
        return builder.build();
    }
}
