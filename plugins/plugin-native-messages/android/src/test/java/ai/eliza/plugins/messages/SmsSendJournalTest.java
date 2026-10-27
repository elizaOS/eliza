package ai.eliza.plugins.messages;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

/** JVM checks of the reviewed-SMS journal, page cursor and provider mapping. No SIM, radio or provider. */
public final class SmsSendJournalTest {
 /** SHA-256 of JSON.stringify({body, recipients, subscriptionId, type}) computed by Node for the fixture below. */
 static final String CONTRACT_BINDING_HASH = "53d0ac9b4312697932a9a85525df8ee38a1a0bc23ebfbb22687fcc1d67b41e90";
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 static void throwsOn(Runnable action, String what) { try { action.run(); } catch (RuntimeException expected) { return; } throw new AssertionError(what); }
 @Test public void journalBindingEvidenceDurabilityAndMapping() throws Exception {
  String expectedHash = CONTRACT_BINDING_HASH;
  File dir = Files.createTempDirectory("sms-journal").toFile();
  File file = new File(dir, "journal");
  String[] one = { "+15555550100" }, two = { "+15555550100", "5550101" };

  // Binding text is byte-identical to the shared contract's JSON.stringify (hash computed in Node).
  String body = "Running late \"5\" min\né😀\t\u0001";
  require(SmsSendJournal.sha256(SmsSendJournal.bindingText(two, body, 3)).equals(expectedHash), "binding hash matches JSON.stringify");

  // Validation follows validateSmsSend: 1..5 distinct numbers, 1..1600 chars, no NUL or lone surrogate.
  throwsOn(() -> SmsSendJournal.validate("op-1", new String[0], "x", 1), "no recipient");
  throwsOn(() -> SmsSendJournal.validate("op-1", new String[] { "1", "2", "3", "4", "5", "6" }, "x", 1), "too many");
  throwsOn(() -> SmsSendJournal.validate("op-1", new String[] { "+15555550100", "+15555550100" }, "x", 1), "duplicate");
  throwsOn(() -> SmsSendJournal.validate("op-1", new String[] { "*#06#" }, "x", 1), "MMI");
  throwsOn(() -> SmsSendJournal.validate("op-1", one, "", 1), "empty");
  throwsOn(() -> SmsSendJournal.validate("op-1", one, "a\0b", 1), "NUL");
  throwsOn(() -> SmsSendJournal.validate("op-1", one, "a\ud800b", 1), "lone surrogate");
  throwsOn(() -> SmsSendJournal.validate("op-1", one, "x".repeat(1601), 1), "long");
  throwsOn(() -> SmsSendJournal.validate("-op", one, "x", 1), "operation id");
  throwsOn(() -> SmsSendJournal.validate("op-1", one, "x", -1), "subscription");
  SmsSendJournal.validate("op-1", one, "x".repeat(1600), 0);

  SmsSendJournal journal = new SmsSendJournal(file);
  // Cancelled and denied: no parts, and a repeated ID reads the record.
  SmsSendJournal.Record cancelled = journal.decide("cancel-1", one, "hi", 1, "cancelled", 1000, 7);
  require("cancelled".equals(cancelled.status()) && cancelled.parts() == 0, "cancelled");
  String hash = SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "hi", 1));
  require(journal.existing("cancel-1", hash) == cancelled, "a repeated ID returns the stored record");
  throwsOn(() -> journal.existing("cancel-1", SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "other", 1))), "reused ID with other content is refused");
  throwsOn(() -> { try { journal.decide("cancel-1", one, "hi", 1, "denied", 1, 7); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "an ID is recorded once");

  // A multipart send to two recipients: submitted only after every call returned.
  SmsSendJournal.Record r = journal.beginDispatch("send-1", two, body, 3, new int[] { 2, 2 }, 2000, 7);
  require("unknown".equals(r.status()), "dispatch in progress is not reported as submitted");
  journal.endDispatch("send-1", true);
  require("submitted".equals(r.status()), "submitted");
  require(r.recipientOf(2) == 1 && r.partOf(2) == 0 && r.partOf(3) == 1 && r.firstPart(1) == 2, "part order");
  journal.sentResult("send-1", 0, true); journal.sentResult("send-1", 1, true); journal.sentResult("send-1", 2, true);
  require("submitted".equals(r.status()), "sent requires every part");
  require(!journal.sentResult("send-1", 0, false), "the first sent answer per part stands");
  journal.sentResult("send-1", 3, true);
  require("sent".equals(r.status()), "sent after every sent callback");
  // Multipart: one provider row whose status each part's report overwrites, so it proves nothing per part.
  for (int i = 0; i < 4; i++) journal.deliveryReported("send-1", i);
  require(!journal.providerStatus("send-1", 0, SmsSendJournal.STATUS_COMPLETE) && !journal.providerStatus("send-1", 1, SmsSendJournal.STATUS_FAILED), "multipart delivery is never inferred from the shared row");
  require("sent".equals(r.status()) && r.delivery[0] == SmsSendJournal.UNKNOWN, "multipart stays sent");
  // Single part per recipient: a report alone is not an outcome; the provider status decides.
  SmsSendJournal.Record single = journal.beginDispatch("send-1s", two, "hello", 3, new int[] { 1, 1 }, 2500, 7);
  journal.endDispatch("send-1s", true); journal.sentResult("send-1s", 0, true); journal.sentResult("send-1s", 1, true);
  journal.deliveryReported("send-1s", 0);
  require(!journal.providerStatus("send-1s", 0, SmsSendJournal.STATUS_PENDING), "pending status changes nothing");
  require(!journal.providerStatus("send-1s", 1, SmsSendJournal.STATUS_COMPLETE), "no delivery without that part's report");
  journal.providerStatus("send-1s", 0, SmsSendJournal.STATUS_COMPLETE);
  require("sent".equals(single.status()), "delivered needs every recipient");
  journal.deliveryReported("send-1s", 1); journal.providerStatus("send-1s", 1, SmsSendJournal.STATUS_COMPLETE);
  require("delivered".equals(single.status()) && !single.open(7, 2500), "delivered after every report");

  // A failed part makes the send failed; never retried.
  SmsSendJournal.Record f = journal.beginDispatch("send-2", one, "x", 3, new int[] { 1 }, 3000, 7);
  journal.endDispatch("send-2", true); journal.sentResult("send-2", 0, false);
  require("failed".equals(f.status()) && !f.open(7, 3000), "failed is closed");
  // Delivery failure is recorded in the part, the send stays sent.
  SmsSendJournal.Record d = journal.beginDispatch("send-3", one, "y", 3, new int[] { 1 }, 3000, 7);
  journal.endDispatch("send-3", true); journal.sentResult("send-3", 0, true); journal.deliveryReported("send-3", 0);
  journal.providerStatus("send-3", 0, SmsSendJournal.STATUS_FAILED);
  require("sent".equals(d.status()) && d.delivery[0] == SmsSendJournal.FAILED, "delivery failure");
  // A platform call that threw: unknown.
  SmsSendJournal.Record u = journal.beginDispatch("send-4", two, "z", 3, new int[] { 1, 1 }, 4000, 7);
  journal.endDispatch("send-4", false);
  require("unknown".equals(u.status()), "a throwing dispatch is unknown");
  // Interrupted mid-dispatch (process death) and sends whose callbacks were lost to a restart.
  journal.beginDispatch("send-5", one, "w", 3, new int[] { 1 }, 5000, 7);
  SmsSendJournal.Record waiting = journal.beginDispatch("send-6", one, "v", 3, new int[] { 1 }, 5000, 7);
  journal.endDispatch("send-6", true);

  // Durable: reload from disk, as a new process would.
  SmsSendJournal reloaded = new SmsSendJournal(file);
  require("unknown".equals(reloaded.get("send-5").status()), "still dispatching on disk reads unknown");
  reloaded.reconcile(7, false);
  require(!reloaded.get("send-5").dispatching && reloaded.get("send-5").unknown, "interrupted dispatch reconciled to unknown");
  require("submitted".equals(reloaded.get("send-6").status()), "same boot: callbacks may still arrive");
  reloaded.reconcile(8, true);
  require("unknown".equals(reloaded.get("send-6").status()), "after a restart, missing sent callbacks are unknown");
  require("delivered".equals(reloaded.get("send-1s").status()) && "sent".equals(reloaded.get("send-1").status()) && "failed".equals(reloaded.get("send-2").status()) && "cancelled".equals(reloaded.get("cancel-1").status()), "states survive reload");
  require(reloaded.get("send-1").bindingHash.equals(expectedHash), "binding persisted");
  String stored = new String(Files.readAllBytes(file.toPath()), "UTF-8");
  require(!stored.contains("Running late") && !stored.contains("\"5\""), "the body is never stored");
  // Evidence is awaited only while it can still arrive: same boot, or a report whose status is unread, and at most MAX_OPEN_MS.
  require(reloaded.get("send-1").open(8, 2000) && !reloaded.get("send-1").open(8, 2000 + SmsSendJournal.MAX_OPEN_MS + 1), "old records close");
  require(!reloaded.get("send-6").open(8, 6000) && !reloaded.get("send-3").open(7, 6000), "no callback can arrive after a restart; resolved records are closed");

  // A record that cannot be made durable is forgotten, never left reading "unknown" for a send that never happened.
  File blocked = new File(dir, "blocked"); blocked.mkdir();
  SmsSendJournal unwritable = new SmsSendJournal(new File(blocked, "journal"));
  blocked.setWritable(false);
  if (!blocked.canWrite()) {
   throwsOn(() -> { try { unwritable.beginDispatch("send-x", one, "x", 3, new int[] { 1 }, 1, 7); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "an unwritable journal refuses the dispatch");
   require(unwritable.get("send-x") == null, "the failed record is not kept in memory");
  }
  blocked.setWritable(true);

  // The bound never blocks sending, even when every record still awaits delivery reports, and a dropped
  // operation ID is refused rather than sent again.
  File boundFile = new File(dir, "bound");
  SmsSendJournal bound = new SmsSendJournal(boundFile);
  for (int i = 0; i < SmsSendJournal.MAX_RECORDS + 5; i++) {
   bound.beginDispatch("b" + i, one, "m" + i, 3, new int[] { 1 }, 10_000 + i, 7);
   bound.endDispatch("b" + i, true); bound.sentResult("b" + i, 0, true);
  }
  require(bound.get("b0") == null && bound.get("b" + (SmsSendJournal.MAX_RECORDS + 4)) != null, "oldest open records make room");
  String b0 = SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "m0", 3));
  boolean expired = false; try { bound.existing("b0", b0); } catch (SmsSendJournal.Expired expected) { expired = true; }
  require(expired, "a dropped ID with the same binding reads expired");
  throwsOn(() -> bound.existing("b0", SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "other", 3))), "a dropped ID with other content is refused");
  throwsOn(() -> { try { bound.beginDispatch("b0", one, "m0", 3, new int[] { 1 }, 1, 7); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "a dropped ID is never dispatched again");
  SmsSendJournal boundReloaded = new SmsSendJournal(boundFile);
  throwsOn(() -> boundReloaded.existing("b0", b0), "tombstones survive reload");
  require(boundReloaded.existing("b" + (SmsSendJournal.MAX_RECORDS + 4), SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "m" + (SmsSendJournal.MAX_RECORDS + 4), 3))) != null, "kept records survive reload");

  // No lifetime lockout and no forgotten key: beyond the tombstone bound, IDs are compacted into the
  // retired-ID filter. Every earlier ID stays refused (including after reload) and new IDs still send.
  final String[] memory = { null };
  SmsSendJournal.Storage storage = new SmsSendJournal.Storage() {
   public String read() { return memory[0]; }
   public void write(String value) { memory[0] = value; }
  };
  SmsSendJournal capacity = new SmsSendJournal(storage);
  int lifetime = SmsSendJournal.MAX_RECORDS + SmsSendJournal.MAX_TOMBSTONES + 300;
  String longId = "c".repeat(120);
  for (int i = 0; i < lifetime; i++) capacity.decide(longId + i, one, "x", 3, "cancelled", i + 1, 7);
  require(capacity.retiredCount() == 300, "oldest tombstones are compacted, not discarded");
  SmsSendJournal.Record afterLifetime = capacity.beginDispatch("overflow", one, "x", 3, new int[] { 1 }, 99999, 7);
  require(afterLifetime != null && "unknown".equals(afterLifetime.status()), "sending continues past the old lifetime capacity");
  require(memory[0].length() < 1024 * 1024 / 2, "journal with compacted IDs stays well inside the encrypted slot");
  SmsSendJournal capacityReloaded = new SmsSendJournal(storage);
  String xHash = SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "x", 3));
  for (int i = 0; i < lifetime; i++) {
   final String id = longId + i;
   boolean refused = false;
   try { capacityReloaded.existing(id, xHash); } catch (IllegalStateException expected) { refused = true; }
   require(refused || capacityReloaded.get(id) != null, "every earlier key is preserved after reload: " + i);
  }
  boolean compactedExpired = false; try { capacityReloaded.existing(longId + 0, SmsSendJournal.sha256(SmsSendJournal.bindingText(one, "other", 3))); } catch (SmsSendJournal.Expired expected) { compactedExpired = true; }
  require(compactedExpired, "a compacted ID is refused whatever its content");
  throwsOn(() -> { try { capacityReloaded.beginDispatch(longId + 0, one, "x", 3, new int[] { 1 }, 99999, 7); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "oldest compacted key cannot redispatch after reload");
  require(capacityReloaded.retiredCount() == 301 && capacityReloaded.isRetired(longId + 0) && !capacityReloaded.isRetired("fresh-id"), "filter survives reload");
  require(capacityReloaded.beginDispatch("fresh-after-reload", one, "x", 3, new int[] { 1 }, 100000, 7) != null, "fresh IDs send after reload");
  // Cancelled records never reached Android, so pruning them does not disable delivery attribution.
  require(!capacity.ambiguousProviderOwner(afterLifetime, 0, 600000), "cancelled-only pruning keeps attribution");

  // A pruned dispatched record disables attribution only for records near or before it.
  SmsSendJournal watermark = new SmsSendJournal(new File(dir, "watermark"));
  for (int i = 0; i <= SmsSendJournal.MAX_RECORDS; i++) { watermark.beginDispatch("w" + i, one, "w" + i, 3, new int[] { 1 }, 1000 + i, 7); watermark.endDispatch("w" + i, true); watermark.sentResult("w" + i, 0, true); }
  require(watermark.get("w0") == null, "dispatched record pruned");
  SmsSendJournal.Record nearPruned = watermark.get("w1");
  require(watermark.ambiguousProviderOwner(nearPruned, 0, 600000), "records within the window of a pruned send stay unknown");
  SmsSendJournal.Record later = watermark.beginDispatch("later", one, "later", 3, new int[] { 1 }, 1000 + 600000 + 10, 7);
  require(!watermark.ambiguousProviderOwner(later, 0, 600000), "records after the window attribute again");
  require(new SmsSendJournal(new File(dir, "watermark")).ambiguousProviderOwner(nearPruned, 0, 600000), "watermark survives reload");
  // A journal saved before the watermark existed keeps attribution off once anything was pruned.
  File legacyFile = new File(dir, "legacy");
  Files.write(legacyFile.toPath(), ("t1|old|" + xHash + "\n").getBytes("UTF-8"));
  SmsSendJournal legacyJournal = new SmsSendJournal(legacyFile);
  SmsSendJournal.Record legacyLater = legacyJournal.beginDispatch("legacy-later", one, "x", 3, new int[] { 1 }, 999999999, 7);
  require(legacyJournal.ambiguousProviderOwner(legacyLater, 0, 600000), "legacy pruned journal never guesses attribution");
  SmsSendJournal failing = new SmsSendJournal(new SmsSendJournal.Storage() {
   public String read() { return null; }
   public void write(String value) throws java.io.IOException { throw new java.io.IOException("secure storage failed"); }
  });
  throwsOn(() -> { try { failing.beginDispatch("blocked", one, "x", 3, new int[] { 1 }, 1, 7); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "secure storage failure refuses dispatch");
  require(failing.get("blocked") == null, "failed initial storage has no dispatched record");

  SmsSendJournal.ProviderMatch unique = new SmsSendJournal.ProviderMatch();
  unique.visit(1, false, false); unique.visit(2, true, false);
  require(unique.result() == 2, "one fully enumerated provider match");
  unique.visit(3, true, false); require(unique.result() == 0, "identical provider messages are ambiguous");
  SmsSendJournal.ProviderMatch claimed = new SmsSendJournal.ProviderMatch(); claimed.visit(2, true, true);
  require(claimed.result() == 0, "another operation owns the row");
  SmsSendJournal.ProviderMatch truncated = new SmsSendJournal.ProviderMatch(); truncated.visit(1, true, false);
  for (int i = 0; i < 20; i++) truncated.visit(i + 2, false, false);
  require(truncated.result() == 0, "bounded incomplete enumeration proves no match");
  SmsSendJournal attribution = new SmsSendJournal(new File(dir, "attribution"));
  SmsSendJournal.Record first = attribution.beginDispatch("first", one, "same", 3, new int[] { 1 }, 1000, 7);
  attribution.endDispatch("first", true);
  require(!attribution.ambiguousProviderOwner(first, 0, 600000), "one operation can own unique row");
  attribution.beginDispatch("second", one, "same", 3, new int[] { 1 }, 2000, 7);
  require(attribution.ambiguousProviderOwner(first, 0, 600000), "two identical reviewed sends cannot steal delivery evidence");

  // A damaged journal is an error, never an empty journal that would allow a resend.
  Files.write(file.toPath(), "v1|broken\n".getBytes("UTF-8"));
  throwsOn(() -> { try { new SmsSendJournal(file); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "damaged journal refused");

  // Equal timestamps across thread/SMS/MMS boundaries preserve every stable row.
  SmsPageCursor cursor = SmsPageCursor.parse("1000:mms:5", false);
  require(cursor.admits(1000, "mms", 4) && cursor.admits(1000, "sms", 99), "equal-time rows continue by kind and ID");
  require(!cursor.admits(1000, "mms", 5) && !cursor.admits(1000, "mms", 6), "cursor excludes rows already shown");
  require(cursor.admits(999, "sms", 100), "older rows continue");
  require(SmsPageCursor.parse("1000:thread:5", true).admits(1000, "thread", 4), "equal-time threads continue");
  require(SmsPageCursor.parse("1500:sms:5", false).predicate("mms", "date", "_id").equals("date <= 1"), "MMS seconds preserve fractional timestamp boundary");
  throwsOn(() -> SmsPageCursor.parse("1000:thread:5", false), "cursor kind bound");

  // Provider mapping.
  require("incoming".equals(SmsRecords.direction(SmsRecords.INBOX)) && "outgoing".equals(SmsRecords.direction(SmsRecords.OUTBOX)) && SmsRecords.direction(SmsRecords.DRAFT) == null, "direction");
  require("received".equals(SmsRecords.smsStatus(1, -1, false)) && "read".equals(SmsRecords.smsStatus(1, -1, true)), "incoming status");
  require("pending".equals(SmsRecords.smsStatus(4, -1, true)) && "pending".equals(SmsRecords.smsStatus(6, -1, true)) && "failed".equals(SmsRecords.smsStatus(5, -1, true)), "outgoing status");
  require("sent".equals(SmsRecords.smsStatus(2, -1, true)) && "sent".equals(SmsRecords.smsStatus(2, 32, true)) && "delivered".equals(SmsRecords.smsStatus(2, 0, true)) && "sent".equals(SmsRecords.smsStatus(2, 64, true)), "delivered only from a complete report");
  require("failed".equals(SmsRecords.smsDeliveryReport(2, 64)) && "none".equals(SmsRecords.smsDeliveryReport(2, -1)) && SmsRecords.smsDeliveryReport(1, 0) == null, "delivery report");
  require("sent".equals(SmsRecords.mmsStatus(2, true)) && SmsRecords.mmsStatus(3, true) == null, "MMS never claims delivery; drafts skipped");
  require("sms:5".equals(SmsRecords.messageId(false, 5)) && "mms:5".equals(SmsRecords.messageId(true, 5)), "stable IDs");
  require(SmsRecords.threadRow("thread:12") == 12 && SmsRecords.threadRow("thread:0") == -1 && SmsRecords.threadRow("thread:1 OR 1=1") == -1 && SmsRecords.threadRow(null) == -1, "thread IDs");
  require(SmsRecords.clip("ab😀", 3).equals("ab"), "clip keeps surrogate pairs whole");
  require(SmsRecords.mmsMillis(1700000000L) == 1700000000000L, "MMS seconds");
  for (File each : dir.listFiles()) { if (each.isDirectory()) for (File inner : each.listFiles()) inner.delete(); each.delete(); } dir.delete();
 }

 /** The retired-ID filter is salted by the host namespace: a host keeps the namespace its installed journal used. */
 @Test public void retiredFilterNamespaceIsMigrationSensitive() throws Exception {
  final String[] memory = { null };
  SmsSendJournal.Storage storage = new SmsSendJournal.Storage() {
   public String read() { return memory[0]; }
   public void write(String value) { memory[0] = value; }
  };
  String[] one = { "+15555550100" };
  SmsSendJournal legacy = new SmsSendJournal(storage, "legacy-sms-operation:v1:");
  for (int i = 0; i < SmsSendJournal.MAX_RECORDS + SmsSendJournal.MAX_TOMBSTONES + 1; i++) legacy.decide("id" + i, one, "x", 3, "cancelled", i + 1, 7);
  require(legacy.retiredCount() == 1 && legacy.isRetired("id0"), "oldest tombstone compacted");
  require(new SmsSendJournal(storage, "legacy-sms-operation:v1:").isRetired("id0"), "same namespace keeps refusing the compacted ID");
  require(!new SmsSendJournal(storage, SmsSendJournal.DEFAULT_RETIRED_NAMESPACE).isRetired("id0"), "a different namespace would forget it");
  throwsOn(() -> { try { new SmsSendJournal(storage, "Bad Namespace"); } catch (java.io.IOException e) { throw new RuntimeException(e); } }, "namespace grammar");
 }
}
