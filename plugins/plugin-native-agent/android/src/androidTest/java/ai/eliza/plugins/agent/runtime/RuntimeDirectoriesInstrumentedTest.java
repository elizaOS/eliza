package ai.eliza.plugins.agent.runtime;

import ai.eliza.plugins.agent.runtime.AndroidRuntimeDirectories;
import android.content.Context;
import android.system.Os;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.IOException;
import java.nio.file.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class RuntimeDirectoriesInstrumentedTest {
  private interface Operation { void run() throws Exception; }
  private static void rejects(Operation operation) throws Exception {
    try { operation.run(); fail("Invalid directory accepted"); }
    catch (IOException expected) { }
  }
  @Test public void privateOwnershipAndDurableDirectorySync() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    Path root = Files.createTempDirectory(context.getNoBackupFilesDir().toPath(), "directory-contract-");
    Path directory = Files.createDirectory(root.resolve("bundle"));
    Path regular = Files.write(root.resolve("regular"), new byte[]{1});
    Path link = Files.createSymbolicLink(root.resolve("link"), directory);
    try {
      Os.chmod(directory.toString(), 0771);
      long inode = Os.lstat(directory.toString()).st_ino;
      AndroidRuntimeDirectories.ensurePrivateRuntimeParent(directory.toFile());
      assertEquals(0700, Os.lstat(directory.toString()).st_mode & 0777);
      assertEquals(inode, Os.lstat(directory.toString()).st_ino);
      assertEquals(android.os.Process.myUid(), Os.lstat(directory.toString()).st_uid);
      AndroidRuntimeDirectories.syncRuntimeDirectory(directory);
      AndroidRuntimeDirectories.ensurePrivateRuntimeParent(directory.toFile());
      rejects(() -> AndroidRuntimeDirectories.ensurePrivateRuntimeParent(link.toFile()));
      rejects(() -> AndroidRuntimeDirectories.ensurePrivateRuntimeParent(regular.toFile()));
      rejects(() -> AndroidRuntimeDirectories.ensurePrivateRuntimeParent(root.resolve("missing").toFile()));
      rejects(() -> AndroidRuntimeDirectories.ensurePrivateRuntimeParent(new java.io.File("/system")));
      rejects(() -> AndroidRuntimeDirectories.syncRuntimeDirectory(link));
      rejects(() -> AndroidRuntimeDirectories.syncRuntimeDirectory(regular));
      rejects(() -> AndroidRuntimeDirectories.syncRuntimeDirectory(root.resolve("missing")));
      assertEquals(0700, Os.lstat(directory.toString()).st_mode & 0777);
    } finally {
      Files.deleteIfExists(link); Files.deleteIfExists(regular);
      Files.deleteIfExists(directory); Files.deleteIfExists(root);
    }
  }
}
