import ai.eliza.plugins.securestore.nativeonly.PasswordCustodySelection;
import java.nio.file.*;
import java.util.concurrent.*;

/** Actual filesystem journal, restart, interruption and concurrent writer tests. No credentials. */
public final class PasswordSelectionTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("selection " + checks); }
  private interface Failing { void run() throws Exception; }
  private static void rejects(Failing operation) throws Exception {
    checks++;
    try { operation.run(); } catch (PasswordCustodySelection.RecoveryRequired expected) { return; }
    throw new AssertionError("Selection should refuse");
  }
  private static PasswordCustodySelection owner(Path dir, Path target, boolean enabled, String identity) throws Exception {
    return new PasswordCustodySelection(dir.toFile(), identity.getBytes(java.nio.charset.StandardCharsets.UTF_8), enabled, () -> Files.exists(target));
  }
  public static void main(String[] args) throws Exception {
    System.out.println("ready"); System.out.flush();
    System.out.println(owner(Path.of(args[0]), Path.of(args[1]), true, "concurrent").use(v -> v).name());
  }
  public static int run() throws Exception {
    Path root = Files.createTempDirectory("password-selection-");
    ExecutorService workers = Executors.newFixedThreadPool(2);
    try {
      Path dir = root.resolve("journal"), target = root.resolve("target"), source = root.resolve("source");
      Files.writeString(source, "synthetic-original");
      PasswordCustodySelection legacy = owner(dir, target, false, "pair");
      check(legacy.use(v -> v) == PasswordCustodySelection.Version.LEGACY);
      rejects(() -> legacy.migrate(() -> { throw new AssertionError("must not run"); }));
      PasswordCustodySelection first = owner(dir, target, true, "pair");
      try {
        first.migrate(() -> { Files.copy(source, target); throw new java.io.IOException("simulated process interruption after copy"); });
        throw new AssertionError("must interrupt");
      } catch (java.io.IOException expected) { checks++; }
      PasswordCustodySelection restarted = owner(dir, target, true, "pair");
      rejects(() -> restarted.use(v -> { throw new AssertionError("pending must not expose vault"); }));
      rejects(() -> legacy.use(v -> v));
      check(Files.readString(source).equals("synthetic-original"));
      Files.writeString(target, "conflicting-target");
      try {
        restarted.migrate(() -> { if (Files.mismatch(source, target) != -1) throw new java.io.IOException("conflicting snapshot"); });
        throw new AssertionError("must preserve conflicting target");
      } catch (java.io.IOException expected) { checks++; }
      rejects(() -> restarted.use(v -> v));
      check(Files.readString(target).equals("conflicting-target"));
      check(Files.readString(source).equals("synthetic-original"));
      Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING); // Synthetic native repair, not owner behavior.
      restarted.migrate(() -> { check(Files.mismatch(source, target) == -1); });
      check(owner(dir, target, true, "pair").use(v -> v) == PasswordCustodySelection.Version.DEVICE_UNLOCKED);
      restarted.migrate(() -> { throw new AssertionError("completed migration must not copy twice"); });
      rejects(() -> legacy.use(v -> v));
      rejects(() -> owner(dir, target, true, "other-pair").use(v -> v));
      Path journal = dir.resolve("custody-selection.v1");
      byte[] valid = Files.readAllBytes(journal);
      Files.writeString(journal, "corrupt");
      rejects(() -> restarted.use(v -> v));
      Files.delete(journal);
      rejects(() -> restarted.use(v -> v));
      Files.write(journal, valid);
      check(restarted.use(v -> v) == PasswordCustodySelection.Version.DEVICE_UNLOCKED);

      Path concurrentDir = root.resolve("concurrent");
      Path concurrentTarget = root.resolve("concurrent-target");
      PasswordCustodySelection a = owner(concurrentDir, concurrentTarget, true, "concurrent");
      PasswordCustodySelection b = owner(concurrentDir, concurrentTarget, true, "concurrent");
      CountDownLatch copying = new CountDownLatch(1), finish = new CountDownLatch(1), writerStarted = new CountDownLatch(1);
      Future<?> migration = workers.submit(() -> { try { a.migrate(() -> {
        copying.countDown(); if (!finish.await(5, TimeUnit.SECONDS)) throw new AssertionError("test timeout");
        Files.writeString(concurrentTarget, "verified");
      }); } catch (Exception e) { throw new RuntimeException(e); } });
      check(copying.await(5, TimeUnit.SECONDS));
      Future<PasswordCustodySelection.Version> writer = workers.submit(() -> {
        writerStarted.countDown(); return b.use(v -> { Files.writeString(concurrentTarget, "writer-after-migration"); return v; });
      });
      check(writerStarted.await(5, TimeUnit.SECONDS));
      try { writer.get(100, TimeUnit.MILLISECONDS); throw new AssertionError("write overlapped copy"); }
      catch (TimeoutException expected) { checks++; }
      Process contender = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
          "-cp", System.getProperty("java.class.path"), "PasswordSelectionTest", concurrentDir.toString(), concurrentTarget.toString())
          .redirectErrorStream(true).start();
      try (java.io.BufferedReader output = contender.inputReader()) {
        check("ready".equals(output.readLine()));
        check(!contender.waitFor(100, TimeUnit.MILLISECONDS));
        finish.countDown(); migration.get(5, TimeUnit.SECONDS);
        check(contender.waitFor(5, TimeUnit.SECONDS));
        check(contender.exitValue() == 0 && "DEVICE_UNLOCKED".equals(output.readLine()));
      } finally { contender.destroyForcibly(); }
      check(writer.get(5, TimeUnit.SECONDS) == PasswordCustodySelection.Version.DEVICE_UNLOCKED);
      check(Files.readString(concurrentTarget).equals("writer-after-migration"));
      java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong(10);
      ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession grant =
          new ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession(clock::get, 100);
      long ticket = grant.begin(); check(grant.complete(ticket, true));
      CountDownLatch holding = new CountDownLatch(1), release = new CountDownLatch(1), resetStarted = new CountDownLatch(1);
      Future<?> holdingLock = workers.submit(() -> { try { a.use(v -> {
        holding.countDown(); if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("test timeout");
        return null;
      }); } catch (Exception failure) { throw new RuntimeException(failure); } });
      check(holding.await(5, TimeUnit.SECONDS));
      Future<Boolean> reset = workers.submit(() -> {
        if (!grant.authenticated(ticket)) throw new AssertionError("grant must begin live");
        resetStarted.countDown();
        return b.use(v -> {
          if (!grant.authenticated(ticket)) return false;
          Files.delete(concurrentTarget); return true;
        });
      });
      check(resetStarted.await(5, TimeUnit.SECONDS));
      clock.set(111); release.countDown(); holdingLock.get(5, TimeUnit.SECONDS);
      check(!reset.get(5, TimeUnit.SECONDS)); check(Files.exists(concurrentTarget));
      return checks;
    } finally {
      workers.shutdownNow();
      try (java.util.stream.Stream<Path> files = Files.walk(root)) {
        for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toArray(Path[]::new)) Files.deleteIfExists(file);
      }
    }
  }
}
