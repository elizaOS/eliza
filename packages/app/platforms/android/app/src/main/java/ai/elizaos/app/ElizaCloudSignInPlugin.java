package ai.elizaos.app;

import ai.eliza.auth.cloud.CloudCredentialSlots;
import ai.eliza.auth.cloud.CloudSignInConfig;
import ai.eliza.auth.cloud.CloudSignInPlugin;
import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import android.content.Context;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import org.json.JSONObject;
import org.json.JSONTokener;

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
    /** Native-only slots: a Keystore key of their own, in the no-backup directory. */
    private static final String NATIVE_SLOT_DIRECTORY = "eliza-cloud-signin";
    private static final String NATIVE_SLOT_KEY_ALIAS = "ai.elizaos.app.cloud-signin.v1";
    private static final int NATIVE_SLOT_LIMIT_BYTES = 16 * 1024;
    private static final String TOKEN_KEY = "session.steward_token";

    /** Staging is admitted only by development builds. */
    static final CloudSignInConfig REGISTRATION = ElizaCloudSignInRegistration.registration(
        BuildConfig.DEBUG || BuildConfig.ELIZA_CLOUD_SIGN_IN_STAGING);

    @Override protected CloudSignInConfig registration() { return REGISTRATION; }

    @Override protected CloudCredentialSlots credentials(Runnable guard) {
        Context context = getContext().getApplicationContext();
        NativeSecureStore secure = new NativeSecureStore(context);
        JsonCredentialSlots json = new JsonCredentialSlots(
            new File(context.getNoBackupFilesDir(), NATIVE_SLOT_DIRECTORY), NATIVE_SLOT_KEY_ALIAS, slot -> NATIVE_SLOT_LIMIT_BYTES);
        ElizaCloudCredentialSlots.TokenStore tokens = new ElizaCloudCredentialSlots.TokenStore() {
            @Override public String read() throws Exception { return secure.get(TOKEN_KEY); }
            @Override public void write(String token) throws Exception { secure.set(TOKEN_KEY, token); }
            @Override public void remove() throws Exception { secure.remove(TOKEN_KEY); }
        };
        // JsonCredentialSlots holds JSON values; each value is kept as one JSON string.
        ElizaCloudCredentialSlots.NativeSlots slots = new ElizaCloudCredentialSlots.NativeSlots() {
            @Override public String read(String slot) throws Exception {
                String raw = json.read(slot);
                if (raw == null) return null;
                Object value = new JSONTokener(raw).nextValue();
                if (!(value instanceof String)) throw new IllegalStateException("Unexpected sign-in record");
                return (String) value;
            }
            @Override public void write(String slot, String value) throws Exception { json.write(slot, JSONObject.quote(value)); }
            @Override public void remove(String slot) throws Exception { json.remove(slot); }
        };
        return new ElizaCloudCredentialSlots(REGISTRATION, guard, tokens, slots);
    }
}
