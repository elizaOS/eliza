package ai.eliza.plugins.messages;

import org.junit.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * JVM checks of the public host send ({@link ReviewedSmsSend}) through its journal core, with an
 * in-memory journal and a fake radio. No SIM, radio, provider or network.
 */
public final class ReviewedSmsSendCoreTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

 /** In-memory journal storage that survives a simulated process restart. */
 static final class Memory implements SmsSendJournal.Storage {
  String value;
  public String read() { return value; }
  public void write(String next) { value = next; }
 }

 /** Counts every platform submission. */
 static final class Radio {
  final List<String> submitted = new ArrayList<>();
  /** The host's sequence: plan, then submit each recipient only for a new dispatch, then report returned. */
  String send(SmsSendJournal journal, String id, String[] to, String body, int sub, boolean permitted, List<String> parts, long now, long boot) throws IOException {
   ReviewedSmsSendCore.Plan plan = ReviewedSmsSendCore.plan(journal, id, to, body, sub, permitted, () -> parts, now, boot);
   if (!plan.dispatch()) return plan.status;
   for (String recipient : to) submitted.add(recipient + ":" + plan.parts.size());
   ReviewedSmsSendCore.returned(journal, id, true);
   return plan.record.status();
  }
 }

 @Test public void repeatedOperationNeverSendsTwice() throws Exception {
  Memory memory = new Memory();
  SmsSendJournal journal = new SmsSendJournal(memory);
  Radio radio = new Radio();
  String[] to = { "+15555550100" };
  require("submitted".equals(radio.send(journal, "reply-1", to, "On my way", 2, true, Arrays.asList("On my way"), 1000, 7)), "first press submits");
  require(radio.submitted.size() == 1, "one platform call");
  // A second press, a retried worker or a redelivered intent with the same ID only reads the record.
  require("submitted".equals(radio.send(journal, "reply-1", to, "On my way", 2, true, Arrays.asList("On my way"), 2000, 7)), "repeat reads the record");
  require(radio.submitted.size() == 1, "no duplicate send");
  // The same ID for other content is refused before any platform call.
  try { radio.send(journal, "reply-1", to, "Different", 2, true, Arrays.asList("Different"), 3000, 7); throw new AssertionError("reuse accepted"); }
  catch (IllegalArgumentException expected) { }
  require(radio.submitted.size() == 1, "reused ID never sends");
 }

 @Test public void receiptsDecideSentOrFailedAndTimeoutIsUnknown() throws Exception {
  SmsSendJournal journal = new SmsSendJournal(new Memory());
  Radio radio = new Radio();
  String[] two = { "+15555550100", "+15555550101" };
  List<String> parts = Arrays.asList("part one", "part two");
  radio.send(journal, "sent-1", two, "part one part two", 0, true, parts, 1000, 7);
  for (int i = 0; i < 4; i++) ReviewedSmsSendCore.receipt(journal, "sent-1", i, true);
  require("sent".equals(ReviewedSmsSendCore.settle(journal, "sent-1", false)), "every RESULT_OK receipt reads sent");

  radio.send(journal, "fail-1", two, "part one part two", 0, true, parts, 1000, 7);
  ReviewedSmsSendCore.receipt(journal, "fail-1", 0, true);
  ReviewedSmsSendCore.receipt(journal, "fail-1", 1, false);
  require("failed".equals(ReviewedSmsSendCore.settle(journal, "fail-1", true)), "a failed receipt reads failed, also with lost receipts");

  radio.send(journal, "late-1", two, "part one part two", 0, true, parts, 1000, 7);
  ReviewedSmsSendCore.receipt(journal, "late-1", 0, true);
  require("unknown".equals(ReviewedSmsSendCore.settle(journal, "late-1", true)), "a timeout reads unknown, never failed or sent");
  int before = radio.submitted.size();
  require("unknown".equals(radio.send(journal, "late-1", two, "part one part two", 0, true, parts, 5000, 7)), "unknown stays unknown");
  require(radio.submitted.size() == before, "a timeout is never retried");
 }

 @Test public void interruptedDispatchAndRestartReadUnknown() throws Exception {
  Memory memory = new Memory();
  SmsSendJournal journal = new SmsSendJournal(memory);
  String[] to = { "+15555550100" };
  ReviewedSmsSendCore.Plan plan = ReviewedSmsSendCore.plan(journal, "crash-1", to, "hi", 1, true, () -> Arrays.asList("hi"), 1000, 7);
  require(plan.dispatch(), "dispatch planned");
  // A platform call that throws ends the dispatch unknown.
  ReviewedSmsSendCore.returned(journal, "crash-1", false);
  require("unknown".equals(ReviewedSmsSendCore.settle(journal, "crash-1", true)), "a throwing platform call reads unknown");

  ReviewedSmsSendCore.plan(journal, "waiting-1", to, "later", 1, true, () -> Arrays.asList("later"), 1000, 7);
  ReviewedSmsSendCore.returned(journal, "waiting-1", true);
  require("submitted".equals(journal.get("waiting-1").status()), "waiting for receipts");
  // A new process: the in-process receivers are gone.
  SmsSendJournal reloaded = new SmsSendJournal(memory);
  reloaded.reconcile(7, false);
  require(reloaded.allReceiptsLost(), "lost receipts recorded");
  require("unknown".equals(reloaded.get("waiting-1").status()), "receipts lost with the process read unknown");
  require(!reloaded.allReceiptsLost(), "idempotent");
  Radio radio = new Radio();
  require("unknown".equals(radio.send(reloaded, "waiting-1", to, "later", 1, true, Arrays.asList("later"), 2000, 7)) && radio.submitted.isEmpty(), "never resent after restart");
 }

 @Test public void refusalsAreRecordedWithoutPlatformCalls() throws Exception {
  SmsSendJournal journal = new SmsSendJournal(new Memory());
  Radio radio = new Radio();
  String[] to = { "+15555550100" };
  require("denied".equals(radio.send(journal, "noperm-1", to, "hi", 1, false, Arrays.asList("hi"), 1000, 7)), "no SEND_SMS reads denied");
  List<String> tooMany = new ArrayList<>();
  for (int i = 0; i <= SmsSendJournal.MAX_PARTS_PER_RECIPIENT; i++) tooMany.add("x");
  require("denied".equals(radio.send(journal, "long-1", to, "x", 1, true, tooMany, 1000, 7)), "too many parts reads denied");
  require(radio.submitted.isEmpty(), "nothing submitted");
  require(journal.known("noperm-1") && journal.known("long-1") && !journal.known("fresh-1"), "decided IDs are known");
  try { radio.send(journal, "bad-1", new String[] { "Eliza" }, "hi", 1, true, Arrays.asList("hi"), 1000, 7); throw new AssertionError("alphanumeric recipient accepted"); }
  catch (IllegalArgumentException expected) { }
  require(!journal.known("bad-1") && radio.submitted.isEmpty(), "an invalid request records and sends nothing");
 }
}
