// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/health.md, "Absence needs two refused connects in a row and the dead journaled child of this launch"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.OptionalLong;

public final class ChildJournal {
  public interface Processes {
    OptionalLong startTime(int pid) throws IOException;
    void kill(int pid) throws IOException;
  }

  public static final Processes ANDROID = new Processes() {
    @Override public OptionalLong startTime(int pid) throws IOException {
      String stat;
      try { stat = new String(Files.readAllBytes(Paths.get("/proc", Integer.toString(pid), "stat")), StandardCharsets.US_ASCII); }
      catch (NoSuchFileException gone) { return OptionalLong.empty(); }
      int end = stat.lastIndexOf(')');
      String[] fields = end < 0 ? new String[0] : stat.substring(end + 2).trim().split(" ");
      if (fields.length < 20 || !fields[19].matches("[0-9]+")) throw new IOException("Unreadable /proc/" + pid + "/stat");
      return fields[0].equals("Z") || fields[0].equals("X") ? OptionalLong.empty() : OptionalLong.of(Long.parseLong(fields[19]));
    }

    @Override public void kill(int pid) throws IOException {
      try { android.system.Os.kill(pid, android.system.OsConstants.SIGKILL); }
      catch (android.system.ErrnoException error) {
        if (error.errno != android.system.OsConstants.ESRCH) throw new IOException("Cannot end agent child " + pid, error);
      }
    }
  };

  public record Entry(long epoch, int pid, long startTime) {}

  public sealed interface Child permits NotJournaled, Journaled {}
  public record NotJournaled() implements Child {}
  public record Journaled(long childEpoch, boolean alive) implements Child {}

  public enum Reaped { NONE, GONE, KILLED }

  private static final long REAP_WAIT_MS = 5000, POLL_MS = 20;
  private final Path file;
  private final Processes processes;
  private final AgentDirectories.Sync sync;

  public ChildJournal(Path file, Processes processes, AgentDirectories.Sync sync) {
    this.file = file;
    this.processes = processes;
    this.sync = sync;
  }

  public synchronized long lastEpoch() throws IOException { return read().epoch(); }

  public synchronized void record(int pid, long epoch) throws IOException {
    if (pid < 1) throw new IllegalArgumentException("A child pid is positive");
    long last = read().epoch();
    if (epoch < last) throw new IOException("Epoch " + epoch + " is earlier than the journaled epoch " + last);
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

  private void write(Entry entry) throws IOException {
    Path parent = file.toAbsolutePath().getParent();
    Path temporary = Files.createTempFile(parent, ".child-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
    try {
      try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        channel.write(java.nio.ByteBuffer.wrap((entry.epoch() + " " + entry.pid() + " " + entry.startTime() + "\n").getBytes(StandardCharsets.US_ASCII)));
        channel.force(true);
      }
      Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      sync.directory(parent);
    } finally {
      Files.deleteIfExists(temporary);
    }
  }
}
