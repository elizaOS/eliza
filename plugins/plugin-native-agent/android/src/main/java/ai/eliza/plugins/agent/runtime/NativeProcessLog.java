package ai.eliza.plugins.agent.runtime;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;

/** Bounded diagnostics for native child streams, not a model-context or event store.
 * The host supplies an app-private, real parent directory and owns drain threads.
 * Writers using this class in one JVM serialize whole records, including rotation.
 * Memory per drain is bounded by the selected line limit plus the longest secret.
 */
public final class NativeProcessLog {
  private static final Object WRITERS = new Object();
  private static final String REDACTED = "[redacted]", TRUNCATED = " [truncated]";
  private final Path file;
  private final long maximumFileBytes;
  private final int maximumLineChars;

  public NativeProcessLog(Path file, long maximumFileBytes, int maximumLineChars) {
    this.file = Objects.requireNonNull(file);
    if (maximumLineChars < 1 || maximumFileBytes < 3L * maximumLineChars + TRUNCATED.length() + 1)
      throw new IllegalArgumentException("Log file limit must fit one encoded record");
    this.maximumFileBytes = maximumFileBytes;
    this.maximumLineChars = maximumLineChars;
  }

  /** Consumes and closes the stream. Secrets must be single-line literal values. */
  public void drain(InputStream input, Collection<String> values) throws IOException {
    try (Reader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
      Set<String> secrets = new LinkedHashSet<>();
      int longest = 1;
      for (String value : values) {
        if (value == null || value.isEmpty()) continue;
        if (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0)
          throw new IllegalArgumentException("Log secrets must be single-line values");
        secrets.add(value);
        longest = Math.max(longest, value.length());
      }
      final int retained = Math.addExact(maximumLineChars, longest - 1);
      StringBuilder line = new StringBuilder(Math.min(retained, 1024));
      char[] buffer = new char[1024];
      boolean discarded = false, afterCarriageReturn = false;
      int count;
      while ((count = reader.read(buffer)) != -1) {
        for (int i = 0; i < count; i++) {
          char character = buffer[i];
          if (character == '\n' && afterCarriageReturn) { afterCarriageReturn = false; continue; }
          afterCarriageReturn = character == '\r';
          if (character == '\r' || character == '\n') {
            append(line, discarded, secrets);
            line.setLength(0); discarded = false;
          } else if (line.length() < retained) line.append(character);
          else discarded = true;
        }
      }
      if (line.length() > 0 || discarded) append(line, discarded, secrets);
    }
  }

  private void append(StringBuilder source, boolean discarded, Set<String> secrets) throws IOException {
    String line = source.toString();
    int[] edges = new int[line.length() + 1];
    // Mark the union, so overlapping secrets cannot expose one another's suffixes.
    for (String secret : secrets) {
      int offset = 0;
      while ((offset = line.indexOf(secret, offset)) >= 0) {
        edges[offset]++; edges[offset + secret.length()]--;
        offset++;
      }
    }
    StringBuilder safe = new StringBuilder();
    int active = 0; boolean redacting = false;
    // Emit only the visible source prefix. Every secret covering a visible
    // index ends inside the retained window, so it was matched above; a later
    // copy cut at the window edge is never matched and must not surface just
    // because redaction shortened the line.
    int visible = Math.min(line.length(), maximumLineChars);
    if (line.length() > visible) discarded = true;
    for (int i = 0; i < visible; i++) {
      active += edges[i];
      if (active == 0) { safe.append(line.charAt(i)); redacting = false; }
      else if (!redacting) { safe.append(REDACTED); redacting = true; }
    }
    if (safe.length() > maximumLineChars) { safe.setLength(maximumLineChars); discarded = true; }
    if (discarded) safe.append(TRUNCATED);
    byte[] record = safe.append('\n').toString().getBytes(StandardCharsets.UTF_8);
    synchronized (WRITERS) {
      if (Files.exists(file, LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("Log target must be a regular file");
      try (FileChannel channel = FileChannel.open(file,
          new HashSet<>(Arrays.asList(StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)),
          PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
        long size = channel.size();
        if (size > maximumFileBytes - record.length) { channel.truncate(0); size = 0; }
        channel.position(size);
        ByteBuffer bytes = ByteBuffer.wrap(record);
        while (bytes.hasRemaining()) channel.write(bytes);
      }
    }
  }
}
