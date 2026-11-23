// spec/os/agentService/inference.md, "Story: Embed, speak and transcribe on my phone through my app alone"; spec/os/agentService/inference.md, "Only the app's own process is served, for an operation the host offers, within its frame limit and its model storage"
package ai.eliza.voice;

import ai.eliza.os.agent.inference.InferenceHost;
import android.content.Context;
import java.io.File;

/** Starts the agent service's inference host over this module's natives and an installed speech bundle. */
public final class LocalInferenceHost {
  /** Contexts idle this long are released; the next request opens them again. */
  public static final long IDLE_UNLOAD_MS = 5 * 60_000L;

  private LocalInferenceHost() {}

  /**
   * Binds {@code socket} and serves the resident agent's engine: speech from {@code bundle}, embeddings
   * and loaded models only from files under {@code modelStorage}. Throws when the native library or the
   * socket is unavailable, so nothing is advertised. Call off the main thread; stop the returned host.
   */
  public static InferenceHost start(Context context, String socket, VoiceAssets.Bundle bundle, File modelStorage) {
    File bundles = new File(context.getNoBackupFilesDir(), "inference-host/embedding-bundles");
    if (!bundles.isDirectory() && !bundles.mkdirs()) throw new IllegalStateException("cannot create the embedding bundle directory");
    InferenceHost host = new InferenceHost(socket, bundle.root.getAbsolutePath(), modelStorage,
        new HostInferenceNative(bundle.root.getAbsolutePath(), bundles), IDLE_UNLOAD_MS);
    host.start();
    return host;
  }
}
