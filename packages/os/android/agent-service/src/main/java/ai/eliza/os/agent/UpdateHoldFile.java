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

final class UpdateHoldFile {
  private static final int MAGIC = 0x484f4c44;
  private static final Object LOCK = new Object();
  private final Path directory;

  UpdateHoldFile(Path directory) throws IOException {
    this.directory = directory.toAbsolutePath().normalize();
    Files.createDirectories(this.directory);
    if (!Files.isDirectory(this.directory, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid update hold storage");
  }

  AgentPolicy.UpdateTarget held() throws IOException {
    synchronized (LOCK) { return load(); }
  }

  AgentPolicy.Step acquire(AgentPolicy policy, ChildJournal journal, AgentPolicy.UpdateTarget target) throws IOException {
    if (!policy.state().child() && (journal == null || journal.hasRecordedChild()))
      throw new IOException("The previous agent must be reaped before taking an update hold");
    AgentPolicy.Step step = policy.step(new AgentPolicy.HoldForUpdate(target));
    if (step.accepted()) {
      try { save(target); }
      catch (IOException failed) {
        policy.step(new AgentPolicy.ReleaseUpdate(target.code(), target.digest(), true));
        throw failed;
      }
    }
    return step;
  }

  AgentPolicy.Step release(AgentPolicy policy, AgentPolicy.ReleaseUpdate event) throws IOException {
    AgentPolicy.Step step = policy.step(event);
    if (step.accepted()) save(null);
    return step;
  }

  void save(AgentPolicy.UpdateTarget target) throws IOException {
    if (target != null && !target.valid())
      throw new IllegalArgumentException("Invalid update target");
    synchronized (LOCK) { write(target); }
  }

  private AgentPolicy.UpdateTarget load() throws IOException {
    Path path = directory.resolve("hold");
    BasicFileAttributes attributes;
    try { attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); }
    catch (NoSuchFileException absent) { return null; }
    if (!attributes.isRegularFile() || attributes.size() > 256) throw new IOException("Invalid update hold record");
    try (DataInputStream in = new DataInputStream(Files.newInputStream(path))) {
      if (in.readInt() != MAGIC) throw new IOException("Invalid update hold record");
      AgentPolicy.UpdateTarget target = in.readBoolean() ? new AgentPolicy.UpdateTarget(in.readLong(), in.readUTF()) : null;
      if (in.read() != -1) throw new IOException("Invalid update hold record");
      return target;
    }
  }

  private void write(AgentPolicy.UpdateTarget target) throws IOException {
    Path next = directory.resolve("hold.next");
    try (FileOutputStream stream = new FileOutputStream(next.toFile()); DataOutputStream out = new DataOutputStream(stream)) {
      out.writeInt(MAGIC);
      out.writeBoolean(target != null);
      if (target != null) { out.writeLong(target.code()); out.writeUTF(target.digest()); }
      out.flush();
      stream.getFD().sync();
    }
    Files.move(next, directory.resolve("hold"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); }
  }
}
