package ai.eliza.plugins.agent.runtime;

import java.io.File;
import java.io.IOException;

/** Android filesystem operations for private, durably published runtime bundles. */
public final class AndroidRuntimeDirectories {
  private AndroidRuntimeDirectories() {}

  public static void ensurePrivateRuntimeParent(File directory) throws IOException {
    try {
      android.system.StructStat before = android.system.Os.lstat(directory.getAbsolutePath());
      if (!android.system.OsConstants.S_ISDIR(before.st_mode) || before.st_uid != android.os.Process.myUid())
        throw new IOException("Runtime storage parent must be an app-owned real directory");
      android.system.Os.chmod(directory.getAbsolutePath(), 0700);
      android.system.StructStat after = android.system.Os.lstat(directory.getAbsolutePath());
      if (after.st_dev != before.st_dev || after.st_ino != before.st_ino || after.st_uid != before.st_uid || (after.st_mode & 0777) != 0700)
        throw new IOException("Runtime storage parent permissions could not be verified");
    } catch (android.system.ErrnoException error) {
      throw new IOException("Cannot secure runtime storage parent", error);
    }
  }

  public static void syncRuntimeDirectory(java.nio.file.Path path) throws IOException {
    java.io.FileDescriptor descriptor = null;
    try {
      descriptor = android.system.Os.open(path.toString(), android.system.OsConstants.O_RDONLY
        | android.system.OsConstants.O_NOFOLLOW, 0);
      if (!android.system.OsConstants.S_ISDIR(android.system.Os.fstat(descriptor).st_mode))
        throw new IOException("Runtime sync target is not a directory");
      android.system.Os.fsync(descriptor);
    } catch (android.system.ErrnoException error) {
      throw new IOException("Cannot durably publish runtime directory", error);
    } finally {
      if (descriptor != null) try { android.system.Os.close(descriptor); }
      catch (android.system.ErrnoException error) { throw new IOException("Cannot close runtime directory", error); }
    }
  }
}
