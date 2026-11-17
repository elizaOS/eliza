package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class RuntimeBundleStore {
  public static final String INVENTORY = "agent/inventory.json";
  public static final String BUNDLE = "agent.mjs";
  public static final String NODE = "libeliza_node.so";
  @FunctionalInterface public interface Source { InputStream open(String name) throws IOException; }
  @FunctionalInterface public interface Durability { void sync(Path directory) throws IOException; }
  private record Entry(String path, String sha256, long size, boolean nativeFile) {}

  public static Path prepare(Path releases, long version, Source source, Path libraries, Durability durability) throws IOException {
    if (version < 1) throw new IOException("Invalid package version");
    List<Entry> entries = entries(source);
    Files.createDirectories(releases);
    Path release = releases.resolve(Long.toString(version));
    if (Files.exists(release, LinkOption.NOFOLLOW_LINKS)) {
      verify(release, entries, libraries);
      return release;
    }
    Path scratch = Files.createTempDirectory(releases, ".agent-extraction-");
    try {
      for (Entry entry : entries) {
        if (entry.nativeFile()) continue;
        Path file = scratch.resolve(entry.path());
        Files.createDirectories(file.getParent());
        try (InputStream input = source.open("agent/" + entry.path())) {
          if (Files.copy(input, file) != entry.size()) throw new IOException("Runtime asset size differs from inventory");
        }
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE)) { channel.force(true); }
      }
      verify(scratch, entries, libraries);
      durability.sync(scratch);
      Files.move(scratch, release, StandardCopyOption.ATOMIC_MOVE);
      durability.sync(releases);
      return release;
    } finally { delete(scratch); }
  }

  private static List<Entry> entries(Source source) throws IOException {
    String json = new String(RuntimeAssets.read(source, INVENTORY, 2 * 1024 * 1024), StandardCharsets.UTF_8);
    List<Entry> result = new ArrayList<>();
    Set<String> names = new HashSet<>();
    int nativeFiles = 0;
    try {
      JSONObject inventory = new JSONObject(json);
      if (inventory.getInt("schema") != 1) throw new IOException("Unknown runtime inventory schema");
      JSONArray files = inventory.getJSONArray("files");
      if (files.length() < 2 || files.length() > 16384) throw new IOException("Invalid runtime inventory size");
      for (int index = 0; index < files.length(); index++) {
        JSONObject row = files.getJSONObject(index);
        String fullName = row.getString("path"), digest = row.getString("sha256");
        long size = row.getLong("size");
        if (!names.add(fullName) || !digest.matches("[a-f0-9]{64}") || size < 1 || size > 512L * 1024 * 1024)
          throw new IOException("Invalid runtime inventory row");
        if (fullName.matches("lib/(arm64-v8a|x86_64)/libeliza_node\\.so")) {
          result.add(new Entry(NODE, digest, size, true));
          nativeFiles++;
        } else if (fullName.startsWith("assets/agent/")) {
          String name = fullName.substring("assets/agent/".length());
          if (!name.matches("[A-Za-z0-9_+.-]+(?:/[A-Za-z0-9_+.-]+)*")
            || List.of(name.split("/")).stream().anyMatch((part) -> part.equals(".") || part.equals("..")))
            throw new IOException("Unsafe runtime asset path");
          result.add(new Entry(name, digest, size, false));
        } else throw new IOException("Unexpected runtime inventory entry");
      }
    } catch (JSONException invalid) { throw new IOException("Malformed runtime inventory", invalid); }
    if (nativeFiles != 1 || !names.contains("assets/agent/" + BUNDLE))
      throw new IOException("Runtime inventory is incomplete");
    return result;
  }

  private static void verify(Path bundle, List<Entry> entries, Path libraries) throws IOException {
    if (!Files.isDirectory(bundle, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Runtime assets are unavailable");
    Path realBundle = bundle.toRealPath(), realLibraries = libraries.toRealPath();
    Set<Path> assets = new HashSet<>();
    for (Entry entry : entries) {
      Path root = entry.nativeFile() ? realLibraries : realBundle;
      Path file = root.resolve(entry.path());
      if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || !file.toRealPath().startsWith(root)
        || Files.size(file) != entry.size() || !digest(file).equals(entry.sha256()))
        throw new IOException("A runtime file differs from the APK inventory");
      if (!entry.nativeFile()) assets.add(file);
    }
    try (var observed = Files.walk(realBundle)) {
      if (!observed.filter((file) -> !Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)).allMatch(assets::remove)
        || !assets.isEmpty()) throw new IOException("Extra file in extracted runtime");
    }
  }

  private static String digest(Path file) throws IOException {
    final MessageDigest digest;
    try { digest = MessageDigest.getInstance("SHA-256"); }
    catch (NoSuchAlgorithmException impossible) { throw new IOException("SHA-256 unavailable", impossible); }
    try (InputStream input = Files.newInputStream(file)) {
      byte[] bytes = new byte[32768];
      for (int count; (count = input.read(bytes)) != -1;) digest.update(bytes, 0, count);
    }
    StringBuilder hex = new StringBuilder(64);
    for (byte value : digest.digest()) hex.append(Character.forDigit((value & 255) >> 4, 16)).append(Character.forDigit(value & 15, 16));
    return hex.toString();
  }

  private static void delete(Path root) throws IOException {
    if (!Files.exists(root)) return;
    try (var paths = Files.walk(root)) {
      for (Path path : paths.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) Files.delete(path);
    }
  }
}
