package ai.eliza.plugins.agent.runtime;

import java.io.File;
import java.util.Map;

/**
 * Embedding authority of the declarative native runtime profile
 * (packages/app/src/runtime/native-runtime-profile.ts), applied to the agent
 * process environment after provider admission.
 *
 * <ul>
 *   <li>{@code native} (default): embeddings stay on the device. Provider admission may have
 *       selected Cloud embeddings; they are cleared first, and local BGE embeddings are enabled
 *       only when the packaged inference engine, its JNI bridge and the extracted model are all
 *       present. Missing inputs leave embeddings unavailable, never a silent Cloud fallback.
 *   <li>{@code cloud}: the explicit QA profile without local model payloads keeps the Cloud
 *       embedding route that provider admission selected.
 * </ul>
 *
 * The native embedding session verifies the actual model bytes and vector space before use;
 * this class only selects the route.
 */
public final class NativeRuntimeEmbeddings {
  /** Path of the packaged BGE model under the app files directory. */
  public static final String LOCAL_MODEL_PATH = ".eliza/local-inference/models/bge-small-en-v1.5-f16.gguf";
  public static final String LOCAL_DIMENSIONS = "384";
  static final String[] NATIVE_LIBRARIES = {"libelizainference.so", "libelizavoicejni.so"};

  private NativeRuntimeEmbeddings() {}

  /** Unknown profile names fail closed, matching resolveNativeRuntimeProfile. */
  public static void apply(String profile, File nativeLibraryDirectory, File filesDirectory, Map<String, String> env) {
    if ("cloud".equals(profile)) return;
    if (profile != null && !profile.isEmpty() && !"native".equals(profile))
      throw new IllegalArgumentException("Unknown native runtime profile");
    applyLocal(nativeLibraryDirectory, filesDirectory, env);
  }

  /** Local-only embeddings: never sends memory to Cloud when local inputs are unavailable. */
  public static boolean applyLocal(File nativeLibraryDirectory, File filesDirectory, Map<String, String> env) {
    env.put("ELIZAOS_CLOUD_USE_EMBEDDINGS", "false");
    env.remove("ELIZAOS_CLOUD_EMBEDDING_MODEL");
    env.remove("ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS");
    env.put("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "true");
    env.put("ELIZA_LOCAL_EMBEDDING_ENABLED", "0");
    env.remove("ELIZA_LOCAL_EMBEDDING_MODEL_PATH");
    env.remove("ELIZA_LOCAL_EMBEDDING_DIMENSIONS");
    File model = new File(filesDirectory, LOCAL_MODEL_PATH);
    for (String library : NATIVE_LIBRARIES)
      if (!new File(nativeLibraryDirectory, library).isFile()) return false;
    if (!model.isFile()) return false;
    env.put("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "false");
    env.put("ELIZA_LOCAL_EMBEDDING_ENABLED", "1");
    env.put("ELIZA_LOCAL_EMBEDDING_MODEL_PATH", model.getAbsolutePath());
    env.put("ELIZA_LOCAL_EMBEDDING_DIMENSIONS", LOCAL_DIMENSIONS);
    return true;
  }
}
