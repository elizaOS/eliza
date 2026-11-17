package ai.eliza.plugins.messages;

/**
 * How rows of the Android SMS/MMS providers are reported to the telephony clients. Plain Java so the JVM tests
 * check the mapping; the constants mirror android.provider.Telephony.
 *
 * Direction is incoming or outgoing. Status is received or read for incoming messages, and pending,
 * sent, failed or delivered for outgoing ones. Drafts are not messages and are skipped. An SMS reads
 * "delivered" only when the provider recorded a complete delivery report; MMS delivery is never
 * claimed from the provider row, so a sent MMS reads "sent".
 */
public final class SmsRecords {
 private SmsRecords() {}
 // Telephony.TextBasedSmsColumns.MESSAGE_TYPE_* and Telephony.BaseMmsColumns.MESSAGE_BOX_*.
 public static final int INBOX = 1, SENT = 2, DRAFT = 3, OUTBOX = 4, FAILED = 5, QUEUED = 6;
 public static final int MAX_THREADS = 50, MAX_MESSAGES = 50, MAX_BODY = 2000, MAX_ADDRESSES = 20;

 /** "incoming", "outgoing", or null for a draft or an unknown type, which are not reported. */
 public static String direction(int box) {
  if (box == INBOX) return "incoming";
  if (box == SENT || box == OUTBOX || box == FAILED || box == QUEUED) return "outgoing";
  return null;
 }

 /** SMS status from the provider's type, delivery status and read columns. */
 public static String smsStatus(int type, int status, boolean read) {
  if (type == INBOX) return read ? "read" : "received";
  if (type == OUTBOX || type == QUEUED) return "pending";
  if (type == FAILED) return "failed";
  if (type == SENT) return status == SmsSendJournal.STATUS_COMPLETE ? "delivered" : "sent";
  return null;
 }
 /** The delivery report recorded for an outgoing SMS: none requested, pending, complete or failed. */
 public static String smsDeliveryReport(int type, int status) {
  if (direction(type) == null || type == INBOX) return null;
  if (status == SmsSendJournal.STATUS_COMPLETE) return "complete";
  if (status >= SmsSendJournal.STATUS_FAILED) return "failed";
  if (status >= SmsSendJournal.STATUS_PENDING) return "pending";
  return "none";
 }
 public static String mmsStatus(int box, boolean read) {
  if (box == INBOX) return read ? "read" : "received";
  if (box == OUTBOX) return "pending";
  if (box == FAILED) return "failed";
  if (box == SENT) return "sent";
  return null;
 }

 /** Stable message IDs: provider and row, so an SMS and an MMS with the same row number differ. */
 public static String messageId(boolean mms, long row) { return (mms ? "mms:" : "sms:") + row; }
 public static String threadId(long row) { return "thread:" + row; }
 /** The provider row of a thread ID this module issued, or -1. */
 public static long threadRow(String id) {
  if (id == null || !id.matches("thread:[1-9][0-9]{0,17}")) return -1;
  return Long.parseLong(id.substring(7));
 }
 public static String clip(String text, int max) {
  if (text == null) return "";
  if (text.length() <= max) return text;
  int end = max;
  if (Character.isHighSurrogate(text.charAt(end - 1))) end--;
  return text.substring(0, end);
 }
 /** MMS dates are seconds; SMS dates are milliseconds. */
 public static long mmsMillis(long seconds) { return seconds > 0 && seconds < 100_000_000_000L ? seconds * 1000L : seconds; }
 /**
  * The provider MMS date (seconds) bound for "shown at or before {@code millis}": an MMS reported at
  * {@code seconds * 1000 <= millis} has {@code seconds <= millis / 1000}, so a message newer than the
  * shown page is never included.
  */
 public static long mmsSecondsThrough(long millis) { return millis > 0 ? millis / 1000L : 0; }
}
