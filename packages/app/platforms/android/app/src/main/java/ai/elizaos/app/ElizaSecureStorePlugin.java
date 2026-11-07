package ai.elizaos.app;

import ai.eliza.plugins.securestore.SecureStorePlugin;
import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Product storage binding; the shared plugin owns validation, dispatch and responses. */
@CapacitorPlugin(name = "ElizaSecureStore")
public final class ElizaSecureStorePlugin extends SecureStorePlugin {
    @Override protected boolean useCredentialWorker(String key) {
        return ElizaResidentCredentials.isResidentCredential(key);
    }
    @Override protected Runnable reserveCredentialMutation(String key) {
        return ElizaResidentCredentials.isResidentCredential(key) ? ElizaResidentCredentials.reserve() : () -> {};
    }
    @Override protected <T> T mutateCredential(String key, String value, Runnable guard,
            NativeSecureStore.Effect<T> effect) throws Exception {
        return ElizaResidentCredentials.mutateToken(getContext(), key, value, guard, effect);
    }
}
