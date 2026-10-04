package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;

/** Host supplies a real app-private parent directory and serializes replacements.
 * Files are published atomically with mode 0600; no account or filename policy.
 */
public final class RuntimePrivateFiles {
  private RuntimePrivateFiles() {}
  @FunctionalInterface public interface DirectorySync { void sync(Path directory) throws IOException; }

  public static void write(Path file, byte[] content, DirectorySync sync) throws IOException {
    Objects.requireNonNull(sync);
    byte[] snapshot = content.clone();
    Path target = file.toAbsolutePath(), parent = target.getParent();
    regularOrAbsent(target);
    Path temporary = Files.createTempFile(parent, ".runtime-private-", ".tmp",
      PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    try {
      try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
        ByteBuffer bytes = ByteBuffer.wrap(snapshot);
        while (bytes.hasRemaining()) channel.write(bytes);
        channel.force(true);
      }
      regularOrAbsent(target);
      Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      // An exception here means publication occurred but directory durability is unknown.
      sync.sync(parent);
    } finally { Files.deleteIfExists(temporary); }
  }

  /** Optional single-line UTF-8 input; bounds apply to stored bytes before trim. */
  public static String readOptionalSingleLine(Path file, int minimumBytes, int maximumBytes) throws IOException {
    if (minimumBytes < 1 || maximumBytes < minimumBytes || maximumBytes == Integer.MAX_VALUE)
      throw new IllegalArgumentException("Invalid private input bounds");
    if (Files.notExists(file, LinkOption.NOFOLLOW_LINKS)) return null;
    regularOrAbsent(file);
    byte[] content = new byte[maximumBytes + 1];
    int total = 0;
    try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
      ByteBuffer buffer = ByteBuffer.wrap(content);
      while (buffer.hasRemaining() && channel.read(buffer) != -1) {}
      total = buffer.position();
    }
    if (total < minimumBytes || total > maximumBytes) throw new IOException("Invalid private input length");
    String value = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(content, 0, total)).toString().trim();
    if (value.isEmpty() || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
      throw new IOException("Invalid private single-line input");
    return value;
  }

  private static void regularOrAbsent(Path file) throws IOException {
    if (Files.exists(file, LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
      throw new IOException("Private file target must be regular");
  }
}
