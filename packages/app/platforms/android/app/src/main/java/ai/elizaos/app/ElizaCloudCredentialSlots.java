package ai.elizaos.app;

import ai.eliza.auth.cloud.CloudCredentialSlots;
import ai.eliza.auth.cloud.CloudSignInConfig;
import ai.eliza.auth.cloud.CloudSignInEnvironment;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/**
 * Eliza's protected storage for the shared native Cloud sign-in client. Pure (no Android class), so
 * the slot policy runs on a plain JVM; {@link ElizaCloudSignInPlugin} supplies the two stores.
 *
 * - The minted key goes where Eliza's renderer already reads its Cloud session: the secure store's
 *   {@code session.steward_token} (the {@link TokenStore}). The hosted sign-in this replaces stored
 *   its key there too, so a phone that is already signed in keeps its session unchanged.
 * - That one token slot serves every admitted deployment, so a native-only owner record (by SHA-256
 *   digest, never the token) says which deployment minted it. A deployment reads its credential slot
 *   only while the stored token is still the one it minted: a token the renderer replaced, cleared or
 *   saved earlier is never presented to another deployment, revoked by it or resumed against it.
 * - The pending browser record and the acknowledgement receipts are native-only
 *   ({@link NativeSlots}); the renderer never reads them.
 *
 * The guard runs before every write and removal, as {@link CloudCredentialSlots} requires.
 */
final class ElizaCloudCredentialSlots implements CloudCredentialSlots {
    /** The renderer-readable session token slot (secure store {@code session.steward_token}). */
    interface TokenStore {
        String read() throws Exception;
        void write(String token) throws Exception;
        void remove() throws Exception;
    }

    /** Native-only slots by name. */
    interface NativeSlots {
        String read(String slot) throws Exception;
        void write(String slot, String value) throws Exception;
        void remove(String slot) throws Exception;
    }

    private final CloudSignInConfig config;
    private final Runnable guard;
    private final TokenStore tokens;
    private final NativeSlots slots;

    ElizaCloudCredentialSlots(CloudSignInConfig config, Runnable guard, TokenStore tokens, NativeSlots slots) {
        if (config == null || guard == null || tokens == null || slots == null) throw new IllegalArgumentException();
        this.config = config;
        this.guard = guard;
        this.tokens = tokens;
        this.slots = slots;
    }

    @Override public String read(String slot) throws Exception {
        CloudSignInEnvironment environment = credentialEnvironment(slot);
        if (environment != null) return ownedCredential(environment);
        requireNativeSlot(slot);
        return slots.read(slot);
    }

    @Override public void write(String slot, String value) throws Exception {
        CloudSignInEnvironment environment = credentialEnvironment(slot);
        if (environment == null) requireNativeSlot(slot);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Credential value is empty");
        guard.run();
        if (environment == null) {
            slots.write(slot, value);
            return;
        }
        JSONObject credential = new JSONObject(value);
        String token = credential.getString("token");
        if (token.isEmpty()) throw new IllegalArgumentException("Credential token is empty");
        JSONObject owner = new JSONObject()
            .put("version", 1)
            .put("environment", environment.name)
            .put("tokenSha256", sha256(token))
            .put("credentialId", credential.getString("credentialId"))
            .put("serverCredentialId", credential.getString("serverCredentialId"))
            .put("expiresAt", credential.getLong("expiresAt"));
        // Owner first: until the token is written, neither deployment claims the old token.
        slots.write(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT, owner.toString());
        guard.run();
        tokens.write(token);
    }

    @Override public void remove(String slot) throws Exception {
        CloudSignInEnvironment environment = credentialEnvironment(slot);
        if (environment == null) requireNativeSlot(slot);
        guard.run();
        if (environment == null) {
            slots.remove(slot);
            return;
        }
        JSONObject owner = owner();
        if (owner == null || !environment.name.equals(owner.optString("environment", null))) return;
        // The token goes only when this deployment still owns it; the owner record goes either way.
        if (ownedCredential(environment) != null) tokens.remove();
        guard.run();
        slots.remove(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT);
    }

    /** The credential this deployment minted, rebuilt from the owner record and the current token. */
    private String ownedCredential(CloudSignInEnvironment environment) throws Exception {
        JSONObject owner = owner();
        if (owner == null || !environment.name.equals(owner.optString("environment", null))) return null;
        String token = tokens.read();
        if (token == null || token.isEmpty() || !sha256(token).equals(owner.optString("tokenSha256", null))) return null;
        try {
            return new JSONObject()
                .put("credentialId", owner.getString("credentialId"))
                .put("token", token)
                .put("expiresAt", owner.getLong("expiresAt"))
                .put("serverCredentialId", owner.getString("serverCredentialId"))
                .toString();
        } catch (Exception malformed) {
            return null;
        }
    }

    private JSONObject owner() throws Exception {
        String raw = slots.read(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT);
        if (raw == null) return null;
        try {
            JSONObject owner = new JSONObject(raw);
            Object version = owner.opt("version");
            return version instanceof Number && ((Number) version).intValue() == 1 ? owner : null;
        } catch (Exception malformed) {
            return null;
        }
    }

    private CloudSignInEnvironment credentialEnvironment(String slot) {
        if (slot == null) throw new IllegalArgumentException("Unsupported credential slot");
        for (CloudSignInEnvironment environment : config.environments())
            if (config.credentialSlot(environment).equals(slot)) return environment;
        return null;
    }

    private void requireNativeSlot(String slot) {
        if (config.pendingSlot.equals(slot)) return;
        for (CloudSignInEnvironment environment : config.environments())
            if (config.receiptSlot(environment).equals(slot)) return;
        throw new IllegalArgumentException("Unsupported credential slot");
    }

    static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return hex.toString();
    }
}
