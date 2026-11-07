package ai.eliza.plugins.messages;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

/** JVM checks of reviewed MMS records in the shared send journal. No SIM, radio or provider. */
public final class MmsSendJournalTest {
 /** SHA-256 of the shared contract's mmsBindingText for the fixture below, computed by Node. */
 static final String CONTRACT_MMS_BINDING_HASH = "7fc7da6d80aa0708b1a886eead139143327d07248dfeeae25853c2098a95cd28";
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 static void throwsOn(Runnable action, String what) { try { action.run(); } catch (RuntimeException expected) { return; } throw new AssertionError(what); }
 static SmsSendJournal.Attachment jpeg(String name, int size) { return new SmsSendJournal.Attachment("image/jpeg", name, "a".repeat(64), size); }

 @Test public void mmsBindingValidationAndEvidence() throws Exception {
  String[] two = { "+15555550100", "5550101" };
  String body = "Dinner \"7\"\né😀";
  SmsSendJournal.Attachment[] attachments = { jpeg("photo.jpg", 7), new SmsSendJournal.Attachment("image/png", "b.png", "b".repeat(64), 9) };
  require(SmsSendJournal.sha256(SmsSendJournal.mmsBindingText(two, body, attachments, 3)).equals(CONTRACT_MMS_BINDING_HASH), "binding matches the contract");

  SmsSendJournal.Attachment[] none = {};
  SmsSendJournal.validateMms("op-1", two, "", attachments, 0);
  SmsSendJournal.validateMms("op-1", two, "hi", none, 0);
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "", none, 0), "empty message");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", new String[11], "hi", none, 0), "too many recipients");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", new String[] { "5550100", "5550100" }, "hi", none, 0), "duplicate");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "a\0b", none, 0), "NUL");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "", new SmsSendJournal.Attachment[] { new SmsSendJournal.Attachment("text/html", "a.html", "a".repeat(64), 3) }, 0), "type");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "", new SmsSendJournal.Attachment[] { jpeg("../a", 3) }, 0), "name");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "", new SmsSendJournal.Attachment[] { jpeg("a.jpg", 3), jpeg("a.jpg", 3) }, 0), "duplicate name");
  throwsOn(() -> SmsSendJournal.validateMms("op-1", two, "", new SmsSendJournal.Attachment[] { jpeg("a.jpg", 600_000), jpeg("b.jpg", 600_000) }, 0), "total size");

  File dir = Files.createTempDirectory("mms-journal").toFile();
  File file = new File(dir, "journal");
  SmsSendJournal journal = new SmsSendJournal(file);
  String hash = SmsSendJournal.sha256(SmsSendJournal.mmsBindingText(two, body, attachments, 3));

  // Cancelled: no dispatch unit, repeated ID reads the record; SMS binding of the same ID is refused.
  SmsSendJournal.Record cancelled = journal.decideMms("mms-cancel", two, body, attachments, 3, "cancelled", 1000, 7);
  require("cancelled".equals(cancelled.status()) && cancelled.group && cancelled.parts() == 0, "cancelled");
  require(journal.existing("mms-cancel", hash) == cancelled, "repeat reads the record");
  throwsOn(() -> journal.existing("mms-cancel", SmsSendJournal.sha256(SmsSendJournal.bindingText(two, body, 3))), "reuse with SMS content");

  // Dispatch: interrupted reads unknown; a sent callback reads sent; never delivered.
  SmsSendJournal.Record record = journal.beginMmsDispatch("mms-1", two, body, attachments, 3, 2000, 7);
  require(record.bindingHash.equals(hash) && record.parts() == 1 && record.providerRow.length == 1, "one unit, one row");
  require("unknown".equals(record.status()), "dispatching is unknown");
  journal.endDispatch("mms-1", true);
  require("submitted".equals(record.status()), "submitted");
  require(journal.open(7, 2001).contains(record), "awaiting the send confirmation");
  journal.providerRow("mms-1", 0, 41);
  journal.providerRow("mms-1", 1, 42);
  require(record.providerRow[0] == 41, "one provider row");
  require(journal.sentResult("mms-1", 0, true), "sent result");
  require(!journal.sentResult("mms-1", 0, false), "first answer stands");
  require("sent".equals(record.status()), "sent");
  require(!journal.deliveryReported("mms-1", 1), "no second unit");
  require(!journal.providerStatus("mms-1", 0, SmsSendJournal.STATUS_COMPLETE), "MMS delivery is never applied");
  require("sent".equals(record.status()), "never delivered");
  require(!journal.open(7, 2002).contains(record), "closed after the send confirmation");
  long[] settled = journal.settledRow("mms-1", 0);
  require(settled != null && settled[0] == 41 && settled[1] == SmsSendJournal.TYPE_SENT, "settled row");

  // A restart reads every record back exactly; an undecided MMS from another boot becomes unknown.
  SmsSendJournal.Record waiting = journal.beginMmsDispatch("mms-2", new String[] { "5550100" }, "", new SmsSendJournal.Attachment[] { jpeg("a.jpg", 5) }, 3, 3000, 7);
  journal.endDispatch("mms-2", true);
  SmsSendJournal reloaded = new SmsSendJournal(file);
  SmsSendJournal.Record back = reloaded.get("mms-1");
  require(back.group && "sent".equals(back.status()) && back.providerRow[0] == 41 && back.bindingHash.equals(hash), "reloaded sent");
  require(reloaded.get("mms-cancel").group && "cancelled".equals(reloaded.get("mms-cancel").status()), "reloaded cancelled");
  require(reloaded.reconcile(8, false), "restart reconciles");
  require("unknown".equals(reloaded.get("mms-2").status()), "no confirmation after a restart reads unknown");
  require(!reloaded.open(8, 3001).contains(reloaded.get("mms-2")), "nothing awaited after a restart");

  // A failed send confirmation reads failed and settles the row as failed.
  SmsSendJournal.Record failing = reloaded.beginMmsDispatch("mms-3", two, "x", none, 3, 4000, 8);
  reloaded.endDispatch("mms-3", true);
  reloaded.providerRow("mms-3", 0, 50);
  reloaded.sentResult("mms-3", 0, false);
  require("failed".equals(failing.status()), "failed");
  long[] failedRow = reloaded.settledRow("mms-3", 0);
  require(failedRow != null && failedRow[1] == SmsSendJournal.TYPE_FAILED, "failed row");

  // Damaged MMS lines are refused, never read as empty.
  String line = SmsSendJournal.encode(back);
  require(line.startsWith("m1|"), "group records are marked");
  throwsOn(() -> SmsSendJournal.decode(line.replace("|41", "|41,42")), "two rows");
  throwsOn(() -> SmsSendJournal.decode(line.replaceFirst("\\|1\\|s\\|u\\|", "|2|ss|uu|")), "two units");
  for (File f : dir.listFiles()) f.delete();
  dir.delete();
 }
}
