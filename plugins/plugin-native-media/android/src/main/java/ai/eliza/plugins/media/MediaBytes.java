package ai.eliza.plugins.media;

import java.io.IOException;
import java.io.InputStream;

/** Exact provider readback after a MediaStore write; independent of Android UI. */
public final class MediaBytes {
  public static void verify(InputStream in, byte[] expected) throws IOException {
    if (in == null)
      throw new IOException("Missing readback");
    int offset = 0, count;
    byte[] buffer = new byte[8192];
    while ((count = in.read(buffer)) != -1) {
      if (count == 0)
        throw new IOException("Readback made no progress");
      if (offset + count > expected.length)
        throw new IOException("Readback size changed");
      for (int index = 0; index < count; index++)
        if (buffer[index] != expected[offset + index])
          throw new IOException("Readback bytes changed");
      offset += count;
    }
    if (offset != expected.length)
      throw new IOException("Incomplete readback");
  }
  private MediaBytes() {}
}
