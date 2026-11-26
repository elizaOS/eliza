// spec/os/android/camera.md, "A recording is confirmed only by a complete bridge receipt that the host read back"
package android.util;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;

public class AtomicFile {
  private final File base;
  private final File next;
  private final File legacy;

  public AtomicFile(File base) {
    this.base = base;
    this.next = new File(base.getPath() + ".new");
    this.legacy = new File(base.getPath() + ".bak");
  }

  public File getBaseFile() {
    return base;
  }

  private void restoreLegacy() {
    if (legacy.exists()) {
      base.delete();
      if (!legacy.renameTo(base)) throw new IllegalStateException("legacy backup not restored");
    }
  }

  public FileInputStream openRead() throws FileNotFoundException {
    restoreLegacy();
    if (next.exists() && base.exists()) next.delete();
    return new FileInputStream(base);
  }

  public byte[] readFully() throws IOException {
    try (FileInputStream in = openRead()) { return in.readAllBytes(); }
  }

  public FileOutputStream startWrite() throws IOException {
    restoreLegacy();
    return new FileOutputStream(next);
  }

  public void finishWrite(FileOutputStream out) {
    try {
      out.getFD().sync();
      out.close();
    } catch (IOException ignored) {
    }
    if (!next.renameTo(base)) throw new IllegalStateException("rename failed");
  }

  public void failWrite(FileOutputStream out) {
    try {
      out.close();
    } catch (IOException ignored) {
    }
    next.delete();
  }

  public void delete() {
    base.delete();
    next.delete();
    legacy.delete();
  }
}
