package ai.eliza.plugins.media;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.UUID;

/**
 * Temporary read-only copies of reviewed bytes, handed to one viewer through the host's
 * FileProvider. At most one copy exists at a time: writing a new copy revokes and deletes the
 * previous one, and {@link #cleanup()} removes every copy (call it at load and teardown). The
 * host injects the FileProvider authority, the cache sub-folder and the provider path name its
 * {@code <cache-path name="…" path="…/">} entry declares; shared code never chooses product names.
 */
public final class ReviewedFileHandoff {
  private final Context context;
  private final String authority, folder, pathName;

  /**
   * @param authority the host's FileProvider authority, e.g. {@code <package>.attachments}
   * @param folder the cache sub-folder the provider path points at
   * @param pathName the provider path name that appears as the first URI path segment
   */
  public ReviewedFileHandoff(Context context, String authority, String folder, String pathName) {
    if (authority == null || authority.isEmpty() || !DocumentExport.validSegment(folder)
        || !DocumentExport.validSegment(pathName))
      throw new IllegalArgumentException("Invalid handoff configuration");
    this.context = context.getApplicationContext();
    this.authority = authority;
    this.folder = folder;
    this.pathName = pathName;
  }

  public String authority() {
    return authority;
  }

  private File directory() {
    File directory = new File(context.getCacheDir(), folder);
    if (!directory.isDirectory() && !directory.mkdirs())
      throw new IllegalStateException("Handoff folder unavailable");
    return directory;
  }

  /**
   * Writes and syncs a new copy named {@code <uuid>-<name>}, after removing every earlier copy.
   * The caller has already validated the name and bytes (see {@link DocumentBytes#validate}).
   */
  public File write(String name, byte[] data) throws IOException {
    if (name == null || name.isEmpty() || name.length() > 255 || name.contains("/")
        || name.contains("\\") || name.contains("\0"))
      throw new IllegalArgumentException("Invalid handoff name");
    cleanup();
    File file = new File(directory(), UUID.randomUUID() + "-" + name);
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(data);
      out.getFD().sync();
    } catch (IOException | RuntimeException failure) {
      revoke(file);
      throw failure;
    }
    return file;
  }

  /** The content URI of a copy this handoff wrote. */
  public Uri uri(File file) {
    return FileProvider.getUriForFile(context, authority, file);
  }

  /** Revokes any read grant on the copy and deletes it. */
  public void revoke(File file) {
    try {
      context.revokeUriPermission(uri(file), Intent.FLAG_GRANT_READ_URI_PERMISSION);
    } catch (RuntimeException ignored) {
    }
    file.delete();
  }

  /** Revokes and deletes every copy. */
  public void cleanup() {
    File[] files = directory().listFiles();
    if (files != null)
      for (File file : files)
        revoke(file);
  }

  /**
   * True only for a content URI of this handoff: its authority and exactly
   * {@code /<pathName>/<file>}.
   */
  public boolean admits(Uri uri) {
    if (uri == null || !"content".equals(uri.getScheme()) || !authority.equals(uri.getAuthority()))
      return false;
    List<String> segments = uri.getPathSegments();
    return DocumentExport.handoffPath(segments, pathName);
  }
}
