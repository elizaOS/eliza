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
  private final Map<AgentCredentials.Account, Moved> pending = new HashMap<>();

  int retained(AgentCredentials.Account account, AgentDirectories directories) throws IOException {
    Moved moved = pending.get(account);
    return moved == null ? count(state(account, directories)) : moved.retainedCount();
  }

  void requireSettled(AgentCredentials.Account account) throws IOException {
    if (pending.containsKey(account)) throw new IOException("The moved records still need reviewed recovery");
  }

  int archive(AgentCredentials.Account account, AgentDirectories directories, int retainedCount, long epoch, long nowMillis) throws IOException {
    Moved moved = pending.get(account);
    if (moved == null) {
      Path source = state(account, directories);
      Path archive = move(source, directories.recoveryArchive(), epoch, nowMillis);
      moved = new Moved(source, archive, retainedCount);
      pending.put(account, moved);
    }
    if (!Files.isDirectory(moved.archive(), LinkOption.NOFOLLOW_LINKS)) throw new IOException("The moved records could not be found");
    directories.sync().directory(moved.archive().getParent());
    directories.sync().directory(moved.source().getParent());
    pending.remove(account);
    return moved.retainedCount();
  }

  private static Path state(AgentCredentials.Account account, AgentDirectories directories) throws IOException {
    return directories.state(account.userId(), account.organizationId());
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
