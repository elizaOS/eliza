package ai.eliza.plugins.agent.runtime;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/** APK asset transport only. Presence is not integrity, readiness or execution authority. */
public final class RuntimeAssets {
  private RuntimeAssets() {}

  /** Reads at most the host's limit and closes the source on every outcome. */
  public static byte[] read(RuntimeBundleStore.Source source, String asset, int limit) throws IOException {
    if (limit < 1) throw new IllegalArgumentException("Asset limit must be positive");
    try (InputStream input = source.open(asset)) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[Math.min(16384, limit)];
      int size = 0;
      for (;;) {
        int count = input.read(buffer, 0, (int)Math.min(buffer.length, (long)limit - size + 1));
        if (count < 0) return output.toByteArray();
        if (count == 0) {
          int value = input.read();
          if (value < 0) return output.toByteArray();
          if (size == limit) throw new IOException("Runtime asset exceeds size limit");
          output.write(value); size++;
        } else {
          if (count > limit - size) throw new IOException("Runtime asset exceeds size limit");
          output.write(buffer, 0, count); size += count;
        }
      }
    }
  }

  /** Host-selected names are trusted configuration; this is only an availability hint. */
  public static boolean available(RuntimeBundleStore.Source source, Path nativeLibraries,
      String[] libraries, String[] assets) {
    for (String library : libraries) if (!Files.isRegularFile(nativeLibraries.resolve(library))) return false;
    for (String asset : assets) {
      try (InputStream ignored = source.open(asset)) { }
      catch (IOException missing) { return false; }
    }
    return true;
  }
}
