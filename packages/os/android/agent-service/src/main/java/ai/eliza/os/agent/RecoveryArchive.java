// spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

public final class RecoveryArchive {
  private RecoveryArchive() {}

  public static Path archive(Path stateDir, Path archiveRoot, long epoch, long nowMillis, AgentDirectories.Sync sync) throws IOException {
    if (!Files.isDirectory(stateDir, LinkOption.NOFOLLOW_LINKS)) throw new IOException(stateDir + " is not a state directory");
    if (!Files.isDirectory(archiveRoot, LinkOption.NOFOLLOW_LINKS)) throw new IOException(archiveRoot + " is not a real directory");
    Path archived = archiveRoot.resolve(stateDir.getFileName() + "-" + epoch + "-" + nowMillis);
    if (Files.exists(archived, LinkOption.NOFOLLOW_LINKS)) throw new IOException(archived + " already holds an archive");
    Files.move(stateDir, archived, StandardCopyOption.ATOMIC_MOVE);
    sync.directory(archiveRoot);
    sync.directory(stateDir.toAbsolutePath().getParent());
    return archived;
  }
}
