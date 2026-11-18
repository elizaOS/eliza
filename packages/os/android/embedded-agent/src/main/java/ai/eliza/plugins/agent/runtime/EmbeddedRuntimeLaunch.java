package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.Base64;

public final class EmbeddedRuntimeLaunch {
  private final Path bundle, executable, state;

  public EmbeddedRuntimeLaunch(Path bundle, Path installed, Path state) throws IOException {
    this.bundle = bundle.toAbsolutePath();
    this.executable = installed.resolve("libeliza_node.so").toAbsolutePath();
    this.state = state.toAbsolutePath();
    if (!Files.isRegularFile(executable, LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(executable))
      throw new IOException("Installed Android Node runtime is unavailable");
    Files.createDirectories(this.state.resolve("tmp"),
        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
  }

  public ProcessBuilder agent(Path config, Path socket) {
    ProcessBuilder builder = new ProcessBuilder(executable.toString(),
        bundle.resolve(RuntimeBundleStore.BUNDLE).toString(), "serve", "--launch", config.toAbsolutePath().toString(),
        "--state", state.toString(), "--socket", socket.toAbsolutePath().toString()).directory(bundle.toFile());
    var environment = builder.environment();
    environment.clear();
    environment.put("PATH", "/system/bin");
    environment.put("HOME", state.toString());
    environment.put("TMPDIR", state.resolve("tmp").toString());
    return builder;
  }

  public static String token() {
    byte[] bytes = new byte[48];
    new SecureRandom().nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

}
