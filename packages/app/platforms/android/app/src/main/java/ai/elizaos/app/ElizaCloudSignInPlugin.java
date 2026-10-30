package ai.elizaos.app;

import ai.eliza.auth.cloud.CloudCredentialSlots;
import ai.eliza.auth.cloud.CloudSignInConfig;
import ai.eliza.auth.cloud.CloudSignInPlugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Eliza's host of the shared native Eliza Cloud sign-in client (packages/auth/android,
 * {@link CloudSignInPlugin}): email codes, SMS codes and Android's native Google account picker,
 * MFA, the mobile App Auth connect/token/ack tail, acknowledgement resume and replaced-key
 * revocation. Eliza supplies only its registration ({@link ElizaCloudSignInRegistration}) and its
 * protected storage ({@link ElizaCloudCredentialSlots}). This replaces the hosted Custom Tab and
 * in-app WebView PKCE sign-in.
 *
 * The renderer reaches it as {@code ElizaCloudSignIn} through
 * {@code @elizaos/auth/auth/native-cloud-sign-in}'s {@code NativeCloudSignInPort}. Results carry no
 * secret; the minted key is written to the secure store's {@code session.steward_token}, which the
 * renderer's storage bridge reads.
 */
@CapacitorPlugin(name = "ElizaCloudSignIn")
public final class ElizaCloudSignInPlugin extends CloudSignInPlugin {
    /** Staging is admitted only by development builds. */
    static final CloudSignInConfig REGISTRATION = ElizaCloudSignInRegistration.registration(
        BuildConfig.DEBUG || BuildConfig.ELIZA_CLOUD_SIGN_IN_STAGING);

    @Override protected CloudSignInConfig registration() { return REGISTRATION; }

    @Override protected Runnable reserveCredentialCommit() { return ElizaResidentCredentials.reserve(); }

    @Override protected CloudCredentialSlots credentials(Runnable guard) {
        return ElizaResidentCredentials.cloud(getContext(), guard);
    }
}
