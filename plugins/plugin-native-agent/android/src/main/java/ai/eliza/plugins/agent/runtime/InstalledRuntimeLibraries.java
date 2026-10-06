package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
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

  /** Standard sonames used by the bundled ARM64 Linux runtime. */
  public static void prepare(Path installed, Path aliases) throws IOException {
    for (String[] pair : new String[][]{{"libstdc++.so.6", "libeliza_stdcpp.so"}, {"libgcc_s.so.1", "libeliza_gcc_s.so"}})
      if (link(aliases.resolve(pair[0]), installed.resolve(pair[1])) == LinkResult.MISSING)
        throw new IOException("Packaged runtime library is unavailable");
  }

  /** The canvas loader uses process.dlopen on the installed .so, not a copied .node. */
  public static void configureCanvas(Path installed, Path aliases, Map<String,String> environment) throws IOException {
    Path legacy = aliases.resolve("skia.linux-arm64-musl.node");
    replaceable(legacy);
    Files.deleteIfExists(legacy);
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
