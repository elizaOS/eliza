package ai.elizaos.app;

import ai.eliza.auth.cloud.CloudCredentialSlots;
import ai.eliza.auth.cloud.CloudSignInConfig;
import ai.eliza.auth.cloud.CloudSignInEnvironment;
import ai.eliza.plugins.securestore.nativeonly.CredentialIntentFence;
import ai.eliza.plugins.securestore.nativeonly.CredentialMutationConductor;
import ai.eliza.plugins.securestore.nativeonly.CredentialSlotMutation;
import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import android.content.Context;
import android.os.SystemClock;
import java.io.File;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Canonical storage binding for the shared resident credential conductor. No token copy or provider inference. */
final class ElizaResidentCredentials {
    static final String TOKEN_KEY = "session.steward_token";
    private static final Object LIFECYCLE = new Object();
    private static final CredentialIntentFence INTENTS = new CredentialIntentFence(LIFECYCLE);
    private static long lifecycleEpoch, mutationEpoch = -1;

    private ElizaResidentCredentials() {}

    static <T> T withCredentialRead(java.util.concurrent.Callable<T> read) throws Exception {
        synchronized (LIFECYCLE) {
            synchronized (JsonCredentialSlots.LOCK) {
                if (mutationEpoch >= 0) throw new IllegalStateException("Credential mutation in progress");
                return read.call();
            }
        }
    }


    static boolean isResidentCredential(String key) { return TOKEN_KEY.equals(key); }

    /** Reserve before async dispatch, shared by native sign-in and generic SecureStore writes. */
    static Runnable reserve() {
        long intent = INTENTS.reserve();
        return () -> INTENTS.require(intent);
    }

    /** Read-only request fence over existing lifecycle/intent state; reserves no authority. */
    static final class Observation {
        private final long intent, epoch;
        private final ElizaAgentService.RequestObservation runtime;
        private Observation() {
            synchronized (LIFECYCLE) {
                if (mutationEpoch != -1) throw new IllegalStateException("Credential mutation pending");
                intent = INTENTS.current(); epoch = lifecycleEpoch; runtime = ElizaAgentService.observeRequests();
            }
        }
        boolean same(Observation other) { return other != null && intent == other.intent && epoch == other.epoch && runtime.same(other.runtime); }
        <T> T withCurrent(NativeSecureStore.Effect<T> effect) throws Exception {
            synchronized (LIFECYCLE) {
                INTENTS.require(intent);
                if (epoch != lifecycleEpoch || mutationEpoch != -1)
                    throw new IllegalStateException("Credential lifecycle changed");
                return runtime.withCurrent(() -> effect.run());
            }
        }
    }
    static Observation observe() { return new Observation(); }

    static <T> T mutateToken(Context context, String key, String value, Runnable guard,
            NativeSecureStore.Effect<T> effect) throws Exception {
        if (!isResidentCredential(key)) { guard.run(); return effect.run(); }
        Binding binding = new Binding(context, guard);
        return binding.mutate(key, value, effect::run);
    }

    static CloudCredentialSlots cloud(Context context, Runnable guard) {
        Binding binding = new Binding(context, guard);
        return new CloudCredentialSlots() {
            public String read(String slot) throws Exception {
                synchronized (LIFECYCLE) {
                    synchronized (JsonCredentialSlots.LOCK) { return binding.cloud.read(slot); }
                }
            }
            public void write(String slot, String value) throws Exception {
                if (binding.credentialSlot(slot)) {
                    binding.mutate(slot, value, () -> {
                        binding.cloud.write(slot, value); return null;
                    });
                } else binding.withLocks(() -> { binding.cloud.write(slot, value); return null; });
            }
            public void remove(String slot) throws Exception {
                if (binding.credentialSlot(slot)) {
                    binding.mutate(slot, null, () -> {
                        binding.cloud.remove(slot); return null;
                    });
                } else binding.withLocks(() -> { binding.cloud.remove(slot); return null; });
            }
        };
    }

    private static final class Binding {
        final Context context;
        final Runnable guard;
        final CloudSignInConfig config = ElizaCloudSignInPlugin.REGISTRATION;
        final NativeSecureStore tokens;
        final ElizaCloudCredentialSlots.NativeSlots nativeSlots;
        final ElizaCloudCredentialSlots cloud;

        Binding(Context context, Runnable guard) {
            this.context = context.getApplicationContext();
            this.guard = guard;
            tokens = new NativeSecureStore(this.context);
            JsonCredentialSlots json = new JsonCredentialSlots(
                new File(this.context.getNoBackupFilesDir(), "eliza-cloud-signin"),
                "ai.elizaos.app.cloud-signin.v1", slot -> 16 * 1024);
            nativeSlots = new ElizaCloudCredentialSlots.NativeSlots() {
                public String read(String slot) throws Exception {
                    String raw = json.read(slot);
                    if (raw == null) return null;
                    Object value = new JSONTokener(raw).nextValue();
                    if (!(value instanceof String)) throw new IllegalStateException("Unexpected sign-in record");
                    return (String) value;
                }
                public void write(String slot, String value) throws Exception { json.write(slot, JSONObject.quote(value)); }
                public void remove(String slot) throws Exception { json.remove(slot); }
            };
            cloud = new ElizaCloudCredentialSlots(config, guard, new ElizaCloudCredentialSlots.TokenStore() {
                public String read() throws Exception { return tokens.get(TOKEN_KEY); }
                public void write(String token) throws Exception { tokens.set(TOKEN_KEY, token); }
                public void remove() throws Exception { tokens.remove(TOKEN_KEY); }
            }, nativeSlots);

        }

        boolean credentialSlot(String slot) {
            for (CloudSignInEnvironment environment : config.environments())
                if (config.credentialSlot(environment).equals(slot)) return true;
            return false;
        }

        String read(String name) throws Exception {
            return TOKEN_KEY.equals(name) ? tokens.get(name) : cloud.read(name);
        }

        <T> T mutate(String name, String value, java.util.concurrent.Callable<T> write) throws Exception {
            return CredentialSlotMutation.replace(host(), guard, () -> read(name), value, write, () -> {
                nativeSlots.remove(config.pendingSlot);
                return null;
            });
        }

        <T> T withLocks(java.util.concurrent.Callable<T> action) throws Exception {
            synchronized (LIFECYCLE) {
                synchronized (JsonCredentialSlots.LOCK) { guard.run(); return action.call(); }
            }
        }

        CredentialMutationConductor.Host host() {
            return new CredentialMutationConductor.Host() {
                public Object lifecycleLock() { return LIFECYCLE; }
                public Object credentialLock() { return JsonCredentialSlots.LOCK; }
                public long beginRetirement() { return mutationEpoch = ++lifecycleEpoch; }
                public void requireCurrent(long epoch) {
                    if (epoch != lifecycleEpoch || mutationEpoch != epoch)
                        throw new IllegalStateException("Credential mutation superseded");
                }
                public long reserveStop() { return ElizaCredentialRetirement.reserve(); }
                public void requestStop(long request) { ElizaCredentialRetirement.request(context, request); }
                public boolean stopped() throws Exception {
                    return ElizaCredentialRetirement.stopped(context);
                }
                public boolean stopAcknowledged(long request) { return ElizaCredentialRetirement.acknowledged(request); }
                public long elapsedRealtime() { return SystemClock.elapsedRealtime(); }
                public void sleep(long millis) throws InterruptedException { Thread.sleep(millis); }
                public <T> T commit(CredentialMutationConductor.Mutation<T> mutation) throws Exception { return mutation.commit(); }
                public void finishMutation(long epoch, long request, boolean attempted, boolean committed) {
                    if (request >= 0) {
                        if (!attempted) ElizaCredentialRetirement.abandon(request);
                        else if (committed) ElizaCredentialRetirement.release(request);
                    }
                    if (mutationEpoch == epoch) mutationEpoch = -1;
                }
            };
        }
    }
}
