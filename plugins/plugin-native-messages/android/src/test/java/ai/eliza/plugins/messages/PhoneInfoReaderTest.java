package ai.eliza.plugins.messages;

import android.Manifest;
import android.app.Application;
import android.telephony.SubscriptionInfo;
import android.telephony.TelephonyManager;

import com.getcapacitor.JSObject;
import java.util.Arrays;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowTelephonyManager;
import org.robolectric.shadows.ShadowSubscriptionManager.SubscriptionInfoBuilder;

/**
 * The phone-information read shared with the contract's parsePhoneInfo: the pure field mapping, and
 * the read against Android shadows with and without number and device-identifier access.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class PhoneInfoReaderTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

 @Test public void fieldMapping() {
  int unknown = TelephonyManager.NETWORK_TYPE_UNKNOWN;
  for (int type : new int[] { TelephonyManager.NETWORK_TYPE_GPRS, TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_CDMA,
    TelephonyManager.NETWORK_TYPE_1xRTT, TelephonyManager.NETWORK_TYPE_IDEN, TelephonyManager.NETWORK_TYPE_GSM })
   require(PhoneInfoReader.networkType(type, unknown, true).equals("2g"), "2g " + type);
  for (int type : new int[] { TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_EVDO_0, TelephonyManager.NETWORK_TYPE_EVDO_A,
    TelephonyManager.NETWORK_TYPE_EVDO_B, TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA, TelephonyManager.NETWORK_TYPE_HSPA,
    TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_TD_SCDMA, TelephonyManager.NETWORK_TYPE_EHRPD })
   require(PhoneInfoReader.networkType(type, unknown, true).equals("3g"), "3g " + type);
  require(PhoneInfoReader.networkType(TelephonyManager.NETWORK_TYPE_LTE, unknown, true).equals("4g"), "LTE");
  require(PhoneInfoReader.networkType(TelephonyManager.NETWORK_TYPE_NR, TelephonyManager.NETWORK_TYPE_LTE, true).equals("5g"), "data type first");
  require(PhoneInfoReader.networkType(TelephonyManager.NETWORK_TYPE_IWLAN, unknown, true).equals("wifi-calling"), "IWLAN");
  require(PhoneInfoReader.networkType(unknown, TelephonyManager.NETWORK_TYPE_UMTS, true).equals("3g"), "voice type when data reports none");
  require(PhoneInfoReader.networkType(unknown, unknown, false).equals("none"), "no service");
  require(PhoneInfoReader.networkType(unknown, unknown, true).equals("unknown"), "in service, type not reported");
  require(PhoneInfoReader.networkType(unknown, unknown, null).equals("unknown"), "an unread service state is never no service");
  require(PhoneInfoReader.networkType(999, unknown, false).equals("unknown"), "a type this build does not know");

  require("+15555550100".equals(PhoneInfoReader.number("+1 (555) 555-0100")), "separators removed");
  require("5550101".equals(PhoneInfoReader.number("5550101")), "local number");
  require(PhoneInfoReader.number(null) == null && PhoneInfoReader.number("") == null && PhoneInfoReader.number("  ") == null, "empty is unknown");
  require(PhoneInfoReader.number("+") == null && PhoneInfoReader.number("1+555") == null && PhoneInfoReader.number("555,1") == null, "not a number");
  require(PhoneInfoReader.number("+12345678901234567890123456789012") == null, "too long");

  require("8901260123456789012F".equals(PhoneInfoReader.iccid("8901260123456789012f")), "filler kept, upper case");
  require("89012601234567890123".equals(PhoneInfoReader.iccid(" 89012601234567890123 ")), "digits");
  require(PhoneInfoReader.iccid("") == null && PhoneInfoReader.iccid(null) == null, "empty is unknown");
  require(PhoneInfoReader.iccid("8901F6012345") == null && PhoneInfoReader.iccid("89012601234567890123456") == null, "not an ICCID");

  require("356938035643809".equals(PhoneInfoReader.imei("356938035643809")), "IMEI");
  require(PhoneInfoReader.imei("3569380356438") == null && PhoneInfoReader.imei("A0000000000000") == null && PhoneInfoReader.imei(null) == null, "not an IMEI");

  require("us".equals(PhoneInfoReader.countryIso("US")), "lower case");
  require(PhoneInfoReader.countryIso("") == null && PhoneInfoReader.countryIso("usa") == null && PhoneInfoReader.countryIso(null) == null, "not a country");

  require(PhoneInfoReader.signalLevel(-1) == 0 && PhoneInfoReader.signalLevel(3) == 3 && PhoneInfoReader.signalLevel(9) == 4, "signal clamped");
  require(PhoneInfoReader.name(null).isEmpty() && PhoneInfoReader.name(new String(new char[80]).replace('\0', 'x')).length() == 64, "names bounded");
 }

 private static SubscriptionInfo sim(int id, int slot, String name, String number, String iccid) {
  return SubscriptionInfoBuilder.newBuilder().setId(id).setSimSlotIndex(slot).setDisplayName(name).setCarrierName("Carrier " + name)
    .setNumber(number).setCountryIso("US").setIccId(iccid).buildSubscriptionInfo();
 }
 private static void exactKeys(JSONObject value, String... keys) {
  require(value.length() == keys.length, "field count");
  for (String key : keys) require(value.has(key), key);
 }

 @Test public void anUnreadSimListIsNotNoSim() throws Exception {
  JSObject value = PhoneInfoReader.read(RuntimeEnvironment.getApplication(), null, null);
  exactKeys(value, "access", "lines");
  exactKeys(value.getJSONObject("access"), "phoneState", "phoneNumbers", "deviceIdentifiers");
  require(!value.getJSONObject("access").getBoolean("phoneState"), "not read");
  require(value.getJSONArray("lines").length() == 0, "no lines");

  JSObject none = PhoneInfoReader.read(RuntimeEnvironment.getApplication(), Collections.emptyList(), null);
  require(none.getJSONObject("access").getBoolean("phoneState") && none.getJSONArray("lines").length() == 0, "read, and no SIM");
 }

 @Test public void linesDegradeFieldByField() throws Exception {
  Application app = RuntimeEnvironment.getApplication();
  ShadowTelephonyManager telephony = Shadows.shadowOf(app.getSystemService(TelephonyManager.class));
  TelephonyManager first = org.robolectric.shadow.api.Shadow.newInstanceOf(TelephonyManager.class);
  ShadowTelephonyManager line = Shadows.shadowOf(first);
  line.setDataNetworkType(TelephonyManager.NETWORK_TYPE_LTE);
  line.setImei(0, "356938035643809");
  telephony.setTelephonyManagerForSubscriptionId(7, first);
  SubscriptionInfo work = sim(7, 0, "Work", "+1 555-555-0100", "8901260123456789012f"), home = sim(4, 1, "Home", "", "");

  // An ordinary app: no number, no identifiers, and nothing thrown for the refused identifier read.
  telephony.setReadPhoneStatePermission(false);
  line.setReadPhoneStatePermission(false);
  JSObject ordinary = PhoneInfoReader.read(app, Arrays.asList(home, work, null, work), null);
  JSONObject access = ordinary.getJSONObject("access");
  require(access.getBoolean("phoneState") && !access.getBoolean("phoneNumbers") && !access.getBoolean("deviceIdentifiers"), "ordinary access");
  JSONArray lines = ordinary.getJSONArray("lines");
  require(lines.length() == 2, "one line per subscription");
  JSONObject row = lines.getJSONObject(0);
  exactKeys(row, "subscriptionId", "slot", "displayName", "carrierName", "number", "countryIso", "networkType", "roaming", "signalLevel", "embedded", "iccid", "imei");
  require(row.getInt("subscriptionId") == 7 && row.getInt("slot") == 0 && lines.getJSONObject(1).getInt("slot") == 1, "ordered by slot");
  require(row.getString("displayName").equals("Work") && row.getString("carrierName").equals("Carrier Work") && row.getString("countryIso").equals("us"), "names");
  require(row.isNull("number") && row.isNull("iccid") && row.isNull("imei"), "refused fields are null");
  require(!ordinary.toString().contains("356938035643809") && !ordinary.toString().contains("8901260123456789012"), "no identifier leaves without access");

  // Number and identifier access: the same lines, now complete.
  telephony.setReadPhoneStatePermission(true);
  line.setReadPhoneStatePermission(true);
  Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_PHONE_NUMBERS, "android.permission.READ_PRIVILEGED_PHONE_STATE");
  JSObject full = PhoneInfoReader.read(app, Arrays.asList(work, home), null);
  access = full.getJSONObject("access");
  require(access.getBoolean("phoneNumbers") && access.getBoolean("deviceIdentifiers"), "full access");
  row = full.getJSONArray("lines").getJSONObject(0);
  require(row.getString("number").equals("+15555550100"), "number normalised");
  require(row.getString("iccid").equals("8901260123456789012F") && row.getString("imei").equals("356938035643809"), "identifiers");
  require(row.getString("networkType").equals("4g"), "network");
  JSONObject second = full.getJSONArray("lines").getJSONObject(1);
  require(second.isNull("number") && second.isNull("iccid") && second.isNull("imei"), "an empty value is unknown, never an empty string");

  // More SIMs than the bound: the lowest slots.
  JSObject many = PhoneInfoReader.read(app, Arrays.asList(sim(15, 5, "f", "", ""), sim(14, 4, "e", "", ""), sim(13, 3, "d", "", ""), sim(12, 2, "c", "", ""), home, work), null);
  require(many.getJSONArray("lines").length() == PhoneInfoReader.MAX_LINES && many.getJSONArray("lines").getJSONObject(3).getInt("slot") == 3, "bounded");
 }
 @Test public void unavailableSubscriptionManagerNeverUsesDefaultLine() throws Exception {
  Application app = RuntimeEnvironment.getApplication();
  ShadowTelephonyManager defaults = Shadows.shadowOf(app.getSystemService(TelephonyManager.class));
  defaults.setDataNetworkType(TelephonyManager.NETWORK_TYPE_LTE);
  defaults.setIsNetworkRoaming(true);
  defaults.setLine1Number("+15555550199");
  defaults.setTelephonyManagerForSubscriptionId(7, null);
  Shadows.shadowOf(app).grantPermissions(Manifest.permission.READ_PHONE_NUMBERS);
  JSONObject row = PhoneInfoReader.read(app, Collections.singletonList(sim(7, 1, "Other SIM", "", "")), null)
    .getJSONArray("lines").getJSONObject(0);
  require(row.getInt("subscriptionId") == 7 && row.getInt("slot") == 1, "subscription identity retained");
  require(row.isNull("number"), "the default line number is not this subscription's number");
  require(row.getString("networkType").equals("unknown"), "the default line network is not this subscription's network");
  require(row.isNull("roaming") && row.isNull("signalLevel"), "the default line radio state is not this subscription's state");
 }

}
