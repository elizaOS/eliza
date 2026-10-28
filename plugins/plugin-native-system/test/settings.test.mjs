import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  androidRoleLabel,
  broaderPageNotice,
  handoffGate,
  parseRoleStatuses,
  parseSystemFacts,
  SYSTEM_TILE_SETTINGS_PAGES,
  switchValue,
  systemSwitchRows,
  tileAccessibleName,
  tileFactsFromSystemFacts,
  tileStateText,
} from "../src/settings.ts";

const root = path.resolve(import.meta.dirname, "..");
const source = (name) =>
  path.join(
    root,
    "android/src/main/java/ai/eliza/plugins/system",
    `${name}.java`,
  );
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

/** Android stand-ins with settable answers; every read can be made to fail. */
const stubs = {
  "android/app/NotificationManager.java":
    "package android.app; public class NotificationManager {public static final int INTERRUPTION_FILTER_ALL=1,INTERRUPTION_FILTER_PRIORITY=2,INTERRUPTION_FILTER_NONE=3,INTERRUPTION_FILTER_ALARMS=4;public int filter=2;public int getCurrentInterruptionFilter(){return filter;}}",
  "android/bluetooth/BluetoothAdapter.java":
    "package android.bluetooth; public class BluetoothAdapter {public static final int STATE_OFF=10,STATE_TURNING_ON=11,STATE_ON=12,STATE_TURNING_OFF=13;public int state;public BluetoothAdapter(int s){state=s;}public int getState(){return state;}}",
  "android/bluetooth/BluetoothManager.java":
    "package android.bluetooth; public class BluetoothManager {public BluetoothAdapter adapter;public BluetoothManager(BluetoothAdapter a){adapter=a;}public BluetoothAdapter getAdapter(){return adapter;}}",
  "android/location/LocationManager.java":
    "package android.location; public class LocationManager {public boolean isLocationEnabled(){return true;}}",
  "android/telephony/TelephonyManager.java":
    'package android.telephony; public class TelephonyManager {public static final int SIM_STATE_READY=5;public android.content.Context owner;public TelephonyManager(android.content.Context c){owner=c;}public int getSimState(){return owner.simState;}public boolean isDataEnabled(){if(owner.dataRefused)throw new SecurityException("refused");return true;}}',
  "android/Manifest.java":
    'package android; public final class Manifest {public static final class permission {public static final String ACCESS_NETWORK_STATE="android.permission.ACCESS_NETWORK_STATE";}}',
  "android/net/Network.java": "package android.net; public class Network {}",
  "android/net/NetworkCapabilities.java":
    "package android.net; public class NetworkCapabilities {public static final int TRANSPORT_CELLULAR=0,TRANSPORT_WIFI=1,NET_CAPABILITY_VALIDATED=16;public int hasTransport;public boolean validated=true;public boolean hasTransport(int t){return t==hasTransport;}public boolean hasCapability(int c){return c==NET_CAPABILITY_VALIDATED&&validated;}}",
  "android/net/ConnectivityManager.java":
    "package android.net; public class ConnectivityManager {public android.content.Context owner;public ConnectivityManager(android.content.Context c){owner=c;}public Network getActiveNetwork(){return owner.network?new Network():null;}public NetworkCapabilities getNetworkCapabilities(Network n){if(n==null)return null;NetworkCapabilities c=new NetworkCapabilities();c.hasTransport=NetworkCapabilities.TRANSPORT_WIFI;return c;}}",
  "android/net/Uri.java":
    "package android.net; public class Uri {private final String value;private Uri(String v){value=v;}public static Uri parse(String s){return new Uri(s);}public String toString(){return value;}}",
  "android/os/Build.java":
    "package android.os; public class Build {public static class VERSION {public static int SDK_INT=36;}public static class VERSION_CODES {public static final int P=28,S=31;}}",
  "android/os/BatteryManager.java":
    'package android.os; public class BatteryManager {public static final String EXTRA_LEVEL="level",EXTRA_SCALE="scale",EXTRA_STATUS="status";public static final int BATTERY_STATUS_CHARGING=2,BATTERY_STATUS_FULL=5;}',
  "android/os/PowerManager.java":
    "package android.os; public class PowerManager {public boolean isPowerSaveMode(){return false;}}",
  "android/provider/Settings.java":
    'package android.provider; public final class Settings {public static final String ACTION_SYNC_SETTINGS="sync",ACTION_WIFI_SETTINGS="wifi",ACTION_BLUETOOTH_SETTINGS="bluetooth",ACTION_DATA_ROAMING_SETTINGS="roaming",ACTION_WIRELESS_SETTINGS="wireless",ACTION_AIRPLANE_MODE_SETTINGS="airplane",ACTION_LOCATION_SOURCE_SETTINGS="location",ACTION_DISPLAY_SETTINGS="display",ACTION_SOUND_SETTINGS="sound",ACTION_BATTERY_SAVER_SETTINGS="battery",ACTION_DEVICE_INFO_SETTINGS="about",ACTION_APPLICATION_DEVELOPMENT_SETTINGS="developer",ACTION_APP_NOTIFICATION_SETTINGS="notifications",ACTION_APPLICATION_DETAILS_SETTINGS="details",ACTION_MANAGE_DEFAULT_APPS_SETTINGS="defaults",ACTION_ZEN_MODE_PRIORITY_SETTINGS="priority",EXTRA_APP_PACKAGE="app_package";public static class SettingNotFoundException extends Exception {}public static final class Global {public static final String WIFI_ON="wifi_on",BLUETOOTH_ON="bluetooth_on",AIRPLANE_MODE_ON="airplane_mode_on";public static java.util.Map<String,Integer> values=new java.util.HashMap<>(java.util.Map.of("wifi_on",1,"bluetooth_on",1,"airplane_mode_on",0));public static int getInt(android.content.ContentResolver r,String k)throws SettingNotFoundException{Integer v=values.get(k);if(v==null)throw new SettingNotFoundException();return v;}}public static final class System {public static final String SCREEN_BRIGHTNESS_MODE="screen_brightness_mode";public static final int SCREEN_BRIGHTNESS_MODE_MANUAL=0,SCREEN_BRIGHTNESS_MODE_AUTOMATIC=1;public static java.util.Map<String,Integer> values=new java.util.HashMap<>(java.util.Map.of("screen_brightness_mode",1));public static int getInt(android.content.ContentResolver r,String k)throws SettingNotFoundException{Integer v=values.get(k);if(v==null)throw new SettingNotFoundException();return v;}}}',
  "android/content/ContentResolver.java":
    "package android.content; public class ContentResolver {}",
  "android/content/BroadcastReceiver.java":
    "package android.content; public abstract class BroadcastReceiver {}",
  "android/content/IntentFilter.java":
    "package android.content; public class IntentFilter {public IntentFilter(String action){}}",
  "android/content/Intent.java":
    'package android.content; public class Intent {public static final String ACTION_BATTERY_CHANGED="battery";public String action;public Object data;public java.util.Map<String,Object> extras=new java.util.HashMap<>();public Intent(String a){action=a;}public Intent setData(android.net.Uri u){data=u;return this;}public Intent putExtra(String k,String v){extras.put(k,v);return this;}public int getIntExtra(String k,int d){Object v=extras.get(k);return v instanceof Integer?(Integer)v:d;}}',
  "android/content/pm/PackageManager.java":
    'package android.content.pm; public class PackageManager {public static final String FEATURE_TELEPHONY="android.hardware.telephony";public static final int PERMISSION_GRANTED=0,PERMISSION_DENIED=-1;public android.content.Context owner;public PackageManager(android.content.Context c){owner=c;}public boolean hasSystemFeature(String f){return owner.telephony&&FEATURE_TELEPHONY.equals(f);}}',
  "android/content/Context.java":
    'package android.content; public class Context {public java.util.Map<Class<?>,Object> services=new java.util.HashMap<>();public boolean telephony=true,network=true,networkStateGranted=true,dataRefused,batteryFails;public int simState=5,adapterState=12;public Context(){services.put(android.app.NotificationManager.class,new android.app.NotificationManager());services.put(android.location.LocationManager.class,new android.location.LocationManager());services.put(android.telephony.TelephonyManager.class,new android.telephony.TelephonyManager(this));services.put(android.net.ConnectivityManager.class,new android.net.ConnectivityManager(this));services.put(android.os.PowerManager.class,new android.os.PowerManager());}public ContentResolver getContentResolver(){return new ContentResolver();}public <T>T getSystemService(Class<T> type){if(type==android.bluetooth.BluetoothManager.class&&services.containsKey(android.app.NotificationManager.class))return type.cast(new android.bluetooth.BluetoothManager(new android.bluetooth.BluetoothAdapter(adapterState)));return type.cast(services.get(type));}public android.content.pm.PackageManager getPackageManager(){return new android.content.pm.PackageManager(this);}public int checkSelfPermission(String p){return networkStateGranted?0:-1;}public Intent registerReceiver(BroadcastReceiver r,IntentFilter f){if(batteryFails)throw new SecurityException("fixture");Intent i=new Intent(Intent.ACTION_BATTERY_CHANGED);i.extras.put("level",57);i.extras.put("scale",100);i.extras.put("status",2);return i;}public Object getSystemService(String name){return null;}public String getPackageName(){return "example.host";}}',
  "android/content/pm/ApplicationInfo.java":
    "package android.content.pm; public class ApplicationInfo {}",
  "android/util/Log.java":
    "package android.util; public class Log {public static int w(String tag,String message){return 0;}}",
  "android/annotation/SuppressLint.java":
    "package android.annotation; public @interface SuppressLint {String[] value();}",
};

test("system facts are omitted when unknown, pages hand off only from the allowlist, shade outcomes never claim more", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-system-facts-"));
  try {
    const files = [];
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(temp, "src", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      files.push(file);
    }
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        path.join(temp, "classes"),
        ...files,
        source("SystemFacts"),
        source("SystemSettingsPages"),
        source("SystemShade"),
        path.join(root, "test/SystemFactsTest.java"),
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          path.join(temp, "classes"),
          "ai.eliza.plugins.system.SystemFactsTest",
        ],
        { encoding: "utf8", timeout: 60000 },
      ),
      /^PASS system facts/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("system facts are read-only and request no new permission", () => {
  const facts = fs.readFileSync(source("SystemFacts"), "utf8");
  assert.doesNotMatch(
    facts,
    /Settings\.(Global|System|Secure)\.put|setWifiEnabled|\.enable\(\)|\.disable\(\)|setInterruptionFilter|setDataEnabled/,
  );
  const manifest = fs.readFileSync(
    path.join(root, "android/src/main/AndroidManifest.xml"),
    "utf8",
  );
  // Only a host holding the HOME role asks for the shade unless it overrides the policy.
  const plugin = fs.readFileSync(
    path.join(
      root,
      "android/src/main/java/ai/eliza/plugins/system/SystemPlugin.kt",
    ),
    "utf8",
  );
  const policy = plugin.slice(
    plugin.indexOf("fun canExpandNotificationShade()"),
    plugin.indexOf("fun getSystemFacts("),
  );
  assert.match(policy, /isRoleHeld\(RoleManager\.ROLE_HOME\)/);
  assert.doesNotMatch(policy, /Boolean = true/);
  assert.match(
    plugin,
    /SystemShade\.expand\(context, canExpandNotificationShade\(\)\)/,
  );
  for (const permission of [
    "ACCESS_WIFI_STATE",
    "BLUETOOTH_CONNECT",
    "READ_PHONE_STATE",
    "ACCESS_NOTIFICATION_POLICY",
    "EXPAND_STATUS_BAR",
  ])
    assert.doesNotMatch(manifest, new RegExp(permission));
});

test("only reported switches become tile or row state", () => {
  assert.deepEqual(parseSystemFacts(null), {});
  assert.deepEqual(
    parseSystemFacts({
      wifiEnabled: 1,
      bluetoothEnabled: "true",
      airplaneMode: null,
      interruptionFilter: "unknown",
      batteryPercent: 101,
      charging: true,
    }),
    { charging: true },
  );
  assert.deepEqual(
    parseSystemFacts({
      wifiEnabled: false,
      interruptionFilter: "alarms",
      batteryPercent: 0,
      extra: "x",
    }),
    { wifiEnabled: false, interruptionFilter: "alarms", batteryPercent: 0 },
  );
  const reported = {
    wifiEnabled: false,
    wifiActive: false,
    bluetoothEnabled: true,
    airplaneMode: false,
    locationEnabled: true,
    interruptionFilter: "priority",
  };
  assert.deepEqual(tileFactsFromSystemFacts(reported), {
    wifi: false,
    bt: true,
    plane: false,
    loc: true,
    dnd: true,
  });
  assert.deepEqual(tileFactsFromSystemFacts({ interruptionFilter: "all" }), {
    dnd: false,
  });
  // An active Wi-Fi transport proves on; no transport never proves off.
  assert.deepEqual(tileFactsFromSystemFacts({ wifiActive: true }), {
    wifi: true,
  });
  assert.deepEqual(tileFactsFromSystemFacts({ wifiActive: false }), {});
  assert.deepEqual(
    tileFactsFromSystemFacts({ wifiEnabled: true, wifiActive: false }),
    { wifi: true },
  );
  assert.deepEqual(tileFactsFromSystemFacts(null, false), { torch: false });
  for (const key of ["wifi", "bt", "dnd", "loc", "plane", null])
    assert.equal(tileStateText(key, undefined), "Open settings");
  assert.equal(tileStateText("torch", undefined), "Tap to switch");
  assert.equal(tileStateText("mic", undefined), "Permissions");
  assert.equal(tileStateText("wifi", false), "Off");
  assert.equal(
    tileAccessibleName("Wi-Fi", "wifi", true),
    "Wi-Fi, on, opens Android settings",
  );
  assert.equal(
    tileAccessibleName("Wi-Fi", "wifi", undefined),
    "Wi-Fi, opens Android settings",
  );
  assert.equal(
    tileAccessibleName("Microphone", "mic", undefined),
    "Microphone, opens Android permission settings",
  );
  assert.equal(tileAccessibleName("Flashlight", "torch", true), "Flashlight");
  assert.equal(SYSTEM_TILE_SETTINGS_PAGES.torch, undefined);
  assert.deepEqual(
    [
      SYSTEM_TILE_SETTINGS_PAGES.wifi,
      SYSTEM_TILE_SETTINGS_PAGES.bt,
      SYSTEM_TILE_SETTINGS_PAGES.dnd,
    ],
    ["wifi", "bluetooth", "dnd"],
  );
  assert.equal(
    switchValue(undefined, "Manage in Android"),
    "Manage in Android",
  );
  assert.equal(switchValue("true", "Not reported"), "Not reported");
  assert.equal(
    switchValue(true, "x", { on: "On · connected" }),
    "On · connected",
  );
  assert.equal(switchValue(false, "x", { on: "On · connected" }), "Off");
});

test("a broader Android page is named as such and one gesture hands off once", () => {
  assert.equal(broaderPageNotice("wifi", { specific: true }), null);
  assert.equal(broaderPageNotice("wifi", null), null);
  assert.match(
    broaderPageNotice("airplane", { specific: false }),
    /network settings/,
  );
  assert.match(
    broaderPageNotice("dnd", { specific: false }),
    /priority settings/,
  );
  assert.match(
    broaderPageNotice("location", { specific: false }),
    /related Android settings page/,
  );
  let now = 1000;
  const gate = handoffGate(2000, () => now);
  let handoffs = 0;
  for (let i = 0; i < 25; i++) {
    if (gate.begin()) handoffs++;
    now += 10;
  }
  gate.end();
  for (let i = 0; i < 25; i++) {
    if (gate.begin()) handoffs++;
    now += 10;
  }
  assert.equal(handoffs, 1);
  now += 5000;
  assert.equal(gate.begin(), true);
});

test("a browser reports no Android switch and opens no Android page", async () => {
  const { SystemWeb } = await import("../src/web.ts");
  const web = new SystemWeb();
  assert.deepEqual(await web.getSystemFacts(), {});
  await assert.rejects(
    web.openSettingsPage({ page: "wifi" }),
    /only available on Android/,
  );
  assert.deepEqual(await web.openNotificationShade(), {
    status: "unsupported",
  });
});

test("switch rows show reported states and say when Android reported nothing", () => {
  const unknown = systemSwitchRows({});
  assert.deepEqual(
    unknown.map((row) => row.page),
    ["wifi", "bluetooth", "mobile", "airplane", "location", "dnd", "battery"],
  );
  for (const row of unknown) assert.equal(row.value, "Not reported by Android");
  const rows = Object.fromEntries(
    systemSwitchRows({
      wifiEnabled: true,
      wifiActive: true,
      bluetoothEnabled: false,
      airplaneMode: false,
      mobileDataEnabled: true,
      cellularActive: false,
      locationEnabled: true,
      interruptionFilter: "all",
      batteryPercent: 42,
      charging: true,
      powerSave: true,
    }).map((row) => [row.page, row.value]),
  );
  assert.deepEqual(rows, {
    wifi: "On · connected",
    bluetooth: "Off",
    mobile: "On",
    airplane: "Off",
    location: "On",
    dnd: "Off",
    battery: "42% · charging · battery saver",
  });
  // Airplane mode explains mobile data; an active Wi-Fi transport proves Wi-Fi on without its switch.
  const flying = Object.fromEntries(
    systemSwitchRows({
      airplaneMode: true,
      mobileDataEnabled: true,
      wifiActive: true,
    }).map((row) => [row.page, row.value]),
  );
  assert.equal(flying.mobile, "Airplane mode on");
  assert.equal(flying.wifi, "On · connected");
  assert.equal(
    systemSwitchRows({ wifiActive: false })[0].value,
    "Not reported by Android",
  );
});

test("roles say whether this app holds them and never claim nobody does", () => {
  const host = { packageName: "example.host", appName: "Example" };
  assert.deepEqual(parseRoleStatuses(null), []);
  const rows = parseRoleStatuses({
    roles: [
      {
        role: "home",
        androidRole: "android.app.role.HOME",
        held: true,
        available: true,
        holders: ["example.host"],
      },
      {
        role: "assistant",
        held: false,
        available: true,
        holders: ["android", 7],
      },
      { role: "dialer", held: false, available: false, holders: [] },
      { role: "sms", held: "no", available: true },
      { role: "wallet", held: true, available: true, holders: [] },
    ],
  });
  assert.deepEqual(
    rows.map((row) => [row.role, row.holders]),
    [
      ["home", ["example.host"]],
      ["assistant", ["android"]],
      ["dialer", []],
    ],
  );
  assert.equal(androidRoleLabel(rows[0], host), "Example");
  // Android's resolver or this app as the only answer is not another holder.
  assert.equal(androidRoleLabel(rows[1], host), "Not Example");
  assert.equal(androidRoleLabel(rows[2], host), "Not available on this device");
  assert.equal(
    androidRoleLabel(
      { available: true, held: false, holders: ["other.launcher"] },
      host,
    ),
    "Another app",
  );
  assert.equal(
    androidRoleLabel({ available: true, held: false, holders: [] }, host),
    "Not Example",
  );
  assert.equal(androidRoleLabel(undefined, host), "Unavailable");
});
