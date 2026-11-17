package ai.eliza.plugins.agent.updater.policy;

/** OTA discovery, download, activation, reboot and alert policy as configuration.
 *
 * DEFAULTS holds conservative engineering defaults. A host builds its own
 * release policy through the builder; tests may shorten durations the same way.
 * These values are not hardware measurements.
 *
 * Two clocks are involved, and each value says which one it uses:
 * - signed time (a qualified source such as QualifiedClockAnchor) for trust and
 *   operations decisions: the 72 h and 7-day alert ages;
 * - the device's local wall clock and time zone for user comfort only: the
 *   02:00-05:00 window, the 15-minute idle measure and the alarm horizon.
 *   A wrong local clock can move an installation to an uncomfortable hour; it
 *   never authorizes an installation, since every other gate still applies. */
public final class OtaPolicy {
 public static final long SECOND=1000L,MINUTE=60*SECOND,HOUR=60*MINUTE,DAY=24*HOUR;
 /** android.os.PowerManager thermal status values. */
 public static final int THERMAL_NONE=0,THERMAL_LIGHT=1,THERMAL_MODERATE=2,THERMAL_SEVERE=3,THERMAL_CRITICAL=4,THERMAL_EMERGENCY=5,THERMAL_SHUTDOWN=6;

 /** Metadata discovery cadence and its symmetric jitter (+/-). */
 public final long discoveryIntervalMillis,discoveryJitterMillis;
 /** Payload downloads are unmetered-only unless the host allows metered networks. */
 public final boolean meteredDownloadsAllowed;
 /** Activation: charging is always required. */
 public final int activationMinBatteryPercent;
 /** Highest PowerManager thermal status that counts as thermally safe. LIGHT is an
  * engineering default ("no user-visible throttling"), not a hardware measurement. */
 public final int maxThermalStatus;
 /** Local comfort measure: the screen has been off this long. */
 public final long idleMillis;
 /** Local comfort window, minutes after local midnight: [start, end). */
 public final int windowStartMinute,windowEndMinute;
 /** Daytime opportunities open after this many overnight windows end with an
  * activation still pending. */
 public final int missedWindowsBeforeDaytime;
 /** How soon a pending activation is looked at again while its window is open. */
 public final long activationRecheckMillis;
 /** OS reboot gates. */
 public final int rebootMinBatteryPercent;
 public final long rebootAlarmHorizonMillis;
 /** Unattended reboot needs a qualified managed/AOSP recovery route; off by default. */
 public final boolean qualifiedRebootRoute;
 /** Signed-time ages for eligible-but-deferred activation and missing checks. */
 public final long alertAfterMillis,escalateAfterMillis;

 public static final OtaPolicy DEFAULTS=new Builder().build();

 private OtaPolicy(Builder b){
  discoveryIntervalMillis=b.discoveryIntervalMillis;discoveryJitterMillis=b.discoveryJitterMillis;meteredDownloadsAllowed=b.meteredDownloadsAllowed;
  activationMinBatteryPercent=b.activationMinBatteryPercent;maxThermalStatus=b.maxThermalStatus;idleMillis=b.idleMillis;
  windowStartMinute=b.windowStartMinute;windowEndMinute=b.windowEndMinute;missedWindowsBeforeDaytime=b.missedWindowsBeforeDaytime;activationRecheckMillis=b.activationRecheckMillis;
  rebootMinBatteryPercent=b.rebootMinBatteryPercent;rebootAlarmHorizonMillis=b.rebootAlarmHorizonMillis;qualifiedRebootRoute=b.qualifiedRebootRoute;
  alertAfterMillis=b.alertAfterMillis;escalateAfterMillis=b.escalateAfterMillis;
  if(discoveryIntervalMillis<=0||discoveryJitterMillis<0||discoveryJitterMillis*2>=discoveryIntervalMillis)throw new IllegalArgumentException("discovery cadence");
  if(activationMinBatteryPercent<0||activationMinBatteryPercent>100||rebootMinBatteryPercent<0||rebootMinBatteryPercent>100)throw new IllegalArgumentException("battery threshold");
  if(maxThermalStatus<THERMAL_NONE||maxThermalStatus>THERMAL_SHUTDOWN)throw new IllegalArgumentException("thermal limit");
  if(idleMillis<=0||activationRecheckMillis<=0||rebootAlarmHorizonMillis<0)throw new IllegalArgumentException("durations");
  if(windowStartMinute<0||windowStartMinute>=1440||windowEndMinute<0||windowEndMinute>=1440||windowStartMinute==windowEndMinute)throw new IllegalArgumentException("window");
  if(missedWindowsBeforeDaytime<1)throw new IllegalArgumentException("missed windows");
  if(alertAfterMillis<=0||escalateAfterMillis<=alertAfterMillis)throw new IllegalArgumentException("alert ages");
 }

 public Builder toBuilder(){
  Builder b=new Builder();
  b.discoveryIntervalMillis=discoveryIntervalMillis;b.discoveryJitterMillis=discoveryJitterMillis;b.meteredDownloadsAllowed=meteredDownloadsAllowed;
  b.activationMinBatteryPercent=activationMinBatteryPercent;b.maxThermalStatus=maxThermalStatus;b.idleMillis=idleMillis;
  b.windowStartMinute=windowStartMinute;b.windowEndMinute=windowEndMinute;b.missedWindowsBeforeDaytime=missedWindowsBeforeDaytime;b.activationRecheckMillis=activationRecheckMillis;
  b.rebootMinBatteryPercent=rebootMinBatteryPercent;b.rebootAlarmHorizonMillis=rebootAlarmHorizonMillis;b.qualifiedRebootRoute=qualifiedRebootRoute;
  b.alertAfterMillis=alertAfterMillis;b.escalateAfterMillis=escalateAfterMillis;return b;
 }

 /** Starts from DEFAULTS. */
 public static final class Builder {
  long discoveryIntervalMillis=6*HOUR,discoveryJitterMillis=15*MINUTE;
  boolean meteredDownloadsAllowed=false;
  int activationMinBatteryPercent=40,maxThermalStatus=THERMAL_LIGHT;
  long idleMillis=15*MINUTE;
  int windowStartMinute=2*60,windowEndMinute=5*60,missedWindowsBeforeDaytime=2;
  long activationRecheckMillis=15*MINUTE;
  int rebootMinBatteryPercent=60;long rebootAlarmHorizonMillis=60*MINUTE;boolean qualifiedRebootRoute=false;
  long alertAfterMillis=72*HOUR,escalateAfterMillis=7*DAY;
  public Builder discovery(long intervalMillis,long jitterMillis){discoveryIntervalMillis=intervalMillis;discoveryJitterMillis=jitterMillis;return this;}
  public Builder activationMinBatteryPercent(int value){activationMinBatteryPercent=value;return this;}
  public Builder idleMillis(long value){idleMillis=value;return this;}
  public Builder missedWindowsBeforeDaytime(int value){missedWindowsBeforeDaytime=value;return this;}
  public Builder activationRecheckMillis(long value){activationRecheckMillis=value;return this;}
  public Builder reboot(int minBatteryPercent,long alarmHorizonMillis){rebootMinBatteryPercent=minBatteryPercent;rebootAlarmHorizonMillis=alarmHorizonMillis;return this;}
  public Builder meteredDownloadsAllowed(boolean value){meteredDownloadsAllowed=value;return this;}
  public Builder qualifiedRebootRoute(boolean value){qualifiedRebootRoute=value;return this;}
  public Builder maxThermalStatus(int value){maxThermalStatus=value;return this;}
  public Builder window(int startMinute,int endMinute){windowStartMinute=startMinute;windowEndMinute=endMinute;return this;}
  public Builder alertAges(long alertMillis,long escalateMillis){alertAfterMillis=alertMillis;escalateAfterMillis=escalateMillis;return this;}
  public OtaPolicy build(){return new OtaPolicy(this);}
 }
}
