// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/health.md, "Absence needs two refused connects in a row and the dead journaled child of this launch"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.OptionalLong;

public final class ChildJournal {
  public interface Processes {
    OptionalLong startTime(int pid) throws IOException;
    void kill(int pid) throws IOException;
  }

  public record Entry(long epoch, int pid, long startTime) {}
  record LaunchState(long epoch, long staleEpoch) {}

  private static final class DirectorySyncFailed extends IOException {
    DirectorySyncFailed(IOException cause) { super(cause.getMessage(), cause); }
  }

  public sealed interface Child permits NotJournaled, Journaled {}
  public record NotJournaled() implements Child {}
  public record Journaled(long childEpoch, boolean alive) implements Child {}

  public enum Reaped { NONE, GONE, KILLED }

  private static final long REAP_WAIT_MS = 5000, POLL_MS = 20, MAX_EPOCH = 999_999_999_999_999_999L;
  private final Path file;
  private final Path epochFile;
  private final Processes processes;
  private final AgentDirectories.Sync sync;
  private long unconfirmedEpoch;

  public ChildJournal(Path file, Processes processes, AgentDirectories.Sync sync) {
    this.file = file.toAbsolutePath();
    this.epochFile = this.file.resolveSibling(this.file.getFileName() + ".epoch");
    this.processes = processes;
    this.sync = sync;
  }

  public synchronized long lastEpoch() throws IOException { return restoreLaunch().epoch(); }

  synchronized boolean hasRecordedChild() throws IOException { return read().pid() != 0; }

  synchronized void syncForUpdate() throws IOException {
    Entry child = read();
    if (child.pid() != 0) throw new IOException("The previous agent must be reaped before taking an update hold");
    long epoch = lastEpoch(child);
    if (epoch > child.epoch()) write(new Entry(epoch, 0, -1));
    else sync.directory(file.getParent());
  }

  synchronized LaunchState restoreLaunch() throws IOException {
    Entry child = read();
    long epoch = lastEpoch(child);
    sync.directory(file.getParent());
    return new LaunchState(epoch, child.pid() == 0 ? 0 : child.epoch());
  }

  synchronized void reserveLaunch(long epoch) throws IOException {
    Entry child = read();
    long last = lastEpoch(child);
    if (epoch < 1 || epoch > MAX_EPOCH || (epoch != last + 1 && (epoch != last || epoch != unconfirmedEpoch)))
      throw new IOException("Cannot reserve launch epoch " + epoch + " after " + last);
    if (epoch == last) {
      if (child.pid() != 0 && child.epoch() == epoch) throw new IOException("The launch epoch already owns a child");
      sync.directory(file.getParent());
    } else {
      try { write(epochFile, epoch + "\n"); }
      catch (DirectorySyncFailed failed) {
        unconfirmedEpoch = epoch;
        throw failed;
      }
    }
    unconfirmedEpoch = 0;
  }

  public synchronized void record(int pid, long epoch) throws IOException {
    if (pid < 1) throw new IllegalArgumentException("A child pid is positive");
    Entry child = read();
    if (epoch < 1 || epoch > MAX_EPOCH || epoch < lastEpoch(child) || child.pid() != 0)
      throw new IOException("The journal cannot record a child for epoch " + epoch);
    write(new Entry(epoch, pid, processes.startTime(pid).orElse(-1)));
  }

  public synchronized void clear(long epoch) throws IOException {
    Entry entry = read();
    if (entry.epoch() != epoch) throw new IOException("The journal holds epoch " + entry.epoch() + ", not " + epoch);
    write(new Entry(entry.epoch(), 0, -1));
  }

  public synchronized Child observe() throws IOException {
    Entry entry = read();
    return entry.pid() == 0 ? new NotJournaled() : new Journaled(entry.epoch(), alive(entry));
  }

  public synchronized Reaped reapStale(long currentEpoch) throws IOException {
    Entry entry = read();
    if (entry.pid() == 0) return Reaped.NONE;
    if (entry.epoch() >= currentEpoch)
      throw new IOException("The journaled child of epoch " + entry.epoch() + " is not earlier than epoch " + currentEpoch);
    Reaped reaped = Reaped.GONE;
    if (alive(entry)) {
      processes.kill(entry.pid());
      reaped = Reaped.KILLED;
      long deadline = System.nanoTime() + REAP_WAIT_MS * 1_000_000L;
      while (alive(entry)) {
        if (System.nanoTime() >= deadline)
          throw new IOException("The stale agent child " + entry.pid() + " of epoch " + entry.epoch() + " did not end");
        try { Thread.sleep(POLL_MS); }
        catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new IOException("Interrupted while ending the stale agent child", interrupted);
        }
      }
    }
    write(new Entry(entry.epoch(), 0, -1));
    return reaped;
  }

  private boolean alive(Entry entry) throws IOException {
    if (entry.startTime() < 0) return false;
    OptionalLong now = processes.startTime(entry.pid());
    return now.isPresent() && now.getAsLong() == entry.startTime();
  }

  private Entry read() throws IOException {
    if (Files.notExists(file, LinkOption.NOFOLLOW_LINKS)) return new Entry(0, 0, -1);
    if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 128) throw new IOException(file + " is not a child journal");
    String[] fields = new String(Files.readAllBytes(file), StandardCharsets.US_ASCII).trim().split(" ");
    if (fields.length != 3 || !fields[0].matches("[0-9]{1,18}") || !fields[1].matches("[0-9]{1,9}") || !fields[2].matches("-1|[0-9]{1,18}"))
      throw new IOException(file + " is not a child journal");
    return new Entry(Long.parseLong(fields[0]), Integer.parseInt(fields[1]), Long.parseLong(fields[2]));
  }

  private long lastEpoch(Entry child) throws IOException {
    if (Files.notExists(epochFile, LinkOption.NOFOLLOW_LINKS)) return child.epoch();
    if (!Files.isRegularFile(epochFile, LinkOption.NOFOLLOW_LINKS) || Files.size(epochFile) > 20)
      throw new IOException(epochFile + " is not a launch epoch record");
    String text = new String(Files.readAllBytes(epochFile), StandardCharsets.US_ASCII).trim();
    if (!text.matches("[0-9]{1,18}")) throw new IOException(epochFile + " is not a launch epoch record");
    return Math.max(child.epoch(), Long.parseLong(text));
  }

  private void write(Entry entry) throws IOException {
    write(file, entry.epoch() + " " + entry.pid() + " " + entry.startTime() + "\n");
  }

  private void write(Path target, String record) throws IOException {
    Path parent = target.getParent();
    Path temporary = Files.createTempFile(parent, ".child-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    try {
      try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        var bytes = java.nio.ByteBuffer.wrap(record.getBytes(StandardCharsets.US_ASCII));
        while (bytes.hasRemaining()) channel.write(bytes);
        channel.force(true);
      }
      Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      try { sync.directory(parent); }
      catch (IOException failed) { throw new DirectorySyncFailed(failed); }
    } finally {
      Files.deleteIfExists(temporary);
    }
  }
}
