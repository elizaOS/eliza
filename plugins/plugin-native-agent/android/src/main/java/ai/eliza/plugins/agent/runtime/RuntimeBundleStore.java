package ai.eliza.plugins.agent.runtime;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Extracts APK-authenticated assets into immutable release directories.
 * No credentials, databases or user data live here. No active tree is modified. */
public class RuntimeBundleStore {
  private static final int MAX_MANIFEST = 2 * 1024 * 1024;
  private static final long MAX_FILE = 512L * 1024 * 1024;
  private static final long MAX_TOTAL = 2L * 1024 * 1024 * 1024;
  public interface Source { InputStream open(String asset) throws IOException; }
  public interface Durability {
    void syncDirectory(Path directory) throws IOException;
    default long usableSpace(Path directory) throws IOException { return directory.toFile().getUsableSpace(); }
  }
  public interface Faults { void boundary(String name) throws IOException; }
  private static final Faults NONE = name -> {};
  private static final LinkOption NOFOLLOW = LinkOption.NOFOLLOW_LINKS;

  private static final class Entry {
    final String kind, hash, source, destination;
    final long size;
    Entry(String[] fields) throws IOException {
      if (fields.length != 5 || !fields[1].matches("0|[1-9][0-9]{0,9}") || !fields[2].matches("[a-f0-9]{64}")) throw new IOException("Invalid runtime inventory entry");
      kind = fields[0]; size = Long.parseLong(fields[1]); hash = fields[2]; source = fields[3]; destination = fields[4];
      if (size > MAX_FILE) throw new IOException("Runtime file too large");
      if ("asset".equals(kind)) {
        safePath(source); safePath(destination);
        if (!(source.startsWith("agent/") || source.matches("runtime-blobs/[a-f0-9]{64}\\.bin"))) throw new IOException("Invalid runtime asset path");
        if (!(destination.startsWith("bundle/") || destination.matches("[A-Za-z0-9_.+-]+\\.tar\\.gz"))) throw new IOException("Invalid runtime destination");
      } else if ("native".equals(kind)) {
        if (!source.matches("lib[A-Za-z0-9_.-]+\\.so") || !"-".equals(destination)) throw new IOException("Invalid native inventory entry");
      } else throw new IOException("Unknown runtime inventory kind");
    }
  }

  /** Bound inventory loading before allocation, then use the existing verification path. */
  public static Path prepareFromAsset(Path root, String inventory, Source source, Path nativeLibraries,
      Durability durability, String format) throws IOException {
    return prepare(root, RuntimeAssets.read(source, inventory, MAX_MANIFEST), source, nativeLibraries, durability, format);
  }

  public static Path prepare(Path root, byte[] manifest, Source source, Path nativeLibraries, Durability durability, String format) throws IOException {
    return prepare(root, manifest, source, nativeLibraries, durability, NONE, format);
  }

  // Fault injection shares the real extraction/verification path with Android.
  public static Path prepare(Path root, byte[] manifest, Source source, Path nativeLibraries, Durability durability, Faults faults, String format) throws IOException {
    List<Entry> entries = parse(manifest, format);
    String identity = digest(manifest);
    Path requested = root.toAbsolutePath().normalize();
    // Resolve parent aliases before creating or restricting the root. Its leaf
    // remains un-followed and is validated under the same physical-root monitor.
    Path parent = requested.getParent();
    Path real = parent == null ? requested : parent.toRealPath().resolve(requested.getFileName());
    synchronized (ROOT_LOCKS.computeIfAbsent(real, key -> new Object())) {
      privateDirectory(real);
      return prepareLocked(real, entries, identity, source, nativeLibraries, durability, faults);
    }
  }

  private static final java.util.concurrent.ConcurrentMap<Path, Object> ROOT_LOCKS =
    new java.util.concurrent.ConcurrentHashMap<>();

  private static Path prepareLocked(Path root, List<Entry> entries, String identity, Source source, Path nativeLibraries, Durability durability, Faults faults) throws IOException {
    Path lockPath = root.resolve(".lock");
    try (FileChannel channel = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE, NOFOLLOW);
         FileLock lock = channel.lock()) {
      if (!lock.isValid()) throw new IOException("Runtime extraction lock unavailable");
      for (Entry entry : entries) if ("native".equals(entry.kind)) verify(nativeLibraries.resolve(entry.source), entry);
      Path release = root.resolve(identity);
      if (Files.exists(release, NOFOLLOW)) {
        verifyTree(release, entries, identity);
        return release.resolve("bundle");
      }
      // A process killed mid-extraction leaves only these private, unreferenced trees.
      try (DirectoryStream<Path> children = Files.newDirectoryStream(root, ".staging-*")) {
        for (Path child : children) if (child.getFileName().toString().matches("\\.staging-[a-f0-9-]{36}")) removeTree(child);
      }
      long bytes = 0;
      for (Entry entry : entries) if ("asset".equals(entry.kind)) bytes = Math.addExact(bytes, entry.size);
      if (durability.usableSpace(root) < bytes + 64L * 1024 * 1024) throw new IOException("Insufficient space for a complete runtime");
      Path staging = root.resolve(".staging-" + UUID.randomUUID());
      privateDirectory(staging);
      faults.boundary("staging-created");
      for (Entry entry : entries) if ("asset".equals(entry.kind)) {
        Path target = staging.resolve(entry.destination);
        privateParents(staging, target.getParent());
        try (InputStream in = source.open(entry.source);
             FileOutputStream out = new FileOutputStream(target.toFile())) {
          restrict(target);
          MessageDigest hash = sha256();
          byte[] buffer = new byte[65536]; long copied = 0; int count;
          while ((count = in.read(buffer)) != -1) {
            if (count == 0) continue;
            copied += count;
            if (copied > entry.size) throw new IOException("Runtime asset exceeded inventory length");
            out.write(buffer, 0, count); hash.update(buffer, 0, count);
            faults.boundary("file-chunk");
          }
          if (copied != entry.size || !entry.hash.equals(hex(hash.digest()))) throw new IOException("Runtime asset integrity mismatch");
          out.getFD().sync();
        }
        durability.syncDirectory(target.getParent());
        faults.boundary("file-synced");
      }
      // All descendants and directory entries must be durable before publishing.
      syncTree(staging, durability);
      faults.boundary("before-marker");
      Path marker = staging.resolve(".complete");
      try (FileOutputStream out = new FileOutputStream(marker.toFile())) {
        restrict(marker); out.write(identity.getBytes(StandardCharsets.US_ASCII)); out.getFD().sync();
      }
      durability.syncDirectory(staging);
      verifyTree(staging, entries, identity);
      faults.boundary("before-publish");
      Files.move(staging, release, StandardCopyOption.ATOMIC_MOVE);
      durability.syncDirectory(root);
      faults.boundary("published");
      return release.resolve("bundle");
    }
  }

  private static List<Entry> parse(byte[] bytes, String format) throws IOException {
    if (bytes.length == 0 || bytes.length > MAX_MANIFEST) throw new IOException("Invalid runtime inventory size");
    for (byte b : bytes) if (b < 0 || (b < 32 && b != '\n' && b != '\t')) throw new IOException("Invalid runtime inventory encoding");
    String text = new String(bytes, StandardCharsets.US_ASCII);
    String[] lines = text.split("\n", -1);
    if (!format.equals(lines[0]) || !lines[lines.length - 1].isEmpty() || lines.length < 3 || lines.length > 16386) throw new IOException("Invalid runtime inventory format");
    List<Entry> entries = new ArrayList<>(); Set<String> destinations = new HashSet<>(), libraries = new HashSet<>(); long total = 0;
    for (int i = 1; i < lines.length - 1; i++) {
      Entry entry = new Entry(lines[i].split("\t", -1));
      if (!("asset".equals(entry.kind) ? destinations.add(entry.destination) : libraries.add(entry.source))) throw new IOException("Duplicate runtime inventory entry");
      total += entry.size; if (total > MAX_TOTAL) throw new IOException("Runtime inventory exceeds limit");
      entries.add(entry);
    }
    for (String required : new String[]{"bundle/agent-bundle.js", "bundle/gateway/bootstrap.mjs", "bundle/gateway/local-agent-gateway.mjs"}) if (!destinations.contains(required)) throw new IOException("Incomplete runtime inventory");
    for (String required : new String[]{"libeliza_bun.so", "libeliza_ld_musl_aarch64.so"}) if (!libraries.contains(required)) throw new IOException("Incomplete native inventory");
    return entries;
  }

  private static void safePath(String value) throws IOException {
    if (value.length() > 1024 || !value.matches("[A-Za-z0-9_@.+/-]+")) throw new IOException("Unsafe runtime path");
    for (String part : value.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Unsafe runtime path");
  }
  private static void privateDirectory(Path directory) throws IOException {
    if (!Files.exists(directory, NOFOLLOW)) {
      // Another process can create the root before opening its file lock.
      // Re-check the actual leaf after a creation collision.
      try {
        Files.createDirectory(directory);
      } catch (FileAlreadyExistsException created) {
        // error-policy:J4 another creator won the race; the leaf is re-validated below.
      }
    }
    if (!Files.isDirectory(directory, NOFOLLOW)) throw new IOException("Runtime directory is not a real directory");
    restrict(directory);
  }
  private static void restrict(Path file) throws IOException {
    File f = file.toFile();
    if (!f.setReadable(false, false) || !f.setWritable(false, false) || !f.setExecutable(false, false)
        || !f.setReadable(true, true) || !f.setWritable(true, true)
        || (Files.isDirectory(file, NOFOLLOW) && !f.setExecutable(true, true))) throw new IOException("Cannot secure runtime files");
  }
  private static void privateParents(Path root, Path directory) throws IOException {
    Path current = root;
    for (Path part : root.relativize(directory)) { current = current.resolve(part); privateDirectory(current); }
  }
  private static void verifyTree(Path directory, List<Entry> entries, String identity) throws IOException {
    if (!Files.isDirectory(directory, NOFOLLOW)) throw new IOException("Invalid runtime release directory");
    Path marker = directory.resolve(".complete");
    if (!Files.isRegularFile(marker, NOFOLLOW) || Files.size(marker) != 64 || !identity.equals(new String(Files.readAllBytes(marker), StandardCharsets.US_ASCII))) throw new IOException("Runtime is incomplete");
    Set<String> expected = new HashSet<>(); expected.add(".complete");
    for (Entry entry : entries) if ("asset".equals(entry.kind)) {
      Path file = directory.resolve(entry.destination);
      Path parent = file.getParent();
      while (!parent.equals(directory)) { if (!Files.isDirectory(parent, NOFOLLOW)) throw new IOException("Invalid runtime parent"); parent = parent.getParent(); }
      verify(file, entry); expected.add(entry.destination);
    }
    verifyNames(directory, directory, expected);
  }
  private static void verifyNames(Path root, Path directory, Set<String> expected) throws IOException {
    try (DirectoryStream<Path> files = Files.newDirectoryStream(directory)) {
      for (Path file : files) {
        if (Files.isDirectory(file, NOFOLLOW)) verifyNames(root, file, expected);
        else if (!Files.isRegularFile(file, NOFOLLOW) || !expected.remove(root.relativize(file).toString().replace(File.separatorChar, '/'))) throw new IOException("Unexpected runtime file");
      }
    }
    if (root.equals(directory) && !expected.isEmpty()) throw new IOException("Missing runtime file");
  }
  private static void verify(Path file, Entry entry) throws IOException {
    if (!Files.isRegularFile(file, NOFOLLOW) || Files.size(file) != entry.size) throw new IOException("Runtime file length mismatch");
    MessageDigest hash = sha256();
    try (InputStream input = Files.newInputStream(file, NOFOLLOW)) {
      byte[] buffer = new byte[65536]; int count; long total = 0;
      while ((count = input.read(buffer)) != -1) { total += count; if (total > entry.size) throw new IOException("Runtime file grew during verification"); hash.update(buffer, 0, count); }
      if (total != entry.size || !entry.hash.equals(hex(hash.digest()))) throw new IOException("Runtime file integrity mismatch");
    }
  }
  private static void syncTree(Path directory, Durability durability) throws IOException {
    try (DirectoryStream<Path> children = Files.newDirectoryStream(directory)) {
      for (Path child : children) if (Files.isDirectory(child, NOFOLLOW)) syncTree(child, durability);
    }
    durability.syncDirectory(directory);
  }
  private static void removeTree(Path directory) throws IOException {
    if (Files.isDirectory(directory, NOFOLLOW)) {
      try (DirectoryStream<Path> children = Files.newDirectoryStream(directory)) { for (Path child : children) removeTree(child); }
    }
    Files.delete(directory);
  }
  private static MessageDigest sha256() { try { return MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IllegalStateException(e); } }
  private static String digest(byte[] bytes) { return hex(sha256().digest(bytes)); }
  private static String hex(byte[] bytes) { StringBuilder value = new StringBuilder(); for (byte b : bytes) value.append(String.format(Locale.ROOT, "%02x", b & 255)); return value.toString(); }
}
