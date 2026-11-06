package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.NativeRuntimeEmbeddings;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

public final class NativeRuntimeEmbeddingsTest {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }

  /** What Cloud provider admission leaves behind before the profile applies. */
  private static Map<String, String> admittedCloud() {
    Map<String, String> env = new HashMap<>();
    env.put("ELIZAOS_CLOUD_USE_EMBEDDINGS", "true");
    env.put("ELIZAOS_CLOUD_EMBEDDING_MODEL", "bge-small-en-v1.5");
    env.put("ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS", "384");
    env.put("ELIZA_DISABLE_LOCAL_EMBEDDINGS", "true");
    env.put("ELIZA_LOCAL_EMBEDDING_ENABLED", "0");
    return env;
  }

  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]).resolve("embeddings");
    File files = root.resolve("files").toFile(), libs = root.resolve("libs").toFile();
    Files.createDirectories(libs.toPath());
    File model = new File(files, NativeRuntimeEmbeddings.LOCAL_MODEL_PATH);
    Files.createDirectories(model.getParentFile().toPath());
    File engine = new File(libs, "libelizainference.so"), jni = new File(libs, "libelizavoicejni.so");
    for (File asset : new File[] {engine, jni, model}) asset.createNewFile();

    // Native profile: Cloud embeddings from admission are replaced by the local model.
    for (String profile : new String[] {"native", "", null}) {
      Map<String, String> env = admittedCloud();
      NativeRuntimeEmbeddings.apply(profile, libs, files, env);
      check("1".equals(env.get("ELIZA_LOCAL_EMBEDDING_ENABLED")));
      check("false".equals(env.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS")));
      check("false".equals(env.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")));
      check(!env.containsKey("ELIZAOS_CLOUD_EMBEDDING_MODEL"));
      check(model.getAbsolutePath().equals(env.get("ELIZA_LOCAL_EMBEDDING_MODEL_PATH")));
      check("384".equals(env.get("ELIZA_LOCAL_EMBEDDING_DIMENSIONS")));
    }

    // Cloud QA profile keeps the admitted Cloud route.
    Map<String, String> cloud = admittedCloud();
    NativeRuntimeEmbeddings.apply("cloud", libs, files, cloud);
    check(cloud.equals(admittedCloud()));

    // A Cloud-profile package with admitted direct keys uses local embeddings only.
    Map<String, String> direct = admittedCloud();
    direct.put("ELIZA_PROVIDER", "cerebras");
    NativeRuntimeEmbeddings.apply("cloud", libs, files, direct);
    check("1".equals(direct.get("ELIZA_LOCAL_EMBEDDING_ENABLED")));
    check("false".equals(direct.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS")));
    check("false".equals(direct.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")));
    check(model.getAbsolutePath().equals(direct.get("ELIZA_LOCAL_EMBEDDING_MODEL_PATH")));
    check("384".equals(direct.get("ELIZA_LOCAL_EMBEDDING_DIMENSIONS")));
    check(!direct.containsKey("ELIZAOS_CLOUD_EMBEDDING_MODEL"));

    // A Cloud provider selection still retains its admitted remote embedding route.
    Map<String, String> selectedCloud = admittedCloud();
    selectedCloud.put("ELIZA_PROVIDER", "elizacloud");
    Map<String, String> expectedCloud = new HashMap<>(selectedCloud);
    NativeRuntimeEmbeddings.apply("cloud", libs, files, selectedCloud);
    check(selectedCloud.equals(expectedCloud));

    // Each missing local input leaves embeddings unavailable, never Cloud.
    for (File asset : new File[] {model, engine, jni}) {
      check(asset.delete());
      Map<String, String> env = admittedCloud();
      env.put("ELIZA_LOCAL_EMBEDDING_MODEL_PATH", "stale-model");
      env.put("ELIZA_LOCAL_EMBEDDING_DIMENSIONS", "1536");
      check(!NativeRuntimeEmbeddings.applyLocal(libs, files, env));
      check("0".equals(env.get("ELIZA_LOCAL_EMBEDDING_ENABLED")));
      check("true".equals(env.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS")));
      check("false".equals(env.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")));
      check(!env.containsKey("ELIZA_LOCAL_EMBEDDING_MODEL_PATH"));
      check(!env.containsKey("ELIZA_LOCAL_EMBEDDING_DIMENSIONS"));
      check(!env.containsKey("ELIZAOS_CLOUD_EMBEDDING_MODEL"));
      Map<String, String> missingDirect = admittedCloud();
      missingDirect.put("ELIZA_PROVIDER", "cerebras");
      missingDirect.put("ELIZA_LOCAL_EMBEDDING_MODEL_PATH", "stale-model");
      NativeRuntimeEmbeddings.apply("cloud", libs, files, missingDirect);
      check("0".equals(missingDirect.get("ELIZA_LOCAL_EMBEDDING_ENABLED")));
      check("true".equals(missingDirect.get("ELIZA_DISABLE_LOCAL_EMBEDDINGS")));
      check("false".equals(missingDirect.get("ELIZAOS_CLOUD_USE_EMBEDDINGS")));
      check(!missingDirect.containsKey("ELIZA_LOCAL_EMBEDDING_MODEL_PATH"));
      check(!missingDirect.containsKey("ELIZAOS_CLOUD_EMBEDDING_MODEL"));
      check(asset.createNewFile());
    }

    try {
      NativeRuntimeEmbeddings.apply("hosted", libs, files, admittedCloud());
      check(false);
    } catch (IllegalArgumentException expected) {
      check(true);
    }
    System.out.println("NativeRuntimeEmbeddingsTest passed " + assertions + " assertions");
  }
}
