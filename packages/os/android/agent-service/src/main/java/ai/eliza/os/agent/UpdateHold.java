// spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"
package ai.eliza.os.agent;

import android.content.Context;
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
  private static final long POLL_MS = 100;
  private static final Object LOCK = new Object();
  private final Path directory;

  public UpdateHold(Path directory) throws IOException {
    this.directory = directory.toAbsolutePath().normalize();
    Files.createDirectories(this.directory);
    if (!Files.isDirectory(this.directory, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Invalid update hold storage");
  }

  static UpdateHold of(Context context) throws IOException {
    return new UpdateHold(context.getNoBackupFilesDir().toPath().resolve("agent-update-hold"));
  }

  public static boolean holdForUpdate(Context context, long versionCode, String digest) throws IOException {
    return AgentService.holdForUpdate(context, new AgentPolicy.UpdateTarget(versionCode, digest));
  }

  public static boolean awaitHeld(Context context, long versionCode, String digest, long timeoutMs) throws IOException, InterruptedException {
    AgentPolicy.UpdateTarget target = new AgentPolicy.UpdateTarget(versionCode, digest);
    long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
    UpdateHold hold = of(context);
    while (!target.equals(hold.held())) {
      if (System.nanoTime() >= deadline) return false;
      Thread.sleep(POLL_MS);
    }
    return true;
  }

  public static boolean releaseUpdate(Context context, long installedCode, String installedDigest, boolean attemptEnded) throws IOException {
    return AgentService.releaseUpdate(context, installedCode, installedDigest, attemptEnded);
  }

  public AgentPolicy.UpdateTarget held() throws IOException {
    synchronized (LOCK) { return load(); }
  }

  void save(AgentPolicy.UpdateTarget target) throws IOException {
    if (target != null && (target.code() < 1 || target.digest() == null || !target.digest().matches("[a-f0-9]{64}")))
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
