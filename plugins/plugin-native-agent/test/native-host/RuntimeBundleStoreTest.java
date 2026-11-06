package ai.eliza.plugins.agent.runtime.test;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.util.*;

/** Executes the production storage implementation, including real JVM death. */
public final class RuntimeBundleStoreTest {
  private static int assertions;
  private static void check(boolean value, String message) { assertions++; if (!value) throw new AssertionError(message); }
  private interface Throwing { void run() throws Exception; }
  private static void rejects(Throwing operation) throws Exception {
    try { operation.run(); throw new AssertionError("Expected rejection"); }
    catch (IOException expected) { assertions++; }
  }
  private static String hash(byte[] bytes) throws Exception {
    StringBuilder out = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format("%02x", b & 255));
    return out.toString();
  }
  private static final RuntimeBundleStore.Durability SYNC = path -> {
    try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ)) { channel.force(true); }
  };
  private static Map<String, byte[]> assets(String version, boolean removedFile) {
    Map<String, byte[]> result = new TreeMap<>();
    for (String name : new String[]{"agent-bundle.js", "gateway/bootstrap.mjs", "gateway/local-agent-gateway.mjs"}) result.put(name, (version + name).getBytes(StandardCharsets.UTF_8));
    if (removedFile) result.put("obsolete-plugin.js", "old plugin".getBytes(StandardCharsets.UTF_8));
    return result;
  }
  private static void libraries(Path root) throws Exception {
    Files.createDirectories(root.resolve("native"));
    for (String name : new String[]{"libeliza_bun.so", "libeliza_ld_musl_aarch64.so"}) Files.write(root.resolve("native").resolve(name), name.getBytes(StandardCharsets.UTF_8));
  }
  private static byte[] manifest(Map<String, byte[]> assets) throws Exception {
    StringBuilder out = new StringBuilder("eliza-runtime-v1\n");
    for (Map.Entry<String, byte[]> entry : assets.entrySet()) out.append("asset\t").append(entry.getValue().length).append('\t').append(hash(entry.getValue())).append("\tagent/").append(entry.getKey()).append("\tbundle/").append(entry.getKey()).append('\n');
    for (String name : new String[]{"libeliza_bun.so", "libeliza_ld_musl_aarch64.so"}) {
      byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
      out.append("native\t").append(bytes.length).append('\t').append(hash(bytes)).append('\t').append(name).append("\t-\n");
    }
    return out.toString().getBytes(StandardCharsets.UTF_8);
  }
  private static RuntimeBundleStore.Source source(Map<String, byte[]> assets) {
    return name -> {
      byte[] value = assets.get(name.substring("agent/".length()));
      if (value == null) throw new FileNotFoundException(name);
      return new ByteArrayInputStream(value);
    };
  }
  private static Path prepare(Path root, Map<String, byte[]> assets) throws Exception {
    byte[] inventory = manifest(assets);
    return ai.eliza.plugins.agent.runtime.RuntimeBundleStore.prepareFromAsset(root.resolve("versions"), "inventory",
      name -> "inventory".equals(name) ? new ByteArrayInputStream(inventory) : source(assets).open(name),
      root.resolve("native"), SYNC, "eliza-runtime-v1");
  }
  private static List<String> launch(Path root, Map<String, byte[]> assets, long now) throws Exception {
    List<String> seen = new ArrayList<>();
    RuntimeBundleStore.prepare(root.resolve("versions"), manifest(assets), source(assets), root.resolve("native"), new RuntimeBundleStore.Durability() {
      public void syncDirectory(Path path) throws IOException { SYNC.syncDirectory(path); }
      public long now() { return now; }
    }, seen::add);
    return seen;
  }
  private static boolean hashed(List<String> seen) { return seen.contains("release-verified") && !seen.contains("release-sealed"); }
  /** A launch skips hashing only while every file keeps the metadata sealed after its last full hash. */
  private static void sealedRelease(Path suite, Map<String, byte[]> next) throws Exception {
    Path root = Files.createDirectory(suite.resolve("sealed")); libraries(root);
    long day = 24L * 60 * 60 * 1000, t = 1_000_000_000L;
    check(launch(root, next, t).contains("published"), "First launch extracts and hashes");
    Path release = root.resolve("versions").resolve(hash(manifest(next))), bundle = release.resolve("bundle");
    check(Files.isRegularFile(release.resolve(".verified")), "Verified extraction writes a seal");
    check(launch(root, next, t + 1).equals(List.of("release-sealed")), "Unchanged release skips the hash");

    Files.setLastModifiedTime(bundle.resolve("agent-bundle.js"), FileTime.fromMillis(t));
    check(hashed(launch(root, next, t + 2)), "Changed mtime forces a full hash");
    check(launch(root, next, t + 3).equals(List.of("release-sealed")), "A passing full hash renews the seal");

    Files.delete(release.resolve(".verified"));
    check(hashed(launch(root, next, t + 4)), "Missing seal forces a full hash");
    Files.writeString(release.resolve(".verified"), "eliza-runtime-seal-v1\nforged\n");
    check(hashed(launch(root, next, t + 5)), "Unreadable seal forces a full hash");
    check(hashed(launch(root, next, t + 5 + day + 1)), "An old seal forces a full hash");
    check(hashed(launch(root, next, t)), "A seal from the future forces a full hash");

    // Same size and restored mtime still change ctime, so tampering is hashed and refused.
    Path file = bundle.resolve("gateway/bootstrap.mjs");
    FileTime mtime = Files.getLastModifiedTime(file);
    byte[] original = Files.readAllBytes(file), forged = original.clone(); forged[0] ^= 1;
    Thread.sleep(5); Files.write(file, forged); Files.setLastModifiedTime(file, mtime);
    rejects(() -> launch(root, next, t + 6));
    Files.write(file, original);
    check(hashed(launch(root, next, t + 7)), "Restored release hashes before it is sealed again");
    Files.writeString(file, "longer tampered content");
    rejects(() -> launch(root, next, t + 8));
    Files.write(file, original); launch(root, next, t + 9);

    Path library = root.resolve("native/libeliza_bun.so");
    byte[] libraryBytes = Files.readAllBytes(library), wrong = libraryBytes.clone(); wrong[0] ^= 1;
    Thread.sleep(5); Files.write(library, wrong);
    rejects(() -> launch(root, next, t + 10));
    Files.write(library, libraryBytes);
    check(hashed(launch(root, next, t + 11)), "Replaced native library forces a full hash");
  }
  public static void main(String[] args) throws Exception {
    if (args.length == 3 && args[0].equals("crash")) {
      Path root = Path.of(args[1]); Map<String, byte[]> next = assets("new", false);
      RuntimeBundleStore.prepare(root.resolve("versions"), manifest(next), source(next), root.resolve("native"), SYNC,
        name -> { if (name.equals(args[2])) Runtime.getRuntime().halt(23); });
      throw new AssertionError("Crash boundary not reached");
    }
    Path suite = Path.of(args[0]); Files.createDirectories(suite);
    Path normal = Files.createDirectory(suite.resolve("normal")); libraries(normal);
    Map<String, byte[]> old = assets("old", true), next = assets("new", false);
    Path oldBundle = prepare(normal, old), newBundle = prepare(normal, next);
    Path low = Files.createDirectory(suite.resolve("low-space")); libraries(low); Path retained = prepare(low, old);
    rejects(() -> RuntimeBundleStore.prepare(low.resolve("versions"), manifest(next), source(next), low.resolve("native"), new RuntimeBundleStore.Durability() {
      public void syncDirectory(Path path) throws IOException { SYNC.syncDirectory(path); }
      public long usableSpace(Path path) { return 0; }
    }));
    check(Files.readString(retained.resolve("agent-bundle.js")).startsWith("old"), "Low space must preserve current bundle");
    check(!oldBundle.equals(newBundle), "Different payloads require different directories");
    check(Files.exists(oldBundle.resolve("obsolete-plugin.js")), "Old complete version must remain intact");
    check(!Files.exists(newBundle.resolve("obsolete-plugin.js")), "Deleted plugin must not leak into new version");
    check(prepare(normal, next).equals(newBundle), "Verified restart must reuse exact complete bundle");
    Files.writeString(newBundle.resolve("extra.js"), "unlisted");
    rejects(() -> prepare(normal, next)); Files.delete(newBundle.resolve("extra.js"));
    Files.writeString(newBundle.resolve("agent-bundle.js"), "tampered"); rejects(() -> prepare(normal, next));
    check(Files.readString(oldBundle.resolve("agent-bundle.js")).startsWith("old"), "Corruption must not alter old release");

    sealedRelease(suite, next);

    for (String boundary : new String[]{"staging-created", "file-chunk", "file-synced", "before-marker", "before-publish", "published"}) {
      Path root = Files.createDirectory(suite.resolve(boundary)); libraries(root); Path prior = prepare(root, old);
      Process child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin/java").toString(), "-cp", System.getProperty("java.class.path"), RuntimeBundleStoreTest.class.getName(), "crash", root.toString(), boundary).inheritIO().start();
      check(child.waitFor() == 23, "Child must die at " + boundary);
      check(Files.readString(prior.resolve("agent-bundle.js")).startsWith("old"), "Previous bundle survives " + boundary);
      Path recovered = prepare(root, next);
      check(Files.readString(recovered.resolve("agent-bundle.js")).startsWith("new"), "Restart recovers " + boundary);
      check(!Files.exists(recovered.resolve("obsolete-plugin.js")), "Recovery excludes stale plugin");
    }

    Path hostile = Files.createDirectory(suite.resolve("hostile")); libraries(hostile);
    byte[] correct = manifest(next);
    for (String text : new String[]{new String(correct, StandardCharsets.UTF_8).replace("bundle/agent-bundle.js", "bundle/../escaped.js"),
      new String(correct, StandardCharsets.UTF_8).replace("bundle/agent-bundle.js", "/escaped.js"),
      new String(correct, StandardCharsets.UTF_8).replace("eliza-runtime-v1", "unknown"),
      new String(correct, StandardCharsets.UTF_8).replace("asset\t", "asset\t-"),
      new String(correct, StandardCharsets.UTF_8) + new String(correct, StandardCharsets.UTF_8).split("\n")[1] + "\n"}) {
      rejects(() -> RuntimeBundleStore.prepare(hostile.resolve("versions"), text.getBytes(StandardCharsets.UTF_8), source(next), hostile.resolve("native"), SYNC));
    }
    String mixedName = "libeliza_ld_musl_x86_64.so";
    byte[] mixedBytes = mixedName.getBytes(StandardCharsets.UTF_8);
    Files.write(hostile.resolve("native").resolve(mixedName), mixedBytes);
    String mixedInventory = new String(correct, StandardCharsets.UTF_8) + "native\t" + mixedBytes.length + "\t" + hash(mixedBytes) + "\t" + mixedName + "\t-\n";
    rejects(() -> RuntimeBundleStore.prepare(hostile.resolve("versions"), mixedInventory.getBytes(StandardCharsets.UTF_8), source(next), hostile.resolve("native"), SYNC));
    Files.delete(hostile.resolve("native").resolve(mixedName));
    Map<String, byte[]> missing = new TreeMap<>(next); missing.remove("gateway/bootstrap.mjs");
    rejects(() -> RuntimeBundleStore.prepare(hostile.resolve("versions"), correct, source(missing), hostile.resolve("native"), SYNC));
    Map<String, byte[]> bad = new TreeMap<>(next); bad.put("agent-bundle.js", "wrong bytes".getBytes(StandardCharsets.UTF_8));
    rejects(() -> RuntimeBundleStore.prepare(hostile.resolve("versions"), correct, source(bad), hostile.resolve("native"), SYNC));
    Path bundle = prepare(hostile, next);
    Files.delete(bundle.resolve("gateway/bootstrap.mjs"));
    Path outside = suite.resolve("outside"); Files.writeString(outside, "untouched");
    Files.createSymbolicLink(bundle.resolve("gateway/bootstrap.mjs"), outside);
    rejects(() -> prepare(hostile, next));
    check(Files.readString(outside).equals("untouched"), "Verification must not follow links");
    Path links = Files.createDirectory(suite.resolve("links")); libraries(links);
    Files.createSymbolicLink(links.resolve("versions"), hostile.resolve("versions"));
    rejects(() -> prepare(links, next));
    Path coldLeaf = Files.createDirectory(suite.resolve("cold-leaf-link")); libraries(coldLeaf);
    Path missingRoot = suite.resolve("uncreated-runtime-root");
    Files.createSymbolicLink(coldLeaf.resolve("versions"), missingRoot);
    rejects(() -> prepare(coldLeaf, next));
    check(Files.isSymbolicLink(coldLeaf.resolve("versions")) && !Files.exists(missingRoot, LinkOption.NOFOLLOW_LINKS), "Cold preparation must not follow or replace a dangling root leaf");
    Path natives = Files.createDirectory(suite.resolve("natives")); libraries(natives);
    Files.writeString(natives.resolve("native/libeliza_bun.so"), "wrong native binary");
    rejects(() -> prepare(natives, next));
    check(!Files.exists(natives.resolve("versions").resolve(hash(correct))), "Native mismatch must not publish");

    // One process, two threads, one root: the JVM-wide FileChannel lock must
    // make the second preparer wait, not fail with OverlappingFileLockException.
    for (boolean aliased : new boolean[]{false, true}) {
      Path shared = Files.createDirectory(suite.resolve(aliased ? "threads-aliased" : "threads")); libraries(shared);
      Path secondRoot = aliased ? Files.createSymbolicLink(suite.resolve("thread-link"), shared) : shared;
      java.util.concurrent.CountDownLatch inside = new java.util.concurrent.CountDownLatch(1), resume = new java.util.concurrent.CountDownLatch(1);
      java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
      try {
        java.util.concurrent.Future<Path> first = pool.submit(() -> RuntimeBundleStore.prepare(shared.resolve("versions"), manifest(next), source(next), shared.resolve("native"), SYNC, name -> {
          if (!name.equals("staging-created")) return;
          inside.countDown();
          try { resume.await(); } catch (InterruptedException interrupted) { throw new InterruptedIOException(); }
        }));
        check(inside.await(10, java.util.concurrent.TimeUnit.SECONDS), "First preparer must hold the root");
        java.util.concurrent.Future<Path> second = pool.submit(() -> prepare(secondRoot, next));
        Thread.sleep(200); // the second preparer reaches the lock while the first holds it
        resume.countDown();
        Path a = first.get(30, java.util.concurrent.TimeUnit.SECONDS), b = second.get(30, java.util.concurrent.TimeUnit.SECONDS);
        check(a.equals(b), "Concurrent preparers in one process must share one complete bundle");
        check(Files.readString(b.resolve("agent-bundle.js")).startsWith("new"), "Shared bundle must be complete");
      } finally { resume.countDown(); pool.shutdownNow(); }
    }

    // Cold roots reached through canonical and parent-alias paths must share
    // one preparation owner before any directory or permission mutation.
    for (int round = 0; round < 40; round++) {
      Path cold = Files.createDirectory(suite.resolve("cold-" + round)); libraries(cold);
      Path alias = Files.createSymbolicLink(suite.resolve("cold-link-" + round), cold);
      java.util.concurrent.CyclicBarrier start = new java.util.concurrent.CyclicBarrier(4);
      java.util.concurrent.ExecutorService racers = java.util.concurrent.Executors.newFixedThreadPool(4);
      try {
        List<java.util.concurrent.Future<Path>> results = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
          Path requested = i % 2 == 0 ? cold : alias;
          results.add(racers.submit(() -> {
            start.await();
            return prepare(requested, next);
          }));
        }
        Path expected = results.get(0).get();
        for (java.util.concurrent.Future<Path> result : results)
          check(result.get().equals(expected), "Cold-start preparers must share one physical bundle");
      } finally { racers.shutdownNow(); }
    }
    System.out.println("RuntimeBundleStore: " + assertions + " assertions passed, including 6 real process-death boundaries");
  }
}
