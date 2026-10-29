package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.runtime.CredentialIntentFence;
import ai.eliza.plugins.agent.runtime.NativeProviderAdmission;
import ai.eliza.plugins.agent.runtime.NativeProviderSlot;
import ai.eliza.plugins.agent.runtime.NativeRuntimeEmbeddings;
import ai.eliza.plugins.agent.runtime.ResidentAttachment;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * Host-JVM contract of the resident lifecycle building blocks: credential-intent fencing, provider
 * slot binding with compare-and-exchange readback, the unbound launch, attach admission and the
 * launch environment's embedding order. No Android, network or real credential.
 */
public final class ResidentLifecycleTest {
  private static int assertions;

  private static void check(boolean value, String name) {
    assertions++;
    if (!value) throw new AssertionError(name);
  }

  interface Action {
    void run() throws Exception;
  }

  private static void refused(Action action, String name) {
    try {
      action.run();
    } catch (Exception expected) {
      check(true, name);
      return;
    }
    check(false, name);
  }

  static final String KEY = "csk-test-key-not-a-secret-0123", MODEL = NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL;
  static final String ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
  static final long NOW = 1_800_000_000_000L;

  /** In-memory slot whose compare-exchange is exact and whose assertCurrent is the intent fence. */
  static final class Slot implements NativeProviderSlot.Store {
    String value;
    boolean conflict, removeIgnored;
    Action current = () -> {};
    int writes;

    public String readProvider() {
      return value;
    }

    public void assertCurrent() throws Exception {
      current.run();
    }

    public String compareExchangeProvider(String previous, String selection) {
      if (conflict || !Objects.equals(previous, value)) return null;
      value = selection;
      writes++;
      return selection;
    }

    public void removeProvider(boolean onlyIfPresent) {
      if (!removeIgnored) value = null;
    }
  }

  static JSONObject running() throws Exception {
    return new JSONObject().put("state", "listening").put("serviceActive", true).put("socketListening", true);
  }

  static ResidentAttachment.Facts admitted(long now) {
    ResidentAttachment.Facts f = new ResidentAttachment.Facts();
    f.accepting = true;
    f.currentRoot = "root-1";
    f.enrolledRoot = "root-1";
    f.ownerToken = "owner-session";
    f.ownerIdentity = "owner";
    f.now = now;
    f.expiresAt = now + 600_000;
    f.launchedGeneration = "generation-1";
    f.currentGeneration = "generation-1";
    return f;
  }

  interface Change {
    void apply(ResidentAttachment.Facts facts);
  }

  static void attachRefused(String expected, Change change) throws Exception {
    ResidentAttachment.Facts facts = admitted(NOW);
    change.apply(facts);
    String actual = ResidentAttachment.refusal(running(), facts);
    check(expected.equals(actual), "expected " + expected + " but got " + actual);
  }

  public static void main(String[] args) throws Exception {
    // Credential intent: the newest reservation wins; older work cannot commit.
    Object lock = new Object();
    CredentialIntentFence fence = new CredentialIntentFence(lock);
    long first = fence.reserve(), second = fence.reserve();
    check(second > first && fence.current() == second && fence.isCurrent(second) && !fence.isCurrent(first), "newest intent wins");
    fence.require(second);
    refused(() -> fence.require(first), "superseded intent refused");
    check(new CredentialIntentFence().reserve() == 1, "independent fences");

    // Direct provider: test-mocks only; verified, compare-exchanged and read back.
    check(NativeProviderSlot.directProviderAllowed(true) && !NativeProviderSlot.directProviderAllowed(false), "direct key is a test-mocks surface");
    Slot slot = new Slot();
    AtomicInteger checks = new AtomicInteger();
    NativeProviderSlot.KeyCheck accept = (key, model) -> {
      checks.incrementAndGet();
      return null;
    };
    check(("Product uses " + MODEL + " on Cerebras.").equals(NativeProviderSlot.saveVerifiedProvider(slot, KEY, "llama-4", accept, "Product")), "pinned model refusal names the product");
    check("Enter a valid Cerebras key.".equals(NativeProviderSlot.saveVerifiedProvider(slot, "bad key", MODEL, accept, "Product")), "invalid key refused");
    check(checks.get() == 0 && slot.value == null, "nothing checked or saved before validation");
    String refusal = NativeProviderSlot.saveVerifiedProvider(slot, KEY, MODEL, (key, model) -> "Cerebras did not accept this key. It was not saved.", "Product");
    check(refusal.contains("did not accept") && slot.value == null, "refused key is not saved");
    check(NativeProviderSlot.saveVerifiedProvider(slot, KEY, MODEL, accept, "Product") == null, "accepted key saved");
    JSONObject saved = new JSONObject(slot.value);
    check("cerebras".equals(saved.getString("provider")) && KEY.equals(saved.getString("key")) && MODEL.equals(saved.getString("model")) && saved.getString("revision").length() == 36, "saved selection");
    check(NativeProviderAdmission.providerIdentity(slot.value).getBoolean("configured") && !NativeProviderAdmission.providerIdentity(slot.value).toString().contains(KEY), "identity never carries the key");
    String before = slot.value;
    slot.conflict = true;
    refused(() -> NativeProviderSlot.saveVerifiedProvider(slot, KEY, MODEL, accept, "Product"), "a concurrent write is a failure, not a silent save");
    check(before.equals(slot.value), "conflict leaves the newer value");
    slot.conflict = false;
    long stale = fence.current();
    fence.reserve();
    slot.current = () -> fence.require(stale);
    int writes = slot.writes;
    refused(() -> NativeProviderSlot.saveVerifiedProvider(slot, KEY, MODEL, accept, "Product"), "superseded intent cannot save");
    check(slot.writes == writes, "superseded intent wrote nothing");
    slot.current = () -> {};
    refused(() -> NativeProviderSlot.bindDirectProvider(slot, KEY, "bad model!"), "malformed model refused");

    // Clearing reads back; a slot that stays present is a failure.
    JSONObject cleared = NativeProviderSlot.clearProviderSlot(slot, false);
    check(slot.value == null && !cleared.getBoolean("configured"), "cleared and read back");
    check(!NativeProviderSlot.clearProviderSlot(slot, true).getBoolean("configured"), "clearing an empty slot");
    slot.value = before;
    slot.removeIgnored = true;
    refused(() -> NativeProviderSlot.clearProviderSlot(slot, false), "unconfirmed removal fails");

    // Provider check interpretation never echoes the key or body.
    String listed = "{\"data\":[{\"id\":\"" + MODEL + "\"}]}";
    check(NativeProviderSlot.providerCheckFailure(200, listed, MODEL) == null, "listed model accepted");
    check(NativeProviderSlot.providerCheckFailure(200, "{\"data\":[{\"id\":\"llama-4\"}]}", MODEL).contains("does not offer"), "unlisted model");
    for (int status : new int[] {401, 403}) check(NativeProviderSlot.providerCheckFailure(status, "secret-echo", MODEL).contains("did not accept"), "rejected key");
    check(NativeProviderSlot.providerCheckFailure(429, "", MODEL).contains("rate-limiting"), "rate limited");
    check(NativeProviderSlot.providerCheckFailure(503, "", MODEL).contains("could not confirm"), "unavailable");
    check(!NativeProviderSlot.providerCheckFailure(200, "secret-echo", MODEL).contains("secret-echo"), "malformed body never echoed");

    // Unbound launch: every provider credential and selector removed.
    Map<String, String> unbound = new HashMap<>();
    for (String name : NativeProviderSlot.PROVIDER_ENVIRONMENT) unbound.put(name, "stale");
    unbound.put("PATH", "/system/bin");
    NativeProviderSlot.applyUnboundEnvironment(unbound);
    for (String name : NativeProviderSlot.PROVIDER_ENVIRONMENT)
      check(!unbound.containsKey(name) || "false".equals(unbound.get(name)), "unbound removes " + name);
    check("false".equals(unbound.get("ELIZAOS_CLOUD_USE_INFERENCE")) && "true".equals(unbound.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) && "/system/bin".equals(unbound.get("PATH")), "unbound selectors");
    check(unbound.get("ELIZA_HOST_CONTEXT_REVISION").startsWith("boot:"), "unbound launch has a fresh host revision");

    // Launch environment: native profile plus elizacloud ends with local BGE embeddings.
    Path root = Files.createTempDirectory("resident-lifecycle");
    File files = root.resolve("files").toFile(), libs = root.resolve("libs").toFile();
    Files.createDirectories(libs.toPath());
    File model = new File(files, NativeRuntimeEmbeddings.LOCAL_MODEL_PATH);
    Files.createDirectories(model.getParentFile().toPath());
    for (File asset : new File[] {new File(libs, "libelizainference.so"), new File(libs, "libelizavoicejni.so"), model}) asset.createNewFile();
    JSONObject cloudSelection =
        new JSONObject().put("provider", "elizacloud").put("credentialId", ID).put("model", NativeProviderAdmission.CLOUD_PROVIDER_MODEL).put("revision", "9b2d6c34-6f0a-4d0e-9f63-2b8e1f0c7a11");
    String cloudCredential =
        new JSONObject().put("credentialId", ID).put("token", "eliza_test_token_not_a_secret_0123456789").put("expiresAt", NOW + 60_000).toString();
    for (String profile : new String[] {"native", "", null}) {
      Map<String, String> env = new HashMap<>();
      check(NativeProviderSlot.applyLaunchEnvironment(profile, cloudSelection, cloudCredential, libs, files, env, NOW), "Cloud provider bound under " + profile);
      check("true".equals(env.get("ELIZAOS_CLOUD_USE_INFERENCE")) && NativeProviderAdmission.CLOUD_PROVIDER_BASE.equals(env.get("ELIZAOS_CLOUD_BASE_URL")), "Cloud inference under " + profile);
      check("false".equals(env.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")) && !env.containsKey("ELIZAOS_CLOUD_EMBEDDING_MODEL"), "no Cloud embeddings under " + profile);
      check("1".equals(env.get("ELIZA_LOCAL_EMBEDDING_ENABLED")) && model.getAbsolutePath().equals(env.get("ELIZA_LOCAL_EMBEDDING_MODEL_PATH")) && NativeRuntimeEmbeddings.LOCAL_DIMENSIONS.equals(env.get("ELIZA_LOCAL_EMBEDDING_DIMENSIONS")), "local BGE embeddings under " + profile);
    }
    // The cloud QA profile keeps admission's Cloud embeddings, and admits only elizacloud.
    Map<String, String> qa = new HashMap<>();
    check(NativeProviderSlot.applyLaunchEnvironment("cloud", cloudSelection, cloudCredential, libs, files, qa, NOW) && "true".equals(qa.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")), "cloud QA profile keeps Cloud embeddings");
    JSONObject direct = new JSONObject().put("provider", "cerebras").put("key", KEY).put("model", MODEL).put("revision", "9b2d6c34-6f0a-4d0e-9f63-2b8e1f0c7a11");
    Map<String, String> qaDirect = new HashMap<>();
    check(!NativeProviderSlot.applyLaunchEnvironment("cloud", direct, null, libs, files, qaDirect, NOW) && !qaDirect.containsKey("CEREBRAS_API_KEY"), "cloud QA profile refuses a direct key");
    // An expired Cloud credential or no provider launches unbound, still with local embeddings.
    for (JSONObject provider : new JSONObject[] {cloudSelection, null}) {
      Map<String, String> env = new HashMap<>();
      env.put("ELIZAOS_CLOUD_API_KEY", "stale");
      check(!NativeProviderSlot.applyLaunchEnvironment("native", provider, provider == null ? null : cloudCredential, libs, files, env, NOW + 120_000), "unusable provider launches unbound");
      check(!env.containsKey("ELIZAOS_CLOUD_API_KEY") && "false".equals(env.get("ELIZAOS_CLOUD_USE_INFERENCE")) && "1".equals(env.get("ELIZA_LOCAL_EMBEDDING_ENABLED")), "unbound launch keeps local embeddings");
    }
    // Missing local inputs leave embeddings unavailable, never a Cloud fallback.
    new File(libs, "libelizavoicejni.so").delete();
    Map<String, String> missing = new HashMap<>();
    NativeProviderSlot.applyLaunchEnvironment("native", cloudSelection, cloudCredential, libs, files, missing, NOW);
    check("false".equals(missing.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")) && "0".equals(missing.get("ELIZA_LOCAL_EMBEDDING_ENABLED")), "missing JNI leaves embeddings off");
    refused(() -> NativeProviderSlot.applyLaunchEnvironment("unknown", null, null, libs, files, new HashMap<>(), NOW), "unknown profile fails closed");

    // Attach admission.
    check(ResidentAttachment.refusal(running(), admitted(NOW)) == null, "admitted running resident attaches");
    check(ResidentAttachment.describe(null).getBoolean("attachable") && !ResidentAttachment.describe(null).has("reason"), "attachable result has no reason");
    attachRefused("lifecycle-retiring", f -> f.accepting = false);
    attachRefused("lifecycle-retiring", f -> f.stopping = true);
    attachRefused("provider-changing", f -> f.credentialMutating = true);
    attachRefused("provider-changing", f -> f.credentialShutdownPending = true);
    attachRefused("attach-unverified", f -> f.attachUnverified = true);
    attachRefused("runtime-token-unavailable", f -> f.currentRoot = null);
    attachRefused("not-enrolled", f -> f.enrolledRoot = null);
    attachRefused("not-enrolled", f -> f.ownerToken = "");
    attachRefused("runtime-changed", f -> f.currentRoot = "root-2");
    attachRefused("enrollment-expiring", f -> f.expiresAt = f.now + ResidentAttachment.ENROLLMENT_MARGIN_MS);
    attachRefused("provider-changed", f -> f.currentGeneration = "generation-2");
    attachRefused("provider-unadmitted", f -> f.launchedGeneration = null);
    // The no-provider generation: an unbound resident attaches while no provider is stored.
    ResidentAttachment.Facts unboundFacts = admitted(NOW);
    unboundFacts.launchedGeneration = NativeProviderAdmission.NO_PROVIDER_GENERATION;
    unboundFacts.currentGeneration = NativeProviderAdmission.NO_PROVIDER_GENERATION;
    check(ResidentAttachment.refusal(running(), unboundFacts) == null, "unbound resident attaches");
    attachRefused("provider-changed", f -> {
      f.launchedGeneration = NativeProviderAdmission.NO_PROVIDER_GENERATION;
      f.currentGeneration = "generation-1";
    });
    for (JSONObject state : new JSONObject[] {null, new JSONObject(), running().put("state", "booting"), running().put("serviceActive", false), running().put("socketListening", false)})
      check("runtime-not-running".equals(ResidentAttachment.refusal(state, admitted(NOW))), "only a listening service attaches");
    check("unavailable".equals(ResidentAttachment.refusal(running(), null)), "missing facts refuse");
    for (String secret : new String[] {"root-1", "owner-session", "generation-1"}) {
      ResidentAttachment.Facts facts = admitted(NOW);
      facts.currentGeneration = "other";
      check(!ResidentAttachment.refusal(running(), facts).contains(secret), "reason never leaks a private value");
    }
    ResidentAttachment.Requests attached = new ResidentAttachment.Requests();
    attached.add(null);
    attached.add("first");
    check(attached.size() == 1 && attached.remove("first") && !attached.remove("first"), "attached start cancelled once");
    for (int i = 0; i < ResidentAttachment.Requests.LIMIT + 8; i++) attached.add("request-" + i);
    check(attached.size() == ResidentAttachment.Requests.LIMIT && !attached.remove("request-0"), "bounded memory forgets the oldest");

    // Shutdown and startup readings of the boot state.
    JSONObject dead = new JSONObject().put("state", "dead").put("serviceActive", false).put("socketListening", false);
    check(ResidentAttachment.shutdownConfirmed(dead), "confirmed shutdown");
    check(!ResidentAttachment.shutdownConfirmed(new JSONObject().put("state", "dead")) && !ResidentAttachment.shutdownConfirmed(null) && !ResidentAttachment.shutdownConfirmed(running()), "unconfirmed shutdowns");
    for (String reason : new String[] {"ipc-recovery-retention-limit", "ipc-recovery-required", "runtime-identity-unavailable"}) {
      String message = ResidentAttachment.startupRefusalMessage(reason);
      check(message != null && message.contains("records") && (!message.contains("clear app data") || message.contains("not clear app data") || message.contains("Do not clear app data")), "startup refusal keeps records: " + reason);
    }
    check(ResidentAttachment.startupRefusalMessage("booting") == null && ResidentAttachment.startupRefusalMessage(null) == null, "other reasons keep waiting");

    System.out.println("PASS resident lifecycle (" + assertions + " assertions)");
  }
}
