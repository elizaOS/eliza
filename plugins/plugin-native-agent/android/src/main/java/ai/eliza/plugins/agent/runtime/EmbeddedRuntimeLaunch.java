package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.*;
import java.util.*;

/** Android embedded-runtime command and environment construction. No process is
 * started here: the existing supervisor owns execution, readiness and cleanup.
 * Paths must be trusted, private host directories and verified installed code.
 */
public final class EmbeddedRuntimeLaunch {
  private final Path bundle, installed, aliases, state;
  private final Map<String,String> base = new HashMap<>();
  private final String application, dataDirectory;

  public EmbeddedRuntimeLaunch(Path bundle, Path installed, Path aliases, Path state,
      String application, String dataDirectory) throws IOException {
    this.bundle = bundle.toAbsolutePath(); this.installed = installed.toAbsolutePath();
    this.aliases = aliases.toAbsolutePath(); this.state = state.toAbsolutePath();
    this.application = application; this.dataDirectory = dataDirectory;
    if (!Files.isRegularFile(this.installed.resolve("libeliza_bun.so"))
        || !Files.isRegularFile(this.installed.resolve("libeliza_ld_musl_aarch64.so")))
      throw new IOException("Installed embedded runtime is unavailable");
    privateDirectory(this.aliases);
    InstalledRuntimeLibraries.prepare(this.installed, this.aliases);
    Path temporary = this.state.resolve("tmp"); privateDirectory(temporary);
    base.put("PATH", "/system/bin"); base.put("HOME", this.state.toString());
    base.put("TMPDIR", temporary.toString());
    base.put("LD_LIBRARY_PATH", this.aliases + ":" + this.installed);
  }

  private static void privateDirectory(Path path) throws IOException {
    Files.createDirectories(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
    if (!Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Runtime directory must be real");
  }

  private ProcessBuilder command(Path entrypoint, String... arguments) {
    List<String> command = new ArrayList<>(Arrays.asList(
      installed.resolve("libeliza_ld_musl_aarch64.so").toString(),
      installed.resolve("libeliza_bun.so").toString(), "--no-env-file", "--no-install",
      entrypoint.toAbsolutePath().toString()));
    command.addAll(Arrays.asList(arguments));
    ProcessBuilder builder = new ProcessBuilder(command).directory(bundle.toFile());
    builder.environment().clear(); builder.environment().putAll(base);
    return builder;
  }

  /** Product provider/plugin settings cannot override the authenticated endpoint. */
  public ProcessBuilder agent(Path entrypoint, Path config, int port, String token,
      Map<String,String> policy) {
    if (port < 1 || port > 65535 || token == null || token.isEmpty() || token.matches("(?s).*[\\r\\n\\x00].*"))
      throw new IllegalArgumentException("Invalid runtime endpoint authority");
    ProcessBuilder builder = command(entrypoint, "serve");
    Map<String,String> env = builder.environment(); env.putAll(policy); env.putAll(base);
    env.put("ELIZA_STATE_DIR", state.toString()); env.put("ELIZA_CONFIG_PATH", config.toAbsolutePath().toString());
    env.put("ELIZA_ANDROID_APP_DATA_DIR", dataDirectory);
    env.put("ELIZA_PLATFORM", "android"); env.put("ELIZA_MOBILE_PLATFORM", "android");
    env.put("ELIZA_BROWSER_ANDROID_APPLICATION", application);
    env.put("ELIZA_API_BIND", "127.0.0.1"); env.put("ELIZA_API_PORT", String.valueOf(port));
    env.put("ELIZA_API_STRICT_PORT", "true"); env.put("ELIZA_REQUIRE_LOCAL_AUTH", "1"); env.put("ELIZA_API_TOKEN", token);
    return builder;
  }

  /** Gateway credentials are supplied separately; agent environment is never copied. */
  public ProcessBuilder gateway(Path entrypoint) throws IOException {
    ProcessBuilder builder = command(entrypoint);
    InstalledRuntimeLibraries.configureCanvas(installed, aliases, builder.environment());
    return builder;
  }

  public static String token() {
    byte[] bytes = new byte[48]; new SecureRandom().nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  /** A selection hint only. The child must bind strictly; this does not reserve it. */
  public static int loopbackPort() throws IOException {
    try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
      return socket.getLocalPort();
    }
  }

  public static String fingerprint(String value) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder();
      for (byte item : digest) result.append(String.format(Locale.ROOT, "%02x", item & 255));
      return result.toString();
    } catch (NoSuchAlgorithmException unavailable) { throw new IllegalStateException("SHA-256 unavailable", unavailable); }
  }
}
