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
 * <p>Product builds never bind a direct (bring-your-own) key: {@link #directProviderAllowed} is a
 * test-mocks developer surface only; products use the owner's Eliza Cloud plan through
 * {@link NativeProviderAdmission#bindCloudProvider}.
 */
public final class NativeProviderSlot {
  private NativeProviderSlot() {}

  /** The product's encrypted provider slot. */
  public interface Store {
    String readProvider() throws Exception;

    /** Throws when the caller's credential intent or bridge is no longer current. */
    void assertCurrent() throws Exception;

    /** Replaces previous with selection; null when the slot changed meanwhile. */
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

  /** A direct provider key is a test-mocks developer surface only. */
  public static boolean directProviderAllowed(boolean testMocks) {
    return testMocks;
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
    String failure = check.check(key, model);
    if (failure != null) return failure;
    store.assertCurrent();
    bindDirectProvider(store, key, model);
    store.assertCurrent();
    JSONObject saved = new JSONObject(store.readProvider());
    if (!key.equals(saved.optString("key")) || !model.equals(saved.optString("model"))) throw new IllegalStateException();
    return null;
  }

  /** Direct configuration is an explicit native admission; renderer metadata is never accepted. */
  public static void bindDirectProvider(Store store, String key, String model) throws Exception {
    if (!NativeProviderAdmission.validProviderToken(key, 1024) || !model.matches(NativeProviderAdmission.PROVIDER_MODEL_PATTERN))
      throw new IllegalArgumentException();
    String previous = store.readProvider();
    String selection =
        new JSONObject()
            .put("provider", "cerebras")
            .put("key", key)
            .put("model", model)
            .put("revision", UUID.randomUUID().toString())
            .toString();
    if (store.compareExchangeProvider(previous, selection) == null) throw new IllegalStateException();
  }

  /** Deletes the provider slot and confirms by reading it back; returns the unconfigured identity. */
  public static JSONObject clearProviderSlot(Store store, boolean onlyIfPresent) throws Exception {
    store.removeProvider(onlyIfPresent);
    if (store.readProvider() != null) throw new IllegalStateException("Provider key still present");
    return NativeProviderAdmission.providerIdentity(null);
  }

  /** Provider, Cloud and managed-Google variables an unbound launch must not inherit. */
  public static final String[] PROVIDER_ENVIRONMENT = {
    "ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_BASE_URL", "ELIZAOS_CLOUD_SMALL_MODEL", "ELIZAOS_CLOUD_LARGE_MODEL",
    "ELIZAOS_CLOUD_USE_EMBEDDINGS", "ELIZAOS_CLOUD_EMBEDDING_MODEL", "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS",
    "CEREBRAS_API_KEY", "CEREBRAS_BASE_URL", "CEREBRAS_MODEL", "CEREBRAS_SMALL_MODEL", "CEREBRAS_LARGE_MODEL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "ELIZA_PROVIDER",
    "ELIZA_LOCAL_EMBEDDING_MODEL_PATH", "ELIZA_LOCAL_EMBEDDING_DIMENSIONS",
    "ELIZA_NATIVE_GOOGLE_HOST_MODULE", "ELIZA_NATIVE_GOOGLE_BINDING_JSON",
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
    boolean bound = false;
    if (provider != null && (!"cloud".equals(runtimeProfile) || "elizacloud".equals(provider.optString("provider")))) {
      Map<String, String> applied = new java.util.HashMap<>(env);
      try {
        NativeProviderAdmission.applyProviderEnvironment(provider, cloudSaved, applied, now);
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
