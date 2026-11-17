package ai.eliza.plugins.agent.updater.policy;

/** One observation of the device signals the gates read. Every field is
 * tri-state: null means the signal is unknown (unreadable, not permitted, or
 * no qualified source), and an unknown signal always defers. */
public final class DeviceSignals {
 public enum Network {UNMETERED,METERED,NONE,UNKNOWN}
 /** nextAlarmInMillis when no alarm clock is set. */
 public static final long NO_ALARM=Long.MAX_VALUE;

 public final Boolean charging;
 public final Integer batteryPercent;
 /** android.os.PowerManager thermal status. */
 public final Integer thermalStatus;
 /** How long the screen has been off (local comfort clock); 0 while it is on. */
 public final Long idleMillis;
 public final Network network;
 /** True when the activity is in progress. */
 public final Boolean call,media,camera,recording,cast,navigation,criticalTask;
 /** Time until the next alarm clock (local clock), NO_ALARM when none is set. */
 public final Long nextAlarmInMillis;

 private DeviceSignals(Builder b){
  charging=b.charging;batteryPercent=b.batteryPercent;thermalStatus=b.thermalStatus;idleMillis=b.idleMillis;network=b.network==null?Network.UNKNOWN:b.network;
  call=b.call;media=b.media;camera=b.camera;recording=b.recording;cast=b.cast;navigation=b.navigation;criticalTask=b.criticalTask;nextAlarmInMillis=b.nextAlarmInMillis;
 }
 /** Nothing could be read: every gate defers. */
 public static DeviceSignals unknown(){return new Builder().build();}

 @Override public String toString(){
  return "charging="+charging+" battery="+batteryPercent+" thermal="+thermalStatus+" idleMs="+idleMillis+" network="+network+" call="+call+" media="+media+" camera="+camera
   +" recording="+recording+" cast="+cast+" navigation="+navigation+" criticalTask="+criticalTask+" nextAlarmMs="+(nextAlarmInMillis!=null&&nextAlarmInMillis==NO_ALARM?"none":nextAlarmInMillis);
 }

 public static final class Builder {
  Boolean charging,call,media,camera,recording,cast,navigation,criticalTask;Integer batteryPercent,thermalStatus;Long idleMillis,nextAlarmInMillis;Network network;
  public Builder charging(Boolean v){charging=v;return this;}
  public Builder batteryPercent(Integer v){batteryPercent=v;return this;}
  public Builder thermalStatus(Integer v){thermalStatus=v;return this;}
  public Builder idleMillis(Long v){idleMillis=v;return this;}
  public Builder network(Network v){network=v;return this;}
  public Builder call(Boolean v){call=v;return this;}
  public Builder media(Boolean v){media=v;return this;}
  public Builder camera(Boolean v){camera=v;return this;}
  public Builder recording(Boolean v){recording=v;return this;}
  public Builder cast(Boolean v){cast=v;return this;}
  public Builder navigation(Boolean v){navigation=v;return this;}
  public Builder criticalTask(Boolean v){criticalTask=v;return this;}
  public Builder nextAlarmInMillis(Long v){nextAlarmInMillis=v;return this;}
  public DeviceSignals build(){return new DeviceSignals(this);}
 }
}
