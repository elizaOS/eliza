package ai.eliza.plugins.securestore.nativeonly;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;

/** Trusted native composition only; no renderer methods or persisted authentication grants. */
public final class PasswordVaultCustody {
  public interface Operation<T> { T run(PasswordVaultStore store) throws Exception; }
  private final PasswordVaultStore legacy, device;
  private final PasswordCustodySelection selection;

  public PasswordVaultCustody(File journalDirectory, PasswordVaultStore legacy,
      PasswordVaultStore device, boolean enableDeviceUnlocked) throws Exception {
    legacy.validateMigrationTarget(device);
    this.legacy = legacy;
    this.device = device;
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (DataOutputStream out = new DataOutputStream(bytes)) {
      for (PasswordVaultStore store : new PasswordVaultStore[]{legacy, device}) {
        byte[] identity = store.custodyIdentity();
        out.writeInt(identity.length); out.write(identity);
      }
    }
    selection = new PasswordCustodySelection(journalDirectory, bytes.toByteArray(),
        enableDeviceUnlocked, device::custodyExists);
  }
  /** Callbacks must not retain the store or reenter this owner. Route all writers through it. */
  public <T> T use(Operation<T> operation) throws Exception {
    return selection.use(version -> operation.run(
        version == PasswordCustodySelection.Version.LEGACY ? legacy : device));
  }
  /** Requires the old key's authentication; does not remove the original vault or key. */
  public void migrate() throws Exception {
    selection.migrate(() -> legacy.migrateToDeviceUnlocked(device));
  }
}
