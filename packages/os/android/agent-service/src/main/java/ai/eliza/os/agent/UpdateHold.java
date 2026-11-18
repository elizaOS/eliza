// spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"
package ai.eliza.os.agent;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;

public final class UpdateHold {
  private static final int MAGIC = 0x484f4c44;
  private static final Object LOCK = new Object();

  public record Target(long versionCode, String digest) {
    public Target {
      if (versionCode < 1 || digest == null || !digest.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid update target");
    }
  }

  public sealed interface Release permits Successor, EndedAttempt {}
  public record Successor(Target installed) implements Release {}
  public record EndedAttempt(Target target) implements Release {}

  private final Path directory;

  public UpdateHold(Path directory) throws IOException {
    this.directory = directory.toAbsolutePath().normalize();
    Files.createDirectories(this.directory);
    if (!Files.isDirectory(this.directory, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid update hold storage");
  }

  public Target held() throws IOException {
    synchronized (LOCK) { return load(); }
  }

  public void hold(Target target) throws IOException {
    synchronized (LOCK) {
      Target current = load();
      if (current != null && !current.equals(target)) throw new IOException("Another update already holds the agent");
      if (current == null) save(target);
    }
  }

  public boolean release(Release release) throws IOException {
    synchronized (LOCK) {
      Target current = load();
      if (current == null) return false;
      boolean releases = switch (release) {
        case Successor s -> s.installed().equals(current);
        case EndedAttempt e -> e.target().equals(current);
      };
      if (releases) save(null);
      return releases;
    }
  }

  private Target load() throws IOException {
    Path path = directory.resolve("hold");
    BasicFileAttributes attributes;
    try { attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
    catch (NoSuchFileException absent) { return null; }
    if (!attributes.isRegularFile() || attributes.size() > 256) throw new IOException("Invalid update hold record");
    try (DataInputStream in = new DataInputStream(Files.newInputStream(path))) {
      if (in.readInt() != MAGIC) throw new IOException("Invalid update hold record");
      Target target = in.readBoolean() ? new Target(in.readLong(), in.readUTF()) : null;
      if (in.read() != -1) throw new IOException("Invalid update hold record");
      return target;
    } catch (IllegalArgumentException invalid) {
      throw new IOException("Invalid update hold record", invalid);
    }
  }

  private void save(Target target) throws IOException {
    Path next = directory.resolve("hold.next");
    try (FileOutputStream stream = new FileOutputStream(next.toFile()); DataOutputStream out = new DataOutputStream(stream)) {
      out.writeInt(MAGIC);
      out.writeBoolean(target != null);
      if (target != null) { out.writeLong(target.versionCode()); out.writeUTF(target.digest()); }
      out.flush();
      stream.getFD().sync();
    }
    Files.move(next, directory.resolve("hold"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
  }
}
