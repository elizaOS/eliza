package ai.eliza.auth.cloud;

/**
 * The host's protected credential storage (for example an Android Keystore-backed slot store in the
 * no-backup directory). The sign-in client writes the minted key, the acknowledgement receipt and a
 * pending browser record through it and never stores a Steward session. Implementations call the
 * guard they were created with before every write and removal, so a closed or superseded sign-in
 * cannot commit.
 *
 * Writes and comparisons return only after the encrypted value is durably committed. Reads are
 * authoritative durable readback, including after a write throws; an uncommitted memory cache must
 * never satisfy a read. The acknowledgement protocol relies on that custody boundary before Cloud
 * erases its recoverable copy of a credential. Credential-slot comparisons must retain the host's
 * ordinary owner/provider retirement path as well as its atomic identity comparison.
 */
public interface CloudCredentialSlots {
 String read(String slot) throws Exception;
 void write(String slot, String value) throws Exception;
 void remove(String slot) throws Exception;
 /** Compare the exact persisted record atomically, under the host's existing credential guard. */
 default boolean compareExchange(String slot, String expected, String value) throws Exception {
  throw new UnsupportedOperationException("Atomic credential storage is required for sign-in recovery");
 }
}
