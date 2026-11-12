package ai.eliza.auth.cloud;

/**
 * The host's protected credential storage (for example an Android Keystore-backed slot store in the
 * no-backup directory). The sign-in client writes the minted key, the acknowledgement receipt and a
 * pending browser record through it and never stores a Steward session. Implementations call the
 * guard they were created with before every write and removal, so a closed or superseded sign-in
 * cannot commit.
 */
public interface CloudCredentialSlots {
 String read(String slot) throws Exception;
 void write(String slot, String value) throws Exception;
 void remove(String slot) throws Exception;
 /** Browser callback retirement must compare the exact persisted record atomically. */
 default boolean compareExchange(String slot, String expected, String value) throws Exception {
  throw new UnsupportedOperationException("Atomic credential retirement is required for browser sign-in");
 }
}
