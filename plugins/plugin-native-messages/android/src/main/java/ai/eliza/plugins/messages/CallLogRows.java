package ai.eliza.plugins.messages;

import java.util.regex.Pattern;

/**
 * Pure mapping of Android call-log rows into the shared recent-calls page
 * ({@code parseCallLog} in {@code @elizaos/contracts/native-telephony}). No Android types, so the
 * JVM tests cover it without a provider. The provider query lives in {@link TelephonyPlugin}.
 */
public final class CallLogRows {
 private CallLogRows() {}
 /** The largest page one read returns (TELEPHONY_CALL_LOG_MAX). */
 public static final int MAX_CALLS = 50;
 private static final Pattern DIALABLE = Pattern.compile("^\\+?[0-9]{2,20}$");
 private static final Pattern ID = Pattern.compile("^[0-9]{1,32}$");

 /** android.provider.CallLog.Calls TYPE values (stable public constants since their API level). */
 public static String type(int raw) {
  switch (raw) {
   case 1: return "incoming";
   case 2: return "outgoing";
   case 3: return "missed";
   case 4: return "voicemail";
   case 5: return "rejected";
   case 6: return "blocked";
   case 7: return "answered_externally";
   default: return "unknown";
  }
 }

 /** Digits with an optional leading +, or "" for a withheld, unknown, MMI or otherwise undialable entry. */
 public static String number(String raw) {
  if (raw == null) return "";
  String trimmed = raw.trim();
  StringBuilder digits = new StringBuilder(trimmed.length());
  for (int i = 0; i < trimmed.length(); i++) {
   char c = trimmed.charAt(i);
   if (c >= '0' && c <= '9') digits.append(c);
   else if (c == '+' && i == 0) digits.append(c);
   else if (c == ' ' || c == '-' || c == '(' || c == ')' || c == '.') continue;
   else return "";
  }
  String value = digits.toString();
  return DIALABLE.matcher(value).matches() ? value : "";
 }

 /** A clamped page size: 1..{@link #MAX_CALLS}, or -1 when the request is outside it. */
 public static int limit(Integer requested) {
  return requested == null || requested < 1 || requested > MAX_CALLS ? -1 : requested;
 }

 /** True when the row can be published: a numeric provider ID, a positive date not newer than the previous row. */
 public static boolean publishable(String id, long date, long previousDate) {
  return id != null && ID.matcher(id).matches() && date > 0 && date <= previousDate;
 }

 /** Non-negative whole seconds. */
 public static long duration(long seconds) { return Math.max(0L, seconds); }
}
