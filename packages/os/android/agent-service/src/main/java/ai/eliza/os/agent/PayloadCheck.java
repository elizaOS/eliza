// spec/os/build/runtimePayload.md, "Extracted assets are extracted again when the package version changes"; spec/os/build/runtimePayload.md, "The agent spawns only when every inventory digest matches on the device"; spec/os/build/runtimePayload.md, "A damaged extracted file is extracted again once before the start fails"; spec/os/build/runtimePayload.md, "The workflow worker is staged only under the digest the bundle manifest pins"
package ai.eliza.os.agent;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public final class PayloadCheck {
  public static final String INVENTORY = "agent/inventory.json";
  public static final String NODE = "libeliza_node.so";
  public static final String WORKER = "workflow-worker";
  static final List<String> BUNDLE_FILES = Collections.unmodifiableList(Arrays.asList("agent.mjs", "manifest.json"));
  private static final int INVENTORY_LIMIT = 2 * 1024 * 1024, MANIFEST_LIMIT = 1024 * 1024, ROW_LIMIT = 16384;
  private static final long FILE_LIMIT = 512L * 1024 * 1024;
  private static final Pattern DIGEST = Pattern.compile("[a-f0-9]{64}");
  private static final Pattern SEGMENT = Pattern.compile("[A-Za-z0-9_+@.-]+");
  private static final Pattern LIBRARY = Pattern.compile("lib/(arm64-v8a|x86_64)/(lib[A-Za-z0-9_+-][A-Za-z0-9_+.-]*\\.so)");

  @FunctionalInterface public interface Assets { InputStream open(String asset) throws IOException; }

  public record WorkflowWorker(Path runtimeDir, Path executable, String sha256) {}
  public record PreparedPayload(Path bundleDir, Path node, Optional<WorkflowWorker> workflowWorker, Map<String, Path> extraAssets) {}

  public sealed interface Check permits Ready, Failed {}
  public record Ready(PreparedPayload payload) implements Check {}
  public record Failed(List<String> errors) implements Check {
    public Failed { errors = Collections.unmodifiableList(new ArrayList<>(errors)); }
  }

  private enum Tree { NATIVE, BUNDLE, WORKER, EXTRA }
  private record Row(String path, String sha256, long size, Tree tree, String abi, String location) {}

  private PayloadCheck() {}

  public static Check prepare(Assets assets, long versionCode, List<String> deviceAbis, Path nativeLibraryDir,
      Path runtimeDir, AgentDirectories.Sync sync) throws IOException {
    if (versionCode < 1) return failed("The package version code " + versionCode + " is not positive");
    byte[] inventory;
    try { inventory = read(assets.open(INVENTORY), INVENTORY_LIMIT, "assets/" + INVENTORY); }
    catch (IOException unreadable) { return failed("Cannot read assets/" + INVENTORY + " from the APK: " + unreadable.getMessage()); }
    List<String> errors = new ArrayList<>();
    List<Row> rows = rows(inventory, errors);
    if (!errors.isEmpty()) return new Failed(errors);
    String abi = null;
    for (String candidate : deviceAbis)
      if (abi == null && rows.stream().anyMatch((row) -> row.tree() == Tree.NATIVE && row.abi().equals(candidate) && row.location().equals(NODE)))
        abi = candidate;
    if (abi == null) return failed("The inventory has no " + NODE + " for the device ABIs " + deviceAbis);
    for (String name : BUNDLE_FILES)
      if (rows.stream().noneMatch((row) -> row.path().equals("assets/agent/" + name))) errors.add("The inventory does not list assets/agent/" + name);
    if (!errors.isEmpty()) return new Failed(errors);
    String deviceAbi = abi;
    List<Row> device = rows.stream().filter((row) -> row.tree() != Tree.NATIVE || row.abi().equals(deviceAbi)).collect(Collectors.toList());

    Path releases = runtimeDir.resolve("releases");
    Path release = releases.resolve(versionCode + "-" + AgentDirectories.hex(sha256().digest(inventory)));
    boolean extracted = Files.isDirectory(release, LinkOption.NOFOLLOW_LINKS);
    if (!extracted) extract(assets, device, releases, release, sync, errors);
    if (!errors.isEmpty()) return new Failed(errors);
    if (verify(device, nativeLibraryDir, release, errors) && extracted) {
      errors.clear();
      extract(assets, device, releases, release, sync, errors);
      if (!errors.isEmpty()) return new Failed(errors);
      verify(device, nativeLibraryDir, release, errors);
    }
    if (!errors.isEmpty()) return new Failed(errors);
    Optional<WorkflowWorker> worker = worker(release, device, errors);
    if (!errors.isEmpty()) return new Failed(errors);
    Map<String, Path> extraAssets = new LinkedHashMap<>();
    for (Row row : device) if (row.tree() == Tree.EXTRA) {
      String name = row.location().substring(0, row.location().indexOf('/'));
      extraAssets.put(name, release.toRealPath().resolve(name));
    }
    return new Ready(new PreparedPayload(release.toRealPath().resolve("agent"), nativeLibraryDir.toRealPath().resolve(NODE), worker,
      Collections.unmodifiableMap(extraAssets)));
  }

  private static List<Row> rows(byte[] inventory, List<String> errors) {
    Object parsed;
    try { parsed = RouteGate.Json.parse(new String(inventory, StandardCharsets.UTF_8)); }
    catch (IllegalArgumentException malformed) { errors.add("assets/" + INVENTORY + " is not JSON: " + malformed.getMessage()); return Collections.emptyList(); }
    if (!(parsed instanceof Map<?, ?> document) || !(document.get("schema") instanceof BigDecimal schema) || schema.compareTo(BigDecimal.ONE) != 0) {
      errors.add("assets/" + INVENTORY + " is not an inventory of schema 1");
      return Collections.emptyList();
    }
    if (!(document.get("files") instanceof List<?> files) || files.isEmpty() || files.size() > ROW_LIMIT) {
      errors.add("assets/" + INVENTORY + " must list between 1 and " + ROW_LIMIT + " files");
      return Collections.emptyList();
    }
    List<Row> rows = new ArrayList<>();
    Set<String> paths = new HashSet<>();
    for (int index = 0; index < files.size(); index++) {
      Row row = row(files.get(index));
      if (row == null) errors.add("Inventory row " + index + " is not {path, sha256, size} with a safe path, a SHA-256 and a size up to " + FILE_LIMIT);
      else if (!paths.add(row.path())) errors.add("Inventory row " + index + " lists " + row.path() + " twice");
      else rows.add(row);
    }
    return rows;
  }

  private static Row row(Object value) {
    if (!(value instanceof Map<?, ?> row) || !(row.get("path") instanceof String path)
      || !(row.get("sha256") instanceof String sha256) || !DIGEST.matcher(sha256).matches()
      || !(row.get("size") instanceof BigDecimal number)) return null;
    long size;
    try { size = number.longValueExact(); } catch (ArithmeticException fractional) { return null; }
    if (size < 0 || size > FILE_LIMIT) return null;
    Matcher library = LIBRARY.matcher(path);
    if (library.matches()) return new Row(path, sha256, size, Tree.NATIVE, library.group(1), library.group(2));
    if (!path.startsWith("assets/")) return null;
    String location = path.substring("assets/".length());
    String[] segments = location.split("/", -1);
    if (segments.length < 2) return null;
    for (String segment : segments)
      if (!SEGMENT.matcher(segment).matches() || segment.equals(".") || segment.equals("..")) return null;
    if (!segments[0].equals("agent")) return new Row(path, sha256, size, Tree.EXTRA, "", location);
    if (location.equals(INVENTORY)) return null;
    Tree tree = segments.length > 2 && segments[1].equals(WORKER) ? Tree.WORKER : Tree.BUNDLE;
    return new Row(path, sha256, size, tree, "", location);
  }

  private static void extract(Assets assets, List<Row> device, Path releases, Path release, AgentDirectories.Sync sync,
      List<String> errors) throws IOException {
    if (Files.notExists(releases, LinkOption.NOFOLLOW_LINKS)) {
      Files.createDirectory(releases);
      sync.directory(releases.getParent());
    }
    if (!Files.isDirectory(releases, LinkOption.NOFOLLOW_LINKS)) throw new IOException(releases + " is not a real directory");
    try (Stream<Path> stale = Files.list(releases)) {
      for (Path entry : stale.collect(Collectors.toList())) delete(entry);
    }
    Path scratch = Files.createTempDirectory(releases, ".extracting-");
    try {
      for (Row row : device) {
        if (row.tree() == Tree.NATIVE) continue;
        Path file = scratch.resolve(row.location());
        Files.createDirectories(file.getParent());
        InputStream source;
        try { source = assets.open(row.location()); }
        catch (FileNotFoundException | NoSuchFileException missing) { errors.add("Missing " + row.path() + " in the APK"); continue; }
        long copied = copy(source, file, row.size());
        if (copied != row.size()) errors.add("Size of " + row.path() + " in the APK differs: expected " + row.size() + ", found " + (copied > row.size() ? "more" : String.valueOf(copied)));
      }
      if (!errors.isEmpty()) return;
      syncTree(scratch, sync);
      Files.move(scratch, release, StandardCopyOption.ATOMIC_MOVE);
      sync.directory(releases);
    } finally {
      delete(scratch);
    }
  }

  private static long copy(InputStream source, Path file, long expected) throws IOException {
    long total = 0;
    try (InputStream input = source;
         OutputStream output = Files.newOutputStream(file, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
      byte[] buffer = new byte[65536];
      for (int count; (count = input.read(buffer)) != -1;) {
        total += count;
        if (total > expected) return total;
        output.write(buffer, 0, count);
      }
    }
    try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(file, StandardOpenOption.WRITE)) { channel.force(true); }
    return total;
  }

  private static void syncTree(Path root, AgentDirectories.Sync sync) throws IOException {
    try (Stream<Path> tree = Files.walk(root)) {
      for (Path directory : tree.filter((path) -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
          .sorted(Comparator.reverseOrder()).collect(Collectors.toList())) sync.directory(directory);
    }
  }

  private static boolean verify(List<Row> device, Path nativeLibraryDir, Path release, List<String> errors) throws IOException {
    Path libraries, extracted;
    try { libraries = nativeLibraryDir.toRealPath(); }
    catch (IOException missing) { errors.add("The native library directory " + nativeLibraryDir + " is missing"); return false; }
    try { extracted = release.toRealPath(); }
    catch (IOException missing) { errors.add("The extracted payload " + release + " is missing"); return true; }
    Set<Path> listed = new HashSet<>();
    boolean extractionDamaged = false;
    for (Row row : device) {
      Path root = row.tree() == Tree.NATIVE ? libraries : extracted;
      Path file = root.resolve(row.location());
      if (row.tree() != Tree.NATIVE) listed.add(file);
      String error = mismatch(row, root, file);
      if (error == null) continue;
      errors.add(error);
      extractionDamaged |= row.tree() != Tree.NATIVE;
    }
    try (Stream<Path> tree = Files.walk(extracted)) {
      for (Path path : tree.collect(Collectors.toList()))
        if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) && !listed.contains(path)) {
          errors.add("Unlisted file " + extracted.relativize(path) + " in the extracted payload");
          extractionDamaged = true;
        }
    }
    return extractionDamaged;
  }

  private static String mismatch(Row row, Path root, Path file) throws IOException {
    if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || !file.toRealPath().startsWith(root)) return "Missing " + row.path() + " at " + file;
    long size = Files.size(file);
    if (size != row.size()) return "Size of " + row.path() + " differs: expected " + row.size() + ", found " + size;
    String digest = digest(file);
    return digest.equals(row.sha256()) ? null : "Digest of " + row.path() + " differs: expected " + row.sha256() + ", found " + digest;
  }

  private static Optional<WorkflowWorker> worker(Path release, List<Row> device, List<String> errors) throws IOException {
    Path bundle = release.toRealPath().resolve("agent");
    Object manifest;
    try { manifest = RouteGate.Json.parse(new String(read(Files.newInputStream(bundle.resolve("manifest.json")), MANIFEST_LIMIT, "assets/agent/manifest.json"), StandardCharsets.UTF_8)); }
    catch (IOException | IllegalArgumentException unreadable) { errors.add("Cannot read assets/agent/manifest.json: " + unreadable.getMessage()); return Optional.empty(); }
    if (!(manifest instanceof Map<?, ?> fields)) { errors.add("assets/agent/manifest.json is not an object"); return Optional.empty(); }
    Object pin = fields.get("workflowWorkerSha256");
    List<Row> workers = device.stream().filter((row) -> row.tree() == Tree.WORKER).collect(Collectors.toList());
    if (pin == null) {
      if (!workers.isEmpty()) errors.add("The payload carries a workflow worker that the bundle manifest does not pin");
      return Optional.empty();
    }
    if (!(pin instanceof String pinned) || !DIGEST.matcher(pinned).matches()) {
      errors.add("The bundle manifest's workflowWorkerSha256 is not a SHA-256");
      return Optional.empty();
    }
    List<Row> executables = workers.stream().filter((row) -> row.sha256().equals(pinned)).collect(Collectors.toList());
    if (executables.size() != 1) {
      errors.add("The bundle manifest pins workflow worker " + pinned + " but the payload has " + executables.size() + " worker files with that digest");
      return Optional.empty();
    }
    return Optional.of(new WorkflowWorker(bundle.resolve(WORKER), release.toRealPath().resolve(executables.get(0).location()), pinned));
  }

  private static byte[] read(InputStream source, int limit, String name) throws IOException {
    try (InputStream input = source) {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] buffer = new byte[16384];
      for (int count; (count = input.read(buffer)) != -1;) {
        if (output.size() + count > limit) throw new IOException(name + " is larger than " + limit + " bytes");
        output.write(buffer, 0, count);
      }
      return output.toByteArray();
    }
  }

  private static String digest(Path file) throws IOException {
    MessageDigest digest = sha256();
    try (InputStream input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
      byte[] buffer = new byte[65536];
      for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
    }
    return AgentDirectories.hex(digest.digest());
  }

  private static MessageDigest sha256() throws IOException {
    try { return MessageDigest.getInstance("SHA-256"); }
    catch (NoSuchAlgorithmException impossible) { throw new IOException("SHA-256 unavailable", impossible); }
  }

  private static void delete(Path root) throws IOException {
    if (Files.notExists(root, LinkOption.NOFOLLOW_LINKS)) return;
    try (Stream<Path> tree = Files.walk(root)) {
      for (Path path : tree.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) Files.delete(path);
    }
  }

  private static Check failed(String error) { return new Failed(Collections.singletonList(error)); }
}
