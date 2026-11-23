// spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

public final class RecoveryArchive {
  private record Moved(Path source, Path archive, int retainedCount) {}
  private final Map<Path, Moved> pending = new HashMap<>();

  int retained(Path source) throws IOException {
    verifyParent(source);
    Moved moved = pending.get(source);
    return moved == null ? count(source) : moved.retainedCount();
  }

  void requireSettled(Path source) throws IOException {
    if (pending.containsKey(source)) throw new IOException("The moved records still need reviewed recovery");
  }

  int archive(Path source, AgentDirectories directories, int retainedCount, long epoch, long nowMillis) throws IOException {
    verifyParent(source);
    Moved moved = pending.get(source);
    if (moved == null) {
      Path archive = move(source, directories.recoveryArchive(), epoch, nowMillis);
      moved = new Moved(source, archive, retainedCount);
      pending.put(source, moved);
    }
    if (!Files.isDirectory(moved.archive(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("The moved records could not be found");
    directories.sync().directory(moved.archive().getParent());
    directories.sync().directory(moved.source().getParent());
    pending.remove(source);
    return moved.retainedCount();
  }

  private static void verifyParent(Path source) throws IOException {
    if (!Files.isDirectory(source.getParent(), LinkOption.NOFOLLOW_LINKS))
      throw new IOException("The agent's state parent is not a real directory");
  }

  private static int count(Path state) throws IOException {
    try (Stream<Path> files = Files.walk(state)) {
      return (int) files.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)).count();
    }
  }

  private static Path move(Path stateDir, Path archiveRoot, long epoch, long nowMillis) throws IOException {
    if (!Files.isDirectory(stateDir, LinkOption.NOFOLLOW_LINKS)) throw new IOException(stateDir + " is not a state directory");
    if (!Files.isDirectory(archiveRoot, LinkOption.NOFOLLOW_LINKS)) throw new IOException(archiveRoot + " is not a real directory");
    Path archived = archiveRoot.resolve(stateDir.getFileName() + "-" + epoch + "-" + nowMillis);
    if (Files.exists(archived, LinkOption.NOFOLLOW_LINKS)) throw new IOException(archived + " already holds an archive");
    Files.move(stateDir, archived, StandardCopyOption.ATOMIC_MOVE);
    return archived;
  }
}
