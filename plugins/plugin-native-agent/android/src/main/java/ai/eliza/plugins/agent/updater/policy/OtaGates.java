package ai.eliza.plugins.agent.updater.policy;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Pure gate decisions. Each returns every blocker it finds, in a fixed order, so
 * a test or a status readout can see exactly why work waits. Unknown signals
 * block ("<signal>-unknown"). The gates read no clock and perform no I/O. */
public final class OtaGates {
 private OtaGates(){}

 public static final class Decision {
  public final boolean allowed;
  public final List<String> blockers;
  Decision(List<String> blockers){this.blockers=Collections.unmodifiableList(new ArrayList<>(blockers));allowed=blockers.isEmpty();}
  public static Decision blocked(String... blockers){return new Decision(Arrays.asList(blockers));}
  public Decision with(String first){List<String> next=new ArrayList<>();next.add(first);next.addAll(blockers);return new Decision(next);}
  @Override public String toString(){return allowed?"allowed":String.join(",",blockers);}
 }

 /** Payload downloads: unmetered networks only, unless the policy allows metered networks. */
 public static Decision download(OtaPolicy policy,DeviceSignals s){
  List<String> b=new ArrayList<>();
  switch(s.network){
   case UNMETERED:break;
   case METERED:if(!policy.meteredDownloadsAllowed)b.add("network-metered");break;
   case NONE:b.add("network-none");break;
   default:b.add("network-unknown");
  }
  return new Decision(b);
 }

 /** Installation (activation) of a prepared, verified update. */
 public static Decision activation(OtaPolicy policy,DeviceSignals s,ComfortWindow.State window){
  List<String> b=new ArrayList<>();
  power(b,s.charging,s.batteryPercent,policy.activationMinBatteryPercent);
  thermal(b,policy,s);
  safeIdle(b,policy,s);
  if(window==null)b.add("window-unknown");else if(window==ComfortWindow.State.CLOSED)b.add("outside-window");
  return new Decision(b);
 }

 /** OS reboot: charging, >= 60%, safe idle, no alarm within the horizon, and a
  * qualified unattended recovery route. A thermally unsafe device also waits. */
 public static Decision reboot(OtaPolicy policy,DeviceSignals s){
  List<String> b=new ArrayList<>();
  power(b,s.charging,s.batteryPercent,policy.rebootMinBatteryPercent);
  thermal(b,policy,s);
  safeIdle(b,policy,s);
  if(s.nextAlarmInMillis==null)b.add("alarm-unknown");
  else if(s.nextAlarmInMillis<=policy.rebootAlarmHorizonMillis)b.add("alarm-within-"+policy.rebootAlarmHorizonMillis/OtaPolicy.MINUTE+"-min");
  if(!policy.qualifiedRebootRoute)b.add("no-qualified-reboot-route");
  return new Decision(b);
 }

 private static void power(List<String> b,Boolean charging,Integer battery,int minimum){
  if(charging==null)b.add("charging-unknown");else if(!charging)b.add("not-charging");
  if(battery==null||battery<0||battery>100)b.add("battery-unknown");else if(battery<minimum)b.add("battery-below-"+minimum);
 }
 private static void thermal(List<String> b,OtaPolicy policy,DeviceSignals s){
  if(s.thermalStatus==null||s.thermalStatus<OtaPolicy.THERMAL_NONE||s.thermalStatus>OtaPolicy.THERMAL_SHUTDOWN)b.add("thermal-unknown");
  else if(s.thermalStatus>policy.maxThermalStatus)b.add("thermal-unsafe");
 }
 private static void safeIdle(List<String> b,OtaPolicy policy,DeviceSignals s){
  if(s.idleMillis==null||s.idleMillis<0)b.add("idle-unknown");else if(s.idleMillis<policy.idleMillis)b.add("not-idle");
  activity(b,"call",s.call);activity(b,"media",s.media);activity(b,"camera",s.camera);activity(b,"recording",s.recording);
  activity(b,"cast",s.cast);activity(b,"navigation",s.navigation);activity(b,"critical-task",s.criticalTask);
 }
 private static void activity(List<String> b,String name,Boolean active){if(active==null)b.add(name+"-unknown");else if(active)b.add(name+"-active");}
}
