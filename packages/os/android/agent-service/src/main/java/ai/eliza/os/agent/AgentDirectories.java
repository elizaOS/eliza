// spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"
package ai.eliza.os.agent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Set;

public final class AgentDirectories {
  @FunctionalInterface public interface Sync { void directory(Path directory) throws IOException; }

  public static final String SOCKET = "agent.sock";
  private static final Set<PosixFilePermission> PRIVATE = PosixFilePermissions.fromString("rwx------");
  private final Path files;
  private final Sync sync;

  public AgentDirectories(Path filesDir, Sync sync) {
    this.files = filesDir.toAbsolutePath();
    this.sync = sync;
  }

  public Sync sync() { return sync; }

  public Path runtime() throws IOException { return privateDirectory(files.resolve("agent-runtime")); }

  public Path journal() throws IOException { return runtime().resolve("child"); }

  public Path recoveryArchive() throws IOException { return privateDirectory(files.resolve("agent-recovery")); }

  public Path state(String userId, String organizationId) throws IOException {
    Path location = stateLocation(userId, organizationId);
    privateDirectory(location.getParent());
    return privateDirectory(location);
  }

  Path stateLocation(String userId, String organizationId) { return files.resolve("agent").resolve(accountDigest(userId, organizationId)); }

  Path residentLocation(AgentConfig.ResidentOwner owner) {
    if (owner instanceof AgentConfig.RetainedOwner retained)
      return stateLocation(retained.linkedAccount().userId(), retained.linkedAccount().organizationId());
    return files.resolve("agent").resolve("installation");
  }

  public Path residentState(AgentConfig.ResidentOwner owner) throws IOException {
    Path location = residentLocation(owner);
    privateDirectory(location.getParent());
    return privateDirectory(location);
  }

  public Path socket() { return files.resolve("ipc").resolve(SOCKET); }

  public Path prepareSocket() throws IOException {
    Path socket = privateDirectory(files.resolve("ipc")).resolve(SOCKET);
    if (Files.isDirectory(socket, LinkOption.NOFOLLOW_LINKS)) throw new IOException(socket + " is a directory, not the agent socket");
    if (Files.deleteIfExists(socket)) sync.directory(socket.getParent());
    return socket;
  }

  public static String accountDigest(String userId, String organizationId) {
    if (!field(userId) || !field(organizationId)) throw new IllegalArgumentException("An account needs a user id and an organization id");
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      return hex(digest.digest((userId + "\n" + organizationId).getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 unavailable", impossible);
    }
  }

  Path privateDirectory(Path directory) throws IOException {
    if (Files.notExists(directory, LinkOption.NOFOLLOW_LINKS)) {
      Files.createDirectory(directory, PosixFilePermissions.asFileAttribute(PRIVATE));
      sync.directory(directory.getParent());
    }
    if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) throw new IOException(directory + " is not a real directory");
    Files.setPosixFilePermissions(directory, PRIVATE);
    if (!PRIVATE.equals(Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS)))
      throw new IOException(directory + " could not be made private to the app");
    return directory;
  }

  static String hex(byte[] bytes) {
    StringBuilder hex = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) hex.append(Character.forDigit((value & 255) >> 4, 16)).append(Character.forDigit(value & 15, 16));
    return hex.toString();
  }

  private static boolean field(String value) {
    return value != null && !value.trim().isEmpty() && value.indexOf('\n') < 0;
  }
}
