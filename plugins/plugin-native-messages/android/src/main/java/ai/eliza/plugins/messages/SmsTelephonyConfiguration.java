package ai.eliza.plugins.messages;

import android.content.BroadcastReceiver;
import android.content.Context;

/**
 * Host identity of the reviewed SMS core. Every string is migration-sensitive: in-flight sent and
 * delivery PendingIntents name the receiver, actions and data scheme, and an installed journal lives
 * in the configured slot with its retired-ID namespace. A host adopting this module keeps the values
 * it already shipped. No request can override them.
 */
public final class SmsTelephonyConfiguration {
 /** The AOSP telephony capability profile. Hosts decide it natively from facts an ordinary install cannot produce. */
 public interface Admission { boolean admitted(Context context); }
 /** Encrypted storage owned by the host (for example a Keystore-backed credential slot). */
 public interface JournalStore {
  String read(String slot) throws Exception;
  void write(String slot, String value) throws Exception;
 }
 public interface JournalStoreFactory { JournalStore open(Context context) throws Exception; }

 public final String journalSlot, legacyJournalFile, retiredNamespace, sentAction, deliveredAction, callbackScheme, operationExtra, indexExtra, imageFeature;
 public final Class<? extends BroadcastReceiver> receiverClass;
 public final Admission admission;
 public final JournalStoreFactory store;

 /**
  * @param legacyJournalFile a plaintext journal in {@code noBackupFilesDir} written by an earlier host
  *     release, migrated into the encrypted slot and then removed; null when there is none.
  * @param imageFeature the system feature an AOSP image declares for this host, reported by
  *     {@code imageCapability}; it is a marker, never an alternative admission path.
  */
 public SmsTelephonyConfiguration(String journalSlot, String legacyJournalFile, String retiredNamespace, String sentAction, String deliveredAction,
   String callbackScheme, String operationExtra, String indexExtra, String imageFeature, Class<? extends BroadcastReceiver> receiverClass,
   Admission admission, JournalStoreFactory store) {
  this.journalSlot = text(journalSlot, "[A-Za-z0-9][A-Za-z0-9:._-]{0,127}");
  this.legacyJournalFile = legacyJournalFile == null ? null : text(legacyJournalFile, "[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  this.retiredNamespace = text(retiredNamespace, "[a-z0-9][a-z0-9._:-]{0,63}");
  this.sentAction = text(sentAction, "[A-Za-z0-9_.]{1,200}");
  this.deliveredAction = text(deliveredAction, "[A-Za-z0-9_.]{1,200}");
  this.callbackScheme = text(callbackScheme, "[a-z][a-z0-9+.-]{0,63}");
  this.operationExtra = text(operationExtra, "[A-Za-z][A-Za-z0-9_.]{0,63}");
  this.indexExtra = text(indexExtra, "[A-Za-z][A-Za-z0-9_.]{0,63}");
  this.imageFeature = text(imageFeature, "[A-Za-z0-9_.]{1,200}");
  if (sentAction.equals(deliveredAction) || operationExtra.equals(indexExtra)) throw new IllegalArgumentException("Distinct SMS callback identities required");
  this.receiverClass = java.util.Objects.requireNonNull(receiverClass);
  this.admission = java.util.Objects.requireNonNull(admission);
  this.store = java.util.Objects.requireNonNull(store);
 }
 private static String text(String value, String pattern) {
  if (value == null || !value.matches(pattern)) throw new IllegalArgumentException("Invalid SMS telephony configuration");
  return value;
 }
 /** Identity of the installed journal: two configurations with the same key share one journal. */
 String journalKey() { return journalSlot + "\u0000" + retiredNamespace + "\u0000" + legacyJournalFile; }
}
