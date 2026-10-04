package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.NativeProcessLog;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import java.util.concurrent.*;

public final class NativeProcessLogTest {
  private static int assertions;
  private static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }
  private static InputStream text(String value) { return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)); }
  private static String read(Path file) throws IOException { return Files.readString(file); }
  private static final class Generated extends InputStream {
    private long remaining;
    boolean closed;
    Generated(long size) { remaining = size; }
    public int read() { if (remaining == 0) return -1; remaining--; return 'X'; }
    public int read(byte[] bytes, int offset, int length) {
      if (remaining == 0) return -1;
      int count = (int)Math.min(remaining, length);
      Arrays.fill(bytes, offset, offset + count, (byte)'X'); remaining -= count; return count;
    }
    public void close() { closed = true; }
  }
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]); Files.createDirectories(root);
    if (args.length > 1) {
      Generated input = new Generated(32L * 1024 * 1024);
      new NativeProcessLog(root.resolve("huge.log"), 32768, 4096).drain(input, Arrays.asList("X".repeat(64)));
      check(input.closed);
      check(read(root.resolve("huge.log")).equals("[redacted] [truncated]\n"));
      return;
    }
    Path file = root.resolve("lines.log");
    NativeProcessLog log = new NativeProcessLog(file, 32768, 4096);
    log.drain(text("a\r\nb\rc\n\nlast"), Collections.emptyList());
    check(read(file).equals("a\nb\nc\n\nlast\n"));
    check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")));
    Path secrets = root.resolve("secrets.log");
    new NativeProcessLog(secrets, 32768, 4096).drain(text("abcdefgh abcdef abc\n"), Arrays.asList(null, "", "abc", "defgh", "abcdef"));
    check(read(secrets).equals("[redacted] [redacted] [redacted]\n"));
    // A complete secret beginning inside the visible prefix must be redacted
    // even when its suffix extends past the truncation boundary.
    String token = "TOKEN-" + "q".repeat(10000);
    Path boundary = root.resolve("boundary.log");
    new NativeProcessLog(boundary, 128, 32).drain(text("x".repeat(29) + token + " tail\n"), Arrays.asList(token));
    check(!read(boundary).contains("TOKEN"));
    check(read(boundary).endsWith(" [truncated]\n"));
    check(Files.size(boundary) <= 128);
    // A second copy cut at the retained edge is never matched; redacting the
    // first copy must not pull that unmatched prefix into the visible line.
    String repeated = "TOKEN-" + "q".repeat(94);
    Path twice = root.resolve("twice.log");
    new NativeProcessLog(twice, 128, 32).drain(text(repeated + repeated + "\n"), Arrays.asList(repeated));
    check(read(twice).equals("[redacted] [truncated]\n"));
    Path prefixed = root.resolve("prefixed.log");
    new NativeProcessLog(prefixed, 32768, 64).drain(text("id=" + repeated + "," + repeated + "," + repeated + "\n"), Arrays.asList(repeated));
    check(read(prefixed).equals("id=[redacted] [truncated]\n"));
    Path utf8 = root.resolve("utf8.log");
    NativeProcessLog small = new NativeProcessLog(utf8, 128, 32);
    small.drain(text("界".repeat(100) + "\n"), Collections.emptyList());
    check(Files.size(utf8) <= 128); check(read(utf8).endsWith(" [truncated]\n"));
    // Rotation happens before a complete new record crosses the byte limit.
    small.drain(text("n".repeat(31) + "\n"), Collections.emptyList());
    check(read(utf8).equals("n".repeat(31) + "\n"));
    Path race = root.resolve("writers.log");
    ExecutorService workers = Executors.newFixedThreadPool(4);
    List<Future<?>> results = new ArrayList<>();
    try {
      for (int writer = 0; writer < 4; writer++) {
        final int id = writer;
        results.add(workers.submit(() -> {
          NativeProcessLog sink = new NativeProcessLog(race, 65536, 64);
          for (int i = 0; i < 100; i++) sink.drain(text(id + ":" + i + "\n"), Collections.emptyList());
          return null;
        }));
      }
      for (Future<?> result : results) result.get(15, TimeUnit.SECONDS);
    } finally { workers.shutdownNow(); }
    List<String> lines = Files.readAllLines(race);
    check(lines.size() == 400); check(new HashSet<>(lines).size() == 400);
    for (String line : lines) check(line.matches("[0-3]:[0-9]{1,2}"));
    Path victim = root.resolve("victim"); Files.writeString(victim, "untouched");
    Path link = root.resolve("link"); Files.createSymbolicLink(link, victim);
    try { new NativeProcessLog(link, 128, 32).drain(text("data\n"), Collections.emptyList()); throw new AssertionError(); }
    catch (IOException expected) { assertions++; }
    check(read(victim).equals("untouched"));
    Generated invalid = new Generated(1);
    try { log.drain(invalid, Arrays.asList("line\nbreak")); throw new AssertionError(); }
    catch (IllegalArgumentException expected) { assertions++; }
    check(invalid.closed);
    try { new NativeProcessLog(file, 1, 32); throw new AssertionError(); }
    catch (IllegalArgumentException expected) { assertions++; }
    Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
      "-Xmx12m", "-cp", System.getProperty("java.class.path"), NativeProcessLogTest.class.getName(), root.toString(), "bounded")
      .inheritIO().start();
    check(child.waitFor(30, TimeUnit.SECONDS)); check(child.exitValue() == 0);
    System.out.println("NativeProcessLog: " + assertions + " assertions passed");
  }
}
