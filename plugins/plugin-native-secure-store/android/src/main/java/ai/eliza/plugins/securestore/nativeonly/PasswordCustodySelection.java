package ai.eliza.plugins.securestore.nativeonly;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;

/** Native host journal. Every vault access, including reads, must run through this owner. */
public final class PasswordCustodySelection {
  public enum Version { LEGACY, DEVICE_UNLOCKED }
  public interface Operation<T> { T run(Version version) throws Exception; }
  public interface Migration { void copyAndVerify() throws Exception; }
  public interface Target { boolean exists() throws Exception; }
  public static final class RecoveryRequired extends IOException {
    RecoveryRequired(String message) { super(message); }
  }
  private final Path directory, journal, lock;
  private final String binding;
  private final boolean enabled;
  private final Target target;

  public PasswordCustodySelection(File directory, byte[] identity, boolean enabled, Target target) throws Exception {
    this.directory = directory.getCanonicalFile().toPath();
    Files.createDirectories(this.directory);
    this.journal = this.directory.resolve("custody-selection.v1");
    this.lock = this.directory.resolve("custody-selection.lock");
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity);
    StringBuilder hex = new StringBuilder();
    for (byte value : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
    this.binding = "password-custody-v1\n" + hex + "\n";
    this.enabled = enabled;
    this.target = target;
  }

  // File locks coordinate Android processes. The monitor also coordinates instances in one JVM,
  // where overlapping FileChannel locks throw instead of waiting.
  private <T> T locked(Operation<T> operation, boolean migrating, Migration migration) throws Exception {
    synchronized (PasswordCustodySelection.class) {
      if (Files.isSymbolicLink(lock)) throw new RecoveryRequired("Invalid custody lock");
      try (FileChannel channel = FileChannel.open(lock, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
           FileLock held = channel.lock()) {
        String state = read();
        if (!enabled && !state.equals("legacy")) throw new RecoveryRequired("Device custody requires host opt-in");
        if (migrating) {
          if (!enabled) throw new RecoveryRequired("Device custody requires host opt-in");
          if (!state.equals("device")) {
            write("pending");
            migration.copyAndVerify();
            write("device");
          }
          return null;
        }
        if (state.equals("pending")) throw new RecoveryRequired("Password migration must resume");
        return operation.run(state.equals("device") ? Version.DEVICE_UNLOCKED : Version.LEGACY);
      }
    }
  }
  public <T> T use(Operation<T> operation) throws Exception { return locked(operation, false, null); }
  public void migrate(Migration migration) throws Exception { locked(null, true, migration); }

  private String read() throws Exception {
    if (Files.isSymbolicLink(journal)) throw new RecoveryRequired("Invalid custody selection");
    if (!Files.exists(journal)) {
      if (target.exists()) throw new RecoveryRequired("Missing custody selection beside target");
      return "legacy";
    }
    if (!Files.isRegularFile(journal) || Files.size(journal) > 128)
      throw new RecoveryRequired("Invalid custody selection");
    String record = new String(Files.readAllBytes(journal), StandardCharsets.UTF_8);
    for (String state : new String[]{"pending", "device"})
      if (record.equals(binding + state + "\n")) return state;
    throw new RecoveryRequired("Invalid custody selection");
  }
  private void write(String state) throws Exception {
    Path temporary = Files.createTempFile(directory, "custody-selection-", ".pending");
    try {
      try (FileOutputStream output = new FileOutputStream(temporary.toFile())) {
        output.write((binding + state + "\n").getBytes(StandardCharsets.UTF_8));
        output.getFD().sync();
      }
      Files.move(temporary, journal, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      try (FileChannel parent = FileChannel.open(directory, StandardOpenOption.READ)) { parent.force(true); }
    } finally { Files.deleteIfExists(temporary); }
  }
}
