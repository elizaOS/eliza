package ai.eliza.plugins.messages;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.CancellationSignal;
import android.telephony.ServiceState;
import android.telephony.SignalStrength;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The owner's own SIMs, carrier, number, network and device identifiers for a host's Settings page
 * ({@code parsePhoneInfo} in {@code @elizaos/contracts/native-telephony}). One bounded read with no
 * provider and no write. Each field is read on its own: a field Android refuses is null and the
 * other fields are still read. Identifiers are never logged and never placed in an exception.
 * {@link TelephonyPlugin#phoneInfo} runs it on the reader thread under the foreground fence.
 */
public final class PhoneInfoReader {
 private PhoneInfoReader() {}
 /** The most SIM lines one read returns. */
 public static final int MAX_LINES = 4;
 public static final int MAX_NAME = 64;
 /** Held only by privileged system apps. It is checked here and never requested. */
 private static final String PRIVILEGED = "android.permission.READ_PRIVILEGED_PHONE_STATE";
 private static final Pattern NUMBER = Pattern.compile("^(\\+[0-9]{1,31}|[0-9]{1,32})$");
 private static final Pattern ICCID = Pattern.compile("^[0-9]{1,21}F?$|^[0-9]{22}$");
 private static final Pattern IMEI = Pattern.compile("^[0-9]{14,16}$");
 private static final Pattern COUNTRY = Pattern.compile("^[a-z]{2}$");

 // ---- Pure mapping (JVM-tested without a radio) -------------------------------------------------

 /** One TelephonyManager NETWORK_TYPE_* value as a generation, or null for UNKNOWN (0). */
 private static String generation(int type) {
  switch (type) {
   case TelephonyManager.NETWORK_TYPE_UNKNOWN: return null;
   case TelephonyManager.NETWORK_TYPE_GPRS: case TelephonyManager.NETWORK_TYPE_EDGE: case TelephonyManager.NETWORK_TYPE_CDMA:
   case TelephonyManager.NETWORK_TYPE_1xRTT: case TelephonyManager.NETWORK_TYPE_IDEN: case TelephonyManager.NETWORK_TYPE_GSM: return "2g";
   case TelephonyManager.NETWORK_TYPE_UMTS: case TelephonyManager.NETWORK_TYPE_EVDO_0: case TelephonyManager.NETWORK_TYPE_EVDO_A:
   case TelephonyManager.NETWORK_TYPE_EVDO_B: case TelephonyManager.NETWORK_TYPE_HSDPA: case TelephonyManager.NETWORK_TYPE_HSUPA:
   case TelephonyManager.NETWORK_TYPE_HSPA: case TelephonyManager.NETWORK_TYPE_HSPAP: case TelephonyManager.NETWORK_TYPE_TD_SCDMA:
   case TelephonyManager.NETWORK_TYPE_EHRPD: return "3g";
   case TelephonyManager.NETWORK_TYPE_LTE: return "4g";
   case TelephonyManager.NETWORK_TYPE_NR: return "5g";
   case TelephonyManager.NETWORK_TYPE_IWLAN: return "wifi-calling";
   default: return "unknown";
  }
 }
 /**
  * The line's network: its data network type, or its voice network type when data reports none.
  * With neither, "none" only when the radio is known to have no service ({@code inService} false);
  * a service state that could not be read ({@code null}) is "unknown", never "none".
  */
 public static String networkType(int data, int voice, Boolean inService) {
  String known = generation(data);
  if (known == null) known = generation(voice);
  if (known != null) return known;
  return Boolean.FALSE.equals(inService) ? "none" : "unknown";
 }

 /** The line's own number as digits with an optional leading +, or null when empty or not a number. */
 public static String number(String raw) {
  if (raw == null) return null;
  String trimmed = raw.trim();
  StringBuilder digits = new StringBuilder(trimmed.length());
  for (int i = 0; i < trimmed.length(); i++) {
   char c = trimmed.charAt(i);
   if (c >= '0' && c <= '9') digits.append(c);
   else if (c == '+' && i == 0) digits.append(c);
   else if (c == ' ' || c == '-' || c == '(' || c == ')' || c == '.') continue;
   else return null;
  }
  String value = digits.toString();
  return NUMBER.matcher(value).matches() ? value : null;
 }
 /** Digits with an optional trailing F (the odd-length filler), at most 22 characters; otherwise null. */
 public static String iccid(String raw) {
  if (raw == null) return null;
  String value = raw.trim().toUpperCase(java.util.Locale.ROOT);
  return ICCID.matcher(value).matches() ? value : null;
 }
 /** 14 to 16 digits; otherwise null. */
 public static String imei(String raw) {
  if (raw == null) return null;
  String value = raw.trim();
  return IMEI.matcher(value).matches() ? value : null;
 }
 /** Two lower-case letters; otherwise null. */
 public static String countryIso(String raw) {
  if (raw == null) return null;
  String value = raw.trim().toLowerCase(java.util.Locale.ROOT);
  return COUNTRY.matcher(value).matches() ? value : null;
 }
 public static int signalLevel(int level) { return Math.max(0, Math.min(4, level)); }
 public static String name(CharSequence value) {
  String text = value == null ? "" : value.toString();
  return text.length() > MAX_NAME ? text.substring(0, MAX_NAME) : text;
 }

 // ---- The read ---------------------------------------------------------------------------------

 private static boolean granted(Context context, String permission) { return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
 private static Object orNull(Object value) { return value == null ? JSONObject.NULL : value; }

 /** Android accepts READ_PHONE_NUMBERS, READ_SMS or the SMS role for a line's own number. */
 private static boolean numbersReadable(Context context) {
  return (Build.VERSION.SDK_INT >= 26 && granted(context, Manifest.permission.READ_PHONE_NUMBERS))
    || granted(context, Manifest.permission.READ_SMS) || MmsStore.isDefaultSmsApp(context);
 }
 private static boolean carrierPrivileged(TelephonyManager telephony) {
  if (telephony == null) return false;
  try { return telephony.hasCarrierPrivileges(); } catch (RuntimeException unreadable) { return false; }
 }
 /**
  * Whether Android lets this app read device identifiers: the privileged permission, carrier
  * privileges, or (device and profile owners) an identifier read Android does not refuse. An app
  * that targets a release before Android 10 is answered null instead of refused, so there the
  * attempt proves nothing.
  */
 @android.annotation.SuppressLint({ "MissingPermission", "HardwareIds" })
 private static boolean identifiersReadable(Context context, TelephonyManager telephony, List<TelephonyManager> lines) {
  if (granted(context, PRIVILEGED) || carrierPrivileged(telephony)) return true;
  for (TelephonyManager line : lines) if (carrierPrivileged(line)) return true;
  if (Build.VERSION.SDK_INT < 26 || context.getApplicationInfo().targetSdkVersion < 29) return false;
  try { telephony.getImei(); return true; } catch (RuntimeException refused) { return false; }
 }

 /**
  * {@code {access: {phoneState, phoneNumbers, deviceIdentifiers}, lines}}. {@code active} is the
  * active subscription list, or null when it could not be read: then {@code access.phoneState} is
  * false and {@code lines} is empty, which is not a claim that the phone has no SIM.
  */
 public static JSObject read(Context context, List<SubscriptionInfo> active, CancellationSignal cancel) {
  TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
  boolean phoneState = active != null && telephony != null;
  List<SubscriptionInfo> ordered = new ArrayList<>();
  List<TelephonyManager> managers = new ArrayList<>();
  if (phoneState) {
   Set<Integer> seen = new HashSet<>();
   for (SubscriptionInfo info : active)
    if (info != null && info.getSubscriptionId() >= 0 && info.getSimSlotIndex() >= 0 && seen.add(info.getSubscriptionId())) ordered.add(info);
   ordered.sort((a, b) -> Integer.compare(a.getSimSlotIndex(), b.getSimSlotIndex()));
   if (ordered.size() > MAX_LINES) ordered = new ArrayList<>(ordered.subList(0, MAX_LINES));
   for (SubscriptionInfo info : ordered) {
    TelephonyManager line = null;
    if (Build.VERSION.SDK_INT >= 24) try { line = telephony.createForSubscriptionId(info.getSubscriptionId()); } catch (RuntimeException unavailable) { line = null; }
    // A missing per-subscription manager must not substitute the default SIM's radio state.
    managers.add(line);
   }
  }
  boolean numbers = numbersReadable(context);
  boolean identifiers = telephony != null && identifiersReadable(context, telephony, managers);
  JSArray lines = new JSArray();
  for (int i = 0; i < ordered.size(); i++) {
   if (cancel != null) cancel.throwIfCanceled();
   lines.put(line(context, ordered.get(i), managers.get(i), numbers, identifiers));
  }
  JSObject access = new JSObject();
  access.put("phoneState", phoneState); access.put("phoneNumbers", numbers); access.put("deviceIdentifiers", identifiers);
  JSObject value = new JSObject();
  value.put("access", access); value.put("lines", lines);
  return value;
 }

 private static JSObject line(Context context, SubscriptionInfo info, TelephonyManager line, boolean numbers, boolean identifiers) {
  JSObject row = new JSObject();
  row.put("subscriptionId", info.getSubscriptionId()); row.put("slot", info.getSimSlotIndex());
  row.put("displayName", name(info.getDisplayName())); row.put("carrierName", name(info.getCarrierName()));
  row.put("number", orNull(numbers ? ownNumber(context, info, line) : null));
  row.put("countryIso", orNull(countryIso(info.getCountryIso())));
  row.put("networkType", network(line));
  row.put("roaming", orNull(roaming(line)));
  row.put("signalLevel", orNull(signal(line)));
  row.put("embedded", Build.VERSION.SDK_INT >= 28 && info.isEmbedded());
  row.put("iccid", orNull(identifiers ? iccid(info.getIccId()) : null));
  row.put("imei", orNull(identifiers ? slotImei(line, info.getSimSlotIndex()) : null));
  return row;
 }

 @android.annotation.SuppressLint("MissingPermission") // Refusals are caught; a field Android refuses reads as unknown.
 private static String network(TelephonyManager line) {
  if (line == null) return "unknown";
  int data = TelephonyManager.NETWORK_TYPE_UNKNOWN, voice = TelephonyManager.NETWORK_TYPE_UNKNOWN;
  if (Build.VERSION.SDK_INT >= 24) {
   try { data = line.getDataNetworkType(); } catch (RuntimeException unreadable) { /* stays unknown */ }
   try { voice = line.getVoiceNetworkType(); } catch (RuntimeException unreadable) { /* stays unknown */ }
  }
  Boolean inService = null;
  if (Build.VERSION.SDK_INT >= 26) {
   try {
    ServiceState state = line.getServiceState();
    if (state != null) inService = state.getState() == ServiceState.STATE_IN_SERVICE || state.getState() == ServiceState.STATE_EMERGENCY_ONLY;
   } catch (RuntimeException unreadable) { /* stays unread */ }
  }
  return networkType(data, voice, inService);
 }
 private static Boolean roaming(TelephonyManager line) {
  if (line == null) return null;
  try { return line.isNetworkRoaming(); } catch (RuntimeException unreadable) { return null; }
 }
 private static Integer signal(TelephonyManager line) {
  if (line == null || Build.VERSION.SDK_INT < 28) return null;
  try { SignalStrength strength = line.getSignalStrength(); return strength == null ? null : signalLevel(strength.getLevel()); }
  catch (RuntimeException unreadable) { return null; }
 }
 /** The number Android holds for the subscription; the older sources answer where the newer one is absent or empty. */
 @android.annotation.SuppressLint({ "MissingPermission", "HardwareIds" })
 @SuppressWarnings("deprecation")
 private static String ownNumber(Context context, SubscriptionInfo info, TelephonyManager line) {
  String value = null;
  if (Build.VERSION.SDK_INT >= 33) {
   try {
    SubscriptionManager subscriptions = context.getSystemService(SubscriptionManager.class);
    if (subscriptions != null) value = number(subscriptions.getPhoneNumber(info.getSubscriptionId()));
   } catch (RuntimeException unreadable) { value = null; }
  }
  if (value == null) try { value = number(info.getNumber()); } catch (RuntimeException unreadable) { value = null; }
  if (value == null && line != null) try { value = number(line.getLine1Number()); } catch (RuntimeException unreadable) { value = null; }
  return value;
 }
 @android.annotation.SuppressLint({ "MissingPermission", "HardwareIds" })
 private static String slotImei(TelephonyManager line, int slot) {
  if (line == null || Build.VERSION.SDK_INT < 26) return null;
  try { return imei(line.getImei(slot)); } catch (RuntimeException unreadable) { return null; }
 }
}
