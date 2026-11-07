package ai.eliza.plugins.messages;

import java.io.IOException;
import java.util.List;

/**
 * The journal decisions of {@link ReviewedSmsSend}, without Android, so the JVM tests drive them with a
 * fake radio. Every step runs on {@link SmsTelephony#WORK}, one at a time.
 *
 * Order: {@link #plan} reads or creates the record before any platform call; the host then submits
 * every recipient and reports {@link #returned}; each part's first sent receipt is {@link #receipt};
 * {@link #settle} ends the send, with lost receipts reading "unknown". A repeated operation ID only
 * reads its record, so a second Send press, a retried worker or a redelivered intent never sends again.
 */
final class ReviewedSmsSendCore {
 private ReviewedSmsSendCore() {}

 /** No record was created and nothing reached Android: the journal or the platform refused first. */
 static final String NOT_SENT = "not-sent";

 /** Divides the body for the reviewed subscription. Called only when a new dispatch is planned. */
 interface Divider { List<String> divide(); }

 /** Either a finished status (nothing to dispatch now) or a new record with the parts to submit. */
 static final class Plan {
  final String status;
  final SmsSendJournal.Record record;
  final List<String> parts;
  private Plan(String status, SmsSendJournal.Record record, List<String> parts) { this.status = status; this.record = record; this.parts = parts; }
  boolean dispatch() { return record != null; }
 }

 /**
  * Reads the record of a repeated operation ID, or records a refusal, or begins a new dispatch.
  *
  * @param permitted SEND_SMS is held; without it the send is recorded as denied.
  * @throws IllegalArgumentException the request does not match `sms.send.v1`, or the ID was used for other content.
  */
 static Plan plan(SmsSendJournal journal, String operationId, String[] recipients, String body, int subscriptionId,
   boolean permitted, Divider divider, long now, long boot) throws IOException {
  SmsSendJournal.validate(operationId, recipients, body, subscriptionId);
  String binding = SmsSendJournal.sha256(SmsSendJournal.bindingText(recipients, body, subscriptionId));
  SmsSendJournal.Record existing;
  try { existing = journal.existing(operationId, binding); }
  // A dropped record: an earlier send under this ID may have happened, and it is never repeated.
  catch (SmsSendJournal.Expired expired) { return new Plan("unknown", null, null); }
  catch (IllegalStateException reused) { throw new IllegalArgumentException("operation reused for other content"); }
  if (existing != null) return new Plan(existing.status(), null, null);
  if (!permitted) return new Plan(journal.decide(operationId, recipients, body, subscriptionId, "denied", now, boot).status(), null, null);
  List<String> parts;
  try { parts = divider.divide(); } catch (RuntimeException refused) { parts = null; }
  // A text Android cannot divide, or one too long for SMS, is refused before any platform call.
  if (parts == null || parts.isEmpty() || parts.size() > SmsSendJournal.MAX_PARTS_PER_RECIPIENT)
   return new Plan(journal.decide(operationId, recipients, body, subscriptionId, "denied", now, boot).status(), null, null);
  int[] counts = new int[recipients.length];
  java.util.Arrays.fill(counts, parts.size());
  return new Plan(null, journal.beginDispatch(operationId, recipients, body, subscriptionId, counts, now, boot), parts);
 }

 /** Every platform call returned (submitted), or one threw (the outcome cannot be known). */
 static void returned(SmsSendJournal journal, String operationId, boolean allReturned) throws IOException { journal.endDispatch(operationId, allReturned); }

 /** One part's first sent receipt. Only RESULT_OK is success. */
 static boolean receipt(SmsSendJournal journal, String operationId, int index, boolean ok) throws IOException { return journal.sentResult(operationId, index, ok); }

 /** The status once every receipt arrived, or once the remaining receipts were lost (timeout or release). */
 static String settle(SmsSendJournal journal, String operationId, boolean receiptsLost) throws IOException {
  if (receiptsLost) journal.receiptsLost(operationId);
  SmsSendJournal.Record record = journal.get(operationId);
  return record == null ? "unknown" : record.status();
 }
}
