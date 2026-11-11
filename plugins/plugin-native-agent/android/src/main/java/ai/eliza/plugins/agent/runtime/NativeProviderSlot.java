package ai.eliza.plugins.agent.runtime;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The resident agent's provider slot: binding a direct provider key, clearing the slot, and the
 * process environment the agent launches with when no provider can be applied. Every write is a
 * compare-and-exchange against the value read just before it, then read back; a write or removal
 * the store cannot confirm is a failure, never a silent success. The store's {@code assertCurrent}
 * carries the caller's credential intent ({@link CredentialIntentFence}) and bridge lifetime.
 *
 * <p>Product builds bind direct keys only after an explicit owner choice: {@link #directProviderAllowed} does not trigger provider requests; Cloud remains available through
 * {@link NativeProviderAdmission#bindCloudProvider}.
 */
public final class NativeProviderSlot {
  private NativeProviderSlot() {}

  /** The product's encrypted provider slot. */
  public interface Store {
    String readProvider() throws Exception;

    /** Host credential authority; changes retire status captured under an earlier account. */
    default long authorityEpoch() { return 0; }

    /** Throws when the caller's credential intent or bridge is no longer current. */
    void assertCurrent() throws Exception;

    /**
     * Replaces previous with selection; null when the slot changed meanwhile. The store must make the
     * same credential-intent check as {@link #assertCurrent} under the lock that guards the write,
     * and throw without writing when the intent is stale, so an intent superseded after the caller's
     * own assertCurrent can never commit. The second assertCurrent in {@link
     * #saveVerifiedProvider} only reports; it cannot undo a write.
     */
    String compareExchangeProvider(String previous, String selection) throws Exception;

    /** Removes the slot (onlyIfPresent: only when it holds a value, without creating state). */
    void removeProvider(boolean onlyIfPresent) throws Exception;
  }

  /** Answers a candidate key with null when accepted, otherwise a renderer-safe refusal. */
  public interface KeyCheck {
    String check(String key, String model);
  }

  public static final String CEREBRAS_MODELS_URL = "https://api.cerebras.ai/v1/models";
  public static final int PROVIDER_CHECK_TIMEOUT_MS = 10_000, PROVIDER_CHECK_BODY_LIMIT = 256 * 1024;

  /** An explicit owner-selected direct provider is supported in product and development builds. */
  public static boolean directProviderAllowed(boolean testMocks) {
    return true;
  }

  /**
   * Interprets Cerebras' bounded models listing. Returns null when the key is accepted and the
   * pinned model is listed, otherwise a renderer-safe message (never the key or response body).
   */
  public static String providerCheckFailure(int status, String body, String model) {
    if (status == 401 || status == 403) return "Cerebras did not accept this key. It was not saved.";
    if (status == 429) return "Cerebras is rate-limiting key checks. Try again shortly; the key was not saved.";
    if (status < 200 || status >= 300) return "Cerebras could not confirm this key right now. It was not saved.";
    try {
      JSONArray models = new JSONObject(body).getJSONArray("data");
      for (int i = 0; i < models.length(); i++) {
        JSONObject row = models.optJSONObject(i);
        if (row != null && model.equals(row.optString("id"))) return null;
      }
      return "This Cerebras key does not offer " + model + ". It was not saved.";
    } catch (Exception invalid) {
      return "Cerebras returned an unexpected response. The key was not saved.";
    }
  }

  /** One bounded GET of the Cerebras models listing: no redirects, no caching, no retry. */
  public static String checkCerebrasKey(String key, String model) {
    javax.net.ssl.HttpsURLConnection connection = null;
    try {
      connection = (javax.net.ssl.HttpsURLConnection) new java.net.URL(CEREBRAS_MODELS_URL).openConnection();
      connection.setInstanceFollowRedirects(false);
      connection.setUseCaches(false);
      connection.setConnectTimeout(PROVIDER_CHECK_TIMEOUT_MS);
      connection.setReadTimeout(PROVIDER_CHECK_TIMEOUT_MS);
      connection.setRequestMethod("GET");
      connection.setRequestProperty("Accept", "application/json");
      connection.setRequestProperty("Authorization", "Bearer " + key);
      int status = connection.getResponseCode();
      if (status < 200 || status >= 300) return providerCheckFailure(status, "", model);
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      try (InputStream input = connection.getInputStream()) {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) != -1) {
          if (bytes.size() + read > PROVIDER_CHECK_BODY_LIMIT)
            return "Cerebras returned an unexpected response. The key was not saved.";
          bytes.write(buffer, 0, read);
        }
      }
      return providerCheckFailure(status, bytes.toString("UTF-8"), model);
    } catch (Exception unreachable) {
      return "Cerebras could not be reached to check this key. It was not saved.";
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  /**
   * Verify before saving: a key is stored only after the check accepts it, then read back. Returns
   * null when saved, otherwise a renderer-safe refusal; product names the product in the
   * pinned-model refusal.
   */
  public static String saveVerifiedProvider(Store store, String key, String model, KeyCheck check, String product)
      throws Exception {
    if (!NativeProviderAdmission.validProviderToken(key, 1024)) return "Enter a valid Cerebras key.";
    if (!NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL.equals(model))
      return product + " uses " + NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL + " on Cerebras.";
    return saveVerifiedProvider(store, key, model, null, check, product);
  }

  /** Optional speech shares the existing encrypted provider slot. Saving never sends audio. */
  public static String saveVerifiedProvider(Store store, String key, String model, String cartesiaKey, KeyCheck check, String product) throws Exception {
    if (!NativeProviderAdmission.validProviderToken(key, 1024)) return "Enter a valid Cerebras key.";
    if (!NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL.equals(model)) return "Choose the supported Cerebras model.";
    if (cartesiaKey != null && !NativeProviderAdmission.validProviderToken(cartesiaKey, 1024)) return "Enter a valid Cartesia key or leave voice off.";
    String previous = store.readProvider();
    store.assertCurrent();
    String failure = check.check(key, model);
    if (failure != null) return failure;
    store.assertCurrent();
    String selection = directSelection(previous, key, cartesiaKey);
    if (store.compareExchangeProvider(previous, selection) == null) throw new IllegalStateException("Provider changed");
    store.assertCurrent();
    JSONObject saved = new JSONObject(store.readProvider());
    if (!key.equals(saved.optString("key")) || !model.equals(saved.optString("model"))
        || !java.util.Objects.equals(new JSONObject(selection).opt("cartesiaKey"), saved.opt("cartesiaKey")))
      throw new IllegalStateException("Provider credentials could not be confirmed");
    return null;
  }

  /** Direct configuration is an explicit native admission; omitted Voice preserves the saved key. */
  public static void bindDirectProvider(Store store, String key, String model) throws Exception {
    bindDirectProvider(store, key, model, null);
  }

  public static void bindDirectProvider(Store store, String key, String model, String cartesiaKey) throws Exception {
    if (cartesiaKey != null && !NativeProviderAdmission.validProviderToken(cartesiaKey, 1024)) throw new IllegalArgumentException();
    if (!NativeProviderAdmission.validProviderToken(key, 1024) || !model.equals(NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL))
      throw new IllegalArgumentException();
    String previous = store.readProvider();
    store.assertCurrent();
    if (store.compareExchangeProvider(previous, directSelection(previous, key, cartesiaKey)) == null)
      throw new IllegalStateException("Provider changed");
  }

  private static String directSelection(String previous, String textKey, String voiceKey) throws Exception {
    JSONObject old = previous == null ? new JSONObject() : new JSONObject(previous);
    JSONObject selection = new JSONObject().put("provider", "cerebras")
        .put("model", NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL)
        .put("revision", UUID.randomUUID().toString());
    NativeProviderAdmission.retainOwnKeys(old, selection);
    if (textKey != null) selection.put("key", textKey);
    if (voiceKey != null) selection.put("cartesiaKey", voiceKey);
    JSONObject services = "elizacloud".equals(old.optString("provider")) ? cloudServices(old) : old.optJSONObject("cloudServices");
    if (services != null) selection.put("cloudServices", services);
    return selection.toString();
  }

  public static JSONObject cloudServices(JSONObject selected) throws Exception {
    JSONObject services = new JSONObject(selected.toString());
    services.remove("key"); services.remove("cartesiaKey"); services.remove("cloudServices");
    return services;
  }

  /** An opaque selection/account version; contains no credential or secret-derived digest. */
  public static String managementRevision(String saved, long epoch) throws Exception {
    return (saved == null ? "none" : new JSONObject(saved).optString("revision", "legacy")) + ":" + epoch;
  }

  /** Metadata only. Saved-key presence is separate from the currently selected billing route. */
  public static JSONObject managementStatus(String saved, String cloud, long now, long epoch) throws Exception {
    JSONObject result = NativeProviderAdmission.providerStatus(saved, cloud, now);
    JSONObject selected = saved == null ? new JSONObject() : new JSONObject(saved);
    result.put("mode", "cerebras".equals(selected.optString("provider")) ? "own" : "cloud")
        .put("revision", managementRevision(saved, epoch)).put("persistence", "native-secure-store")
        .put("keys", new JSONObject()
            .put("text", new JSONObject().put("configured", NativeProviderAdmission.validProviderToken(selected.optString("key", ""), 1024)))
            .put("voice", new JSONObject().put("configured", NativeProviderAdmission.validProviderToken(selected.optString("cartesiaKey", ""), 1024))));
    return result;
  }

  public static String requireManagementRevision(Store store, String expectedRevision) throws Exception {
    store.assertCurrent();
    String previous = store.readProvider();
    if (expectedRevision == null || !expectedRevision.equals(managementRevision(previous, store.authorityEpoch())))
      throw new IllegalStateException("Provider changed; reload Settings");
    return previous;
  }

  /** Validate only supplied Text; a Voice-only edit never resends or replaces saved Text. */
  public static String editKeys(Store store, String expectedRevision, String textKey, String voiceKey, KeyCheck check) throws Exception {
    if (textKey == null && voiceKey == null) throw new IllegalArgumentException("Choose a key to edit");
    if (textKey != null && !NativeProviderAdmission.validProviderToken(textKey, 1024)
        || voiceKey != null && !NativeProviderAdmission.validProviderToken(voiceKey, 1024))
      throw new IllegalArgumentException("Enter a valid key");
    String previous = requireManagementRevision(store, expectedRevision);
    if (textKey != null) {
      String failure = check.check(textKey, NativeProviderAdmission.CEREBRAS_PROVIDER_MODEL);
      if (failure != null) return failure;
    }
    if (!java.util.Objects.equals(previous, requireManagementRevision(store, expectedRevision)))
      throw new IllegalStateException("Provider changed");
    JSONObject next = previous == null ? new JSONObject().put("provider", "elizacloud")
        .put("model", NativeProviderAdmission.CLOUD_PROVIDER_MODEL) : new JSONObject(previous);
    if (textKey != null) next.put("key", textKey);
    if (voiceKey != null) next.put("cartesiaKey", voiceKey);
    commitKeys(store, previous, next);
    return null;
  }

  public static void removeKey(Store store, String expectedRevision, String key) throws Exception {
    String field = keyField(key), previous = requireManagementRevision(store, expectedRevision);
    if (previous == null) return;
    JSONObject next = new JSONObject(previous);
    if (!next.has(field)) return;
    next.remove(field);
    commitKeys(store, previous, next);
  }

  private static void commitKeys(Store store, String previous, JSONObject next) throws Exception {
    next.put("revision", UUID.randomUUID().toString());
    store.assertCurrent();
    String committed = store.compareExchangeProvider(previous, next.toString());
    store.assertCurrent();
    if (committed == null || !committed.equals(store.readProvider())) throw new IllegalStateException("Provider change unconfirmed");
  }

  /** Native-only value for an explicit protected reveal surface, never a bridge result. */
  public static String revealKey(Store store, String expectedRevision, String key) throws Exception {
    String field = keyField(key), saved = requireManagementRevision(store, expectedRevision);
    String value = saved == null ? "" : new JSONObject(saved).optString(field, "");
    if (!NativeProviderAdmission.validProviderToken(value, 1024)) throw new IllegalStateException("Key is not saved");
    store.assertCurrent();
    return value;
  }

  private static String keyField(String key) {
    if ("text".equals(key)) return "key";
    if ("voice".equals(key)) return "cartesiaKey";
    throw new IllegalArgumentException("Choose Text or Voice");
  }

  /** Selecting saved Own keys never calls a provider and never selects a Cloud account. */
  public static void selectOwn(Store store, String expectedRevision) throws Exception {
    String previous = requireManagementRevision(store, expectedRevision);
    if (previous == null || !NativeProviderAdmission.validProviderToken(new JSONObject(previous).optString("key", ""), 1024))
      throw new IllegalStateException("Save a Text key first");
    String selection = directSelection(previous, null, null);
    store.assertCurrent();
    String committed = store.compareExchangeProvider(previous, selection);
    store.assertCurrent();
    if (committed == null || !committed.equals(store.readProvider())) throw new IllegalStateException("Provider change unconfirmed");
  }

  /** Retires routing while retaining Own keys; records without keys keep legacy slot removal. */
  public static JSONObject clearProviderSlot(Store store, boolean onlyIfPresent) throws Exception {
    String previous = store.readProvider();
    store.assertCurrent();
    String kept = NativeProviderAdmission.unbindProvider(previous);
    if (kept == null) store.removeProvider(onlyIfPresent);
    else if (!kept.equals(previous) && store.compareExchangeProvider(previous, kept) == null)
      throw new IllegalStateException("Provider changed");
    store.assertCurrent();
    String retained = store.readProvider();
    if (kept != null && !kept.equals(retained)) throw new IllegalStateException("Saved keys could not be confirmed");
    if (retained != null && !new JSONObject(retained).optBoolean("unbound")) throw new IllegalStateException("Provider binding still present");
    return NativeProviderAdmission.providerIdentity(retained);
  }

  /** Provider, Cloud and managed-Google variables an unbound launch must not inherit. */
  public static final String[] PROVIDER_ENVIRONMENT = {
    "ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_BASE_URL", "ELIZAOS_CLOUD_SMALL_MODEL", "ELIZAOS_CLOUD_LARGE_MODEL",
    "ELIZAOS_CLOUD_USE_EMBEDDINGS", "ELIZAOS_CLOUD_EMBEDDING_MODEL", "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS",
    "CEREBRAS_API_KEY", "CEREBRAS_BASE_URL", "CEREBRAS_MODEL", "CEREBRAS_SMALL_MODEL", "CEREBRAS_LARGE_MODEL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "ELIZA_PROVIDER",
    "CARTESIA_API_KEY", "CARTESIA_API_KEY_FILE", "ELIZA_SELF_HOSTED_VOICE_ENABLED", "ELIZA_SELF_HOSTED_VOICE_CLOUD_RELAY_ENABLED",
    "ELIZA_LOCAL_EMBEDDING_MODEL_PATH", "ELIZA_LOCAL_EMBEDDING_DIMENSIONS",
    "ELIZA_NATIVE_GOOGLE_HOST_MODULE", "ELIZA_NATIVE_GOOGLE_BINDING_JSON", "ELIZA_NATIVE_GOOGLE_API_KEY",
    "ELIZA_MANAGED_GMAIL_READ_BROKER", "ELIZA_MANAGED_GMAIL_SEND_BROKER", "ELIZA_MANAGED_GMAIL_OPERATION_BROKER",
    "ELIZA_MANAGED_CALENDAR_READ_BROKER",
    // Default-off Google mutations stay off unless a product admits them.
    "ELIZA_MANAGED_CALENDAR_DELETE_ENABLED", "ELIZA_NATIVE_GOOGLE_GMAIL_SEND_ENABLED", "ELIZA_MANAGED_GMAIL_MAILBOX_CHANGES_ENABLED"
  };

  /**
   * No admitted plan, Cloud unreachable without a recent plan, or signed out: the agent runs with
   * no hosted inference. Every provider credential and selector is removed, so no request can reach
   * a model provider, and the runtime answers chat turns as provider-less (no_provider). Embeddings
   * start disabled; the native runtime profile ({@link NativeRuntimeEmbeddings}) applied afterwards
   * enables the packaged on-device model when present.
   */
  public static void applyUnboundEnvironment(Map<String, String> env) {
    for (String name : PROVIDER_ENVIRONMENT) env.remove(name);
    env.put("ELIZAOS_CLOUD_USE_INFERENCE", "false");
    env.put("ELIZAOS_CLOUD_USE_EMBEDDINGS", "false");
    env.put("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "true");
    env.put("ELIZA_LOCAL_EMBEDDING_ENABLED", "0");
    env.put("ELIZA_HOST_CONTEXT_REVISION", "boot:" + UUID.randomUUID());
  }

  /**
   * The provider half of a resident launch, in the one order every product uses: apply the stored
   * provider selection (an elizacloud selection needs its current Cloud credential), or launch
   * unbound when there is none or it cannot be applied; then let the native runtime profile own the
   * embedding route ({@link NativeRuntimeEmbeddings}). So a native profile bound to Eliza Cloud
   * still ends with on-device BGE embeddings, never Cloud embeddings. The {@code cloud} QA profile
   * admits only an elizacloud selection. Returns whether a provider was applied; a provider that
   * cannot be applied never blocks the launch.
   */
  public static boolean applyLaunchEnvironment(
      String runtimeProfile,
      JSONObject provider,
      String cloudSaved,
      java.io.File nativeLibraryDirectory,
      java.io.File filesDirectory,
      Map<String, String> env,
      long now) {
    return applyLaunchEnvironment(runtimeProfile, provider, cloudSaved, nativeLibraryDirectory, filesDirectory, env, now,
        NativeProviderAdmission.CLOUD_PROVIDER_BASE);
  }

  /**
   * As above for a product that runs its own Cloud: an elizacloud selection sends its credential
   * to {@code cloudProviderBase} (see {@link NativeProviderAdmission#requireCloudProviderBase}).
   */
  public static boolean applyLaunchEnvironment(
      String runtimeProfile,
      JSONObject provider,
      String cloudSaved,
      java.io.File nativeLibraryDirectory,
      java.io.File filesDirectory,
      Map<String, String> env,
      long now,
      String cloudProviderBase) {
    NativeProviderAdmission.requireCloudProviderBase(cloudProviderBase);
    boolean bound = false;
    if (provider != null) {
      Map<String, String> applied = new java.util.HashMap<>(env);
      try {
        NativeProviderAdmission.applyProviderEnvironment(provider, cloudSaved, applied, now, cloudProviderBase);
        env.clear();
        env.putAll(applied);
        bound = true;
      } catch (Exception unusable) {
        bound = false;
      }
    }
    if (!bound) applyUnboundEnvironment(env);
    NativeRuntimeEmbeddings.apply(runtimeProfile, nativeLibraryDirectory, filesDirectory, env);
    return bound;
  }
}
