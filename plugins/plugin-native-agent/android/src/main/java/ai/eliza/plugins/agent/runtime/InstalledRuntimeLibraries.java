package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;

/** Links into the current APK install directory, refreshed before each launch.
 * Hosts supply trusted installed libraries and a real private alias directory,
 * serialize refreshes and verify library contents through their bundle policy.
 * Aliases are reconstructible launch state, not a durable publication journal.
 */
public final class InstalledRuntimeLibraries {
  private InstalledRuntimeLibraries() {}
  public enum LinkResult { MISSING, UNCHANGED, REPLACED }

  public static LinkResult link(Path alias, Path packaged) throws IOException {
    Path target = packaged.toAbsolutePath();
    if (alias.toAbsolutePath().normalize().equals(target.normalize()))
      throw new IOException("Runtime alias must differ from the installed library");
    if (!Files.isRegularFile(target) || Files.size(target) == 0) return LinkResult.MISSING;
    if (Files.isSymbolicLink(alias) && Files.readSymbolicLink(alias).equals(target)) return LinkResult.UNCHANGED;
    replaceable(alias);
    Path temporary = alias.resolveSibling(".runtime-link-" + UUID.randomUUID());
    Files.createSymbolicLink(temporary, target);
    try {
      replaceable(alias);
      Files.move(temporary, alias, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      return LinkResult.REPLACED;
    } finally { Files.deleteIfExists(temporary); }
  }

  /** Select one supported loader from the verified, ABI-specific APK library directory. */
  public static Path loader(Path installed) throws IOException {
    Path selected = null;
    for (String name : new String[]{"libeliza_ld_musl_aarch64.so", "libeliza_ld_musl_x86_64.so"}) {
      Path candidate = installed.resolve(name);
      if (!Files.isRegularFile(candidate)) continue;
      if (selected != null || Files.size(candidate) == 0)
        throw new IOException("Installed runtime must have one supported loader");
      selected = candidate;
    }
    if (selected == null) throw new IOException("Installed embedded runtime loader is unavailable");
    return selected;
  }

  /** Select the loader for an independently expected Android ABI and check that the
   * loader, bun and its libraries are 64-bit little-endian ELF files for that machine.
   * The seccomp wrapper's real loader and syscall shim are checked when present. */
  public static Path requireAbi(Path installed, String abi) throws IOException {
    String name; int machine;
    if ("arm64-v8a".equals(abi)) { name = "libeliza_ld_musl_aarch64.so"; machine = 183; }
    else if ("x86_64".equals(abi)) { name = "libeliza_ld_musl_x86_64.so"; machine = 62; }
    else throw new IOException("Unsupported runtime ABI");
    Path selected = loader(installed);
    if (!selected.getFileName().toString().equals(name))
      throw new IOException("Installed runtime loader differs from expected ABI");
    for (String library : new String[]{name, "libeliza_bun.so", "libeliza_stdcpp.so", "libeliza_gcc_s.so"})
      requireElf(installed.resolve(library), machine);
    for (String library : new String[]{name.replace(".so", "_real.so"), "libsigsys-handler.so"})
      if (Files.exists(installed.resolve(library), LinkOption.NOFOLLOW_LINKS)) requireElf(installed.resolve(library), machine);
    return selected;
  }

  private static void requireElf(Path library, int machine) throws IOException {
    byte[] header = new byte[20];
    int read = 0;
    try (InputStream input = Files.newInputStream(library)) {
      for (int count; read < header.length && (count = input.read(header, read, header.length - read)) >= 0; ) read += count;
    }
    if (read != header.length || header[0] != 0x7f || header[1] != 'E' || header[2] != 'L' || header[3] != 'F'
        || header[4] != 2 || header[5] != 1 || ((header[18] & 255) | (header[19] & 255) << 8) != machine)
      throw new IOException("Installed runtime library differs from expected ABI: " + library.getFileName());
  }

  /** Standard sonames used by the bundled Linux runtime. */
  public static void prepare(Path installed, Path aliases) throws IOException {
    for (String[] pair : new String[][]{{"libstdc++.so.6", "libeliza_stdcpp.so"}, {"libgcc_s.so.1", "libeliza_gcc_s.so"}})
      if (link(aliases.resolve(pair[0]), installed.resolve(pair[1])) == LinkResult.MISSING)
        throw new IOException("Packaged runtime library is unavailable");
  }

  /** The canvas loader uses process.dlopen on the installed .so, not a copied .node. */
  public static void configureCanvas(Path installed, Path aliases, Map<String,String> environment) throws IOException {
    for (String name : new String[]{"skia.linux-arm64-musl.node", "skia.linux-x64-musl.node"}) {
      Path legacy = aliases.resolve(name);
      replaceable(legacy);
      Files.deleteIfExists(legacy);
    }
    environment.remove("NAPI_RS_NATIVE_LIBRARY_PATH");
    Path canvas = installed.resolve("libeliza_canvas.so").toAbsolutePath();
    if (Files.isRegularFile(canvas)) environment.put("NAPI_RS_NATIVE_LIBRARY_PATH", canvas.toString());
  }

  private static void replaceable(Path target) throws IOException {
    if (Files.exists(target, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(target)
        && !Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS))
      throw new IOException("Runtime library alias must be a file or link");
  }
}
