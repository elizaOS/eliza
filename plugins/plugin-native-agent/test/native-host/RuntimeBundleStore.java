package ai.eliza.plugins.agent.runtime.test;

/** Keep the deployed inventory version while delegating extraction and verification. */
public final class RuntimeBundleStore extends ai.eliza.plugins.agent.runtime.RuntimeBundleStore {
  public static java.nio.file.Path prepare(java.nio.file.Path root, byte[] manifest, Source source, java.nio.file.Path nativeLibraries, Durability durability) throws java.io.IOException {
    return ai.eliza.plugins.agent.runtime.RuntimeBundleStore.prepare(root, manifest, source, nativeLibraries, durability, "eliza-runtime-v1");
  }
  public static java.nio.file.Path prepare(java.nio.file.Path root, byte[] manifest, Source source, java.nio.file.Path nativeLibraries, Durability durability, Faults faults) throws java.io.IOException {
    return ai.eliza.plugins.agent.runtime.RuntimeBundleStore.prepare(root, manifest, source, nativeLibraries, durability, faults, "eliza-runtime-v1");
  }
}
