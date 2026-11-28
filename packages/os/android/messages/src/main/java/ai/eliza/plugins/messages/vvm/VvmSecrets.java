package ai.eliza.plugins.messages.vvm;

/**
 * Where the carrier-issued IMAP account of each subscription is kept. An implementation must keep
 * values encrypted at rest in storage private to the app and excluded from backup, and must make
 * {@link #clear} and {@link #clearAll} unrecoverable. {@link KeystoreVvmSecrets} is the default; a
 * host with its own credential store supplies that instead.
 */
public interface VvmSecrets {
 /** The stored value, or null when the slot is empty. */
 String read(String slot) throws Exception;
 void write(String slot, String value) throws Exception;
 void clear(String slot) throws Exception;
 /** Forgets every slot this store has written. */
 void clearAll() throws Exception;
}
