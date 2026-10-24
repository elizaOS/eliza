package ai.eliza.plugins.agent.updater.policy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;

/** JVM fault suite for the OTA policy. Fake ports only: no Android, network,
 * signed-time authority or installer. */
public final class OtaPolicyTest {
 static int passed=0;
 static void check(boolean ok,String name){if(!ok)throw new AssertionError(name);passed++;}
 static void same(Object actual,Object expected,String name){if(!java.util.Objects.equals(actual,expected))throw new AssertionError(name+": expected "+expected+" got "+actual);passed++;}

 static final OtaPolicy P=OtaPolicy.DEFAULTS;
 static final ZoneId LA=ZoneId.of("America/Los_Angeles");
 static final long T0=1_792_080_000_000L; // 2026-10-15 UTC, fixture signed time.

 /** Every activation gate holds. */
 static DeviceSignals.Builder ready(){
  return new DeviceSignals.Builder().charging(true).batteryPercent(80).thermalStatus(OtaPolicy.THERMAL_NONE).idleMillis(20*OtaPolicy.MINUTE)
   .network(DeviceSignals.Network.UNMETERED).call(false).media(false).camera(false).recording(false).cast(false).navigation(false).criticalTask(false)
   .nextAlarmInMillis(DeviceSignals.NO_ALARM);
 }
 static List<String> blockers(OtaGates.Decision d){return d.blockers;}

 public static void main(String[] args)throws Exception{
  Path dir=Path.of(args[0]);
  defaults();activitySignals();downloadGate();activationGate();rebootGate();window();ledger();store(dir);engine(dir);
  System.out.println("OtaPolicy: "+passed+" assertions passed");
 }

 static void defaults(){
  same(P.discoveryIntervalMillis,6*OtaPolicy.HOUR,"6 h discovery");
  same(P.discoveryJitterMillis,15*OtaPolicy.MINUTE,"+/-15 min discovery jitter");
  check(!P.meteredDownloadsAllowed,"unmetered-only downloads by default");
  same(P.activationMinBatteryPercent,40,"activation battery >= 40%");
  same(P.maxThermalStatus,OtaPolicy.THERMAL_LIGHT,"thermal limit LIGHT");
  same(P.idleMillis,15*OtaPolicy.MINUTE,"15 min idle");
  same(P.windowStartMinute,120,"window opens 02:00");same(P.windowEndMinute,300,"window closes 05:00");
  same(P.missedWindowsBeforeDaytime,2,"daytime after two missed windows");
  same(P.rebootMinBatteryPercent,60,"reboot battery >= 60%");same(P.rebootAlarmHorizonMillis,60*OtaPolicy.MINUTE,"60 min alarm horizon");
  check(!P.qualifiedRebootRoute,"no qualified unattended reboot route");
  same(P.alertAfterMillis,72*OtaPolicy.HOUR,"72 h alert");same(P.escalateAfterMillis,7*OtaPolicy.DAY,"7 day escalation");
  rejects("zero idle",()->P.toBuilder().idleMillis(0).build());
  rejects("empty window",()->P.toBuilder().window(120,120).build());
  rejects("jitter wider than the interval",()->P.toBuilder().discovery(OtaPolicy.HOUR,30*OtaPolicy.MINUTE).build());
  rejects("battery above 100%",()->P.toBuilder().activationMinBatteryPercent(101).build());
  rejects("no missed windows",()->P.toBuilder().missedWindowsBeforeDaytime(0).build());
  rejects("escalation before the alert",()->P.toBuilder().alertAges(OtaPolicy.DAY,OtaPolicy.DAY).build());
  OtaPolicy ages=P.toBuilder().alertAges(OtaPolicy.HOUR,OtaPolicy.DAY).build();
  same(ages.alertAfterMillis,OtaPolicy.HOUR,"host alert age");same(ages.escalateAfterMillis,OtaPolicy.DAY,"host escalation age");
  OtaPolicy host=P.toBuilder().discovery(OtaPolicy.DAY,OtaPolicy.HOUR).activationMinBatteryPercent(50).missedWindowsBeforeDaytime(3).activationRecheckMillis(5*OtaPolicy.MINUTE).reboot(70,30*OtaPolicy.MINUTE).build();
  same(host.discoveryIntervalMillis,OtaPolicy.DAY,"host discovery interval");same(host.discoveryJitterMillis,OtaPolicy.HOUR,"host discovery jitter");
  same(host.activationMinBatteryPercent,50,"host activation battery");same(host.missedWindowsBeforeDaytime,3,"host missed windows");
  same(host.activationRecheckMillis,5*OtaPolicy.MINUTE,"host recheck");same(host.rebootMinBatteryPercent,70,"host reboot battery");same(host.rebootAlarmHorizonMillis,30*OtaPolicy.MINUTE,"host alarm horizon");
  same(blockers(OtaGates.activation(host,ready().batteryPercent(49).build(),ComfortWindow.State.OVERNIGHT)),List.of("battery-below-50"),"host battery threshold gates activation");
  same(ComfortWindow.state(host,LocalTime.of(14,0),2),ComfortWindow.State.CLOSED,"host needs three missed windows");
 }
 interface Body{void run()throws Exception;}
 static void rejects(String name,Body body){try{body.run();}catch(Exception expected){passed++;return;}throw new AssertionError(name+" was accepted");}

 static void activitySignals(){
  same(blockers(OtaGates.activation(P,ready().criticalTask(true).build(),ComfortWindow.State.OVERNIGHT)),List.of("critical-task-active"),"a critical task defers installation");
  same(blockers(OtaGates.activation(P,ready().criticalTask(null).navigation(null).build(),ComfortWindow.State.OVERNIGHT)),List.of("navigation-unknown","critical-task-unknown"),"unknown task and navigation defer");
  check(OtaGates.activation(P,ready().criticalTask(false).navigation(false).build(),ComfortWindow.State.OVERNIGHT).allowed,"a finished task releases installation");
 }
 static void downloadGate(){
  check(OtaGates.download(P,ready().build()).allowed,"unmetered download allowed");
  same(blockers(OtaGates.download(P,ready().network(DeviceSignals.Network.METERED).build())),List.of("network-metered"),"metered download waits");
  same(blockers(OtaGates.download(P,ready().network(DeviceSignals.Network.NONE).build())),List.of("network-none"),"offline download waits");
  same(blockers(OtaGates.download(P,ready().network(DeviceSignals.Network.UNKNOWN).build())),List.of("network-unknown"),"unknown network waits");
  same(blockers(OtaGates.download(P,ready().network(null).build())),List.of("network-unknown"),"unread network waits");
  check(OtaGates.download(P.toBuilder().meteredDownloadsAllowed(true).build(),ready().network(DeviceSignals.Network.METERED).build()).allowed,"policy-allowed metered download");
  same(blockers(OtaGates.download(P.toBuilder().meteredDownloadsAllowed(true).build(),ready().network(DeviceSignals.Network.NONE).build())),List.of("network-none"),"metered permission still needs a network");
 }

 static void activationGate(){
  ComfortWindow.State open=ComfortWindow.State.OVERNIGHT;
  check(OtaGates.activation(P,ready().build(),open).allowed,"all gates hold");
  check(OtaGates.activation(P,ready().build(),ComfortWindow.State.DAYTIME_FALLBACK).allowed,"daytime fallback is an opportunity");
  same(blockers(OtaGates.activation(P,ready().build(),ComfortWindow.State.CLOSED)),List.of("outside-window"),"closed window waits");
  same(blockers(OtaGates.activation(P,ready().build(),null)),List.of("window-unknown"),"unknown window waits");
  same(blockers(OtaGates.activation(P,ready().charging(false).build(),open)),List.of("not-charging"),"unplugged waits");
  same(blockers(OtaGates.activation(P,ready().batteryPercent(39).build(),open)),List.of("battery-below-40"),"39% waits");
  check(OtaGates.activation(P,ready().batteryPercent(40).build(),open).allowed,"40% releases");
  same(blockers(OtaGates.activation(P,ready().batteryPercent(101).build(),open)),List.of("battery-unknown"),"impossible battery is unknown");
  same(blockers(OtaGates.activation(P,ready().thermalStatus(OtaPolicy.THERMAL_MODERATE).build(),open)),List.of("thermal-unsafe"),"moderate throttling waits");
  check(OtaGates.activation(P,ready().thermalStatus(OtaPolicy.THERMAL_LIGHT).build(),open).allowed,"light thermal status releases");
  same(blockers(OtaGates.activation(P,ready().thermalStatus(-1).build(),open)),List.of("thermal-unknown"),"invalid thermal status is unknown");
  same(blockers(OtaGates.activation(P,ready().idleMillis(15*OtaPolicy.MINUTE-1).build(),open)),List.of("not-idle"),"14:59 idle waits");
  check(OtaGates.activation(P,ready().idleMillis(15*OtaPolicy.MINUTE).build(),open).allowed,"15:00 idle releases");
  same(blockers(OtaGates.activation(P,ready().idleMillis(0L).build(),open)),List.of("not-idle"),"screen on waits");
  String[] names={"call","media","camera","recording","cast","navigation","critical-task"};
  for(String name:names){
   same(blockers(OtaGates.activation(P,activity(ready(),name,true).build(),open)),List.of(name+"-active"),name+" in progress waits");
   same(blockers(OtaGates.activation(P,activity(ready(),name,null).build(),open)),List.of(name+"-unknown"),name+" unknown waits");
  }
  same(blockers(OtaGates.activation(P,ready().charging(null).batteryPercent(null).idleMillis(null).build(),open)),List.of("charging-unknown","battery-unknown","idle-unknown"),"unknown power and idle wait");
  OtaGates.Decision none=OtaGates.activation(P,DeviceSignals.unknown(),open);
  same(none.blockers.size(),11,"nothing readable: every signal defers");
  check(!none.allowed&&none.blockers.stream().allMatch(b->b.endsWith("-unknown")),"only unknown blockers");
  same(blockers(OtaGates.activation(P,ready().charging(false).batteryPercent(10).thermalStatus(OtaPolicy.THERMAL_SEVERE).media(true).build(),ComfortWindow.State.CLOSED)),
   List.of("not-charging","battery-below-40","thermal-unsafe","media-active","outside-window"),"every blocker is reported in order");
 }
 static DeviceSignals.Builder activity(DeviceSignals.Builder b,String name,Boolean v){
  switch(name){case "call":return b.call(v);case "media":return b.media(v);case "camera":return b.camera(v);case "recording":return b.recording(v);case "cast":return b.cast(v);case "navigation":return b.navigation(v);default:return b.criticalTask(v);}
 }

 static void rebootGate(){
  OtaPolicy route=P.toBuilder().qualifiedRebootRoute(true).build();
  same(blockers(OtaGates.reboot(P,ready().build())),List.of("no-qualified-reboot-route"),"no unattended reboot route by default");
  check(OtaGates.reboot(route,ready().batteryPercent(60).build()).allowed,"60% releases a qualified reboot");
  same(blockers(OtaGates.reboot(route,ready().batteryPercent(59).build())),List.of("battery-below-60"),"59% waits for reboot");
  same(blockers(OtaGates.reboot(route,ready().charging(false).build())),List.of("not-charging"),"reboot needs charging");
  same(blockers(OtaGates.reboot(route,ready().nextAlarmInMillis(60*OtaPolicy.MINUTE).build())),List.of("alarm-within-60-min"),"alarm at 60 min waits");
  check(OtaGates.reboot(route,ready().nextAlarmInMillis(60*OtaPolicy.MINUTE+1).build()).allowed,"alarm after 60 min releases");
  same(blockers(OtaGates.reboot(route,ready().nextAlarmInMillis(null).build())),List.of("alarm-unknown"),"unknown alarm waits");
  same(blockers(OtaGates.reboot(route,ready().idleMillis(1L).media(true).build())),List.of("not-idle","media-active"),"reboot needs safe idle");
 }

 static ZonedDateTime la(int y,int mo,int d,int h,int mi){return ZonedDateTime.of(LocalDateTime.of(y,mo,d,h,mi),LA);}
 static void window(){
  same(ComfortWindow.state(P,LocalTime.of(1,59),0),ComfortWindow.State.CLOSED,"01:59 closed");
  same(ComfortWindow.state(P,LocalTime.of(2,0),0),ComfortWindow.State.OVERNIGHT,"02:00 open");
  same(ComfortWindow.state(P,LocalTime.of(4,59),0),ComfortWindow.State.OVERNIGHT,"04:59 open");
  same(ComfortWindow.state(P,LocalTime.of(5,0),0),ComfortWindow.State.CLOSED,"05:00 closed");
  same(ComfortWindow.state(P,LocalTime.of(14,0),1),ComfortWindow.State.CLOSED,"one missed window keeps daytime closed");
  same(ComfortWindow.state(P,LocalTime.of(14,0),2),ComfortWindow.State.DAYTIME_FALLBACK,"two missed windows open daytime");
  same(ComfortWindow.state(P,LocalTime.of(3,0),5),ComfortWindow.State.OVERNIGHT,"overnight stays preferred");
  OtaPolicy wrap=P.toBuilder().window(23*60,1*60).build();
  check(ComfortWindow.inWindow(wrap,LocalTime.of(23,30))&&ComfortWindow.inWindow(wrap,LocalTime.of(0,30))&&!ComfortWindow.inWindow(wrap,LocalTime.of(1,0)),"window across midnight");
  same(ComfortWindow.untilOpen(P,la(2026,10,15,14,0)).toMinutes(),12L*60,"14:00 waits 12 h");
  same(ComfortWindow.untilOpen(P,la(2026,10,15,3,0)).toMillis(),0L,"open window waits 0");
  same(ComfortWindow.untilOpen(P,la(2026,10,15,5,0)).toHours(),21L,"05:00 waits until the next night");
  // 2027-03-14: 02:00 does not exist in Los Angeles; the window opens at 03:00 PDT.
  same(ComfortWindow.untilOpen(P,la(2027,3,13,23,0)).toMinutes(),3L*60,"spring-forward gap opens at the shifted instant");
  same(ComfortWindow.untilOpen(P,la(2026,11,1,0,30)).toMinutes(),150L,"fall-back night");
  same(ComfortWindow.windowsEnded(P,la(2026,10,15,4,0),la(2026,10,15,5,0),10),1,"window end at 05:00 counts");
  same(ComfortWindow.windowsEnded(P,la(2026,10,15,5,0),la(2026,10,16,4,59),10),0,"end is counted once");
  same(ComfortWindow.windowsEnded(P,la(2026,10,15,6,0),la(2026,10,17,6,0),10),2,"two nights");
  same(ComfortWindow.windowsEnded(P,la(2026,10,17,6,0),la(2026,10,15,6,0),10),0,"clock moved back counts nothing");
  same(ComfortWindow.windowsEnded(P,la(2026,1,1,0,0),la(2026,10,15,6,0),10),10,"long gaps are capped");
  same(ComfortWindow.windowsEnded(P,la(2027,3,13,6,0),la(2027,3,15,6,0),10),2,"DST spring night still ends once");
  same(ComfortWindow.windowsEnded(P,la(2026,10,31,6,0),la(2026,11,2,6,0),10),2,"DST fall night still ends once");
  ZonedDateTime tokyo=ZonedDateTime.of(LocalDateTime.of(2026,10,16,6,0),ZoneId.of("Asia/Tokyo"));
  same(ComfortWindow.windowsEnded(P,la(2026,10,15,6,0),tokyo,10),1,"a zone change counts in the new zone");
 }

 static void ledger(){
  PolicyLedger l=new PolicyLedger();
  same(l.alert(P,T0).level,PolicyLedger.Alert.Level.NONE,"no tracking, no alert");
  l.observeSigned(T0);
  same(l.alert(P,T0+72*OtaPolicy.HOUR-1).level,PolicyLedger.Alert.Level.NONE,"checks missing 71:59:59.999");
  PolicyLedger.Alert a=l.alert(P,T0+72*OtaPolicy.HOUR);
  same(a.level,PolicyLedger.Alert.Level.ALERT,"checks missing 72 h alerts");same(a.reasons,List.of("checks-missing-72h"),"missing-check reason");
  same(l.alert(P,T0+7*OtaPolicy.DAY).reasons,List.of("checks-missing-7d"),"checks missing 7 days escalates");
  same(l.alertLevel(),PolicyLedger.Alert.Level.ESCALATE,"escalation persists in the ledger");
  PolicyLedger.Alert stale=l.alert(P,null);
  check(!stale.current&&stale.level==PolicyLedger.Alert.Level.ESCALATE&&stale.reasons.contains("signed-time-unavailable"),"no signed time keeps the last level, marked not current");
  l.checked(T0+7*OtaPolicy.DAY);
  same(l.alert(P,T0+7*OtaPolicy.DAY+1).level,PolicyLedger.Alert.Level.NONE,"a successful check clears it");
  l.checked(T0);same(l.lastCheck(),T0+7*OtaPolicy.DAY,"an older check never moves lastCheck back");
  long wall=la(2026,10,15,14,0).toInstant().toEpochMilli();
  l.observePending("plan-a",T0+7*OtaPolicy.DAY,wall);
  same(l.alert(P,T0+7*OtaPolicy.DAY+72*OtaPolicy.HOUR).reasons,List.of("activation-deferred-72h","checks-missing-72h"),"deferred and missing reported together");
  l.checked(T0+7*OtaPolicy.DAY+72*OtaPolicy.HOUR);
  same(l.alert(P,T0+14*OtaPolicy.DAY).reasons,List.of("activation-deferred-7d","checks-missing-72h"),"deferred escalates at 7 days");
  same(l.alertLevel(),PolicyLedger.Alert.Level.ESCALATE,"the worse level wins");
  // Local clock jumps never move an alert: alerts read signed time only.
  l.countWindows(P,la(2030,1,1,6,0));
  same(l.alert(P,T0+7*OtaPolicy.DAY+1).reasons,List.of(),"a far-future local clock raises nothing");
  l.observePending("plan-a",T0+20*OtaPolicy.DAY,wall);
  same(l.alert(P,T0+7*OtaPolicy.DAY+71*OtaPolicy.HOUR).level,PolicyLedger.Alert.Level.NONE,"same plan keeps its first signed time");
  // Missed windows: comfort clock.
  PolicyLedger w=new PolicyLedger();w.observeSigned(T0);
  w.observePending("plan-b",T0,la(2026,10,15,14,0).toInstant().toEpochMilli());
  w.countWindows(P,la(2026,10,16,4,0));same(w.missedWindows(),0,"window still open");
  w.countWindows(P,la(2026,10,16,5,0));same(w.missedWindows(),1,"first missed window");
  w.countWindows(P,la(2026,10,16,5,0));same(w.missedWindows(),1,"re-evaluation does not double count");
  w.countWindows(P,la(2026,10,14,12,0));same(w.missedWindows(),1,"clock moved back neither counts nor uncounts");
  w.countWindows(P,la(2026,10,16,23,0));same(w.missedWindows(),1,"back to the present after a rollback");
  w.countWindows(P,la(2026,10,17,5,1));same(w.missedWindows(),2,"second missed window");
  same(ComfortWindow.state(P,LocalTime.of(14,0),w.missedWindows()),ComfortWindow.State.DAYTIME_FALLBACK,"daytime opens after two");
  w.observePending("plan-c",T0,la(2026,10,17,6,0).toInstant().toEpochMilli());same(w.missedWindows(),0,"a new plan starts over");
  for(String bad:new String[]{"sha256/abc+=","plan 1","x".repeat(257)}){
   check(!w.observePending(bad,T0,1),"id outside the contract refused: "+bad);same(w.pendingId(),"plan-c","refused id changes nothing");
  }
  check(w.observePending("x".repeat(256),T0,1),"256 characters accepted");w.observePending("plan-c",T0,1);
  w.observePending(null,T0,0);same(w.pendingId(),"","activation cleared");same(w.missedWindows(),0,"cleared plan resets missed windows");
  // Pending first seen without signed time: its age starts at the next signed time.
  PolicyLedger u=new PolicyLedger();u.observePending("plan-d",null,1);u.observeSigned(T0);
  same(u.alert(P,T0+72*OtaPolicy.HOUR).reasons,List.of("activation-deferred-72h","checks-missing-72h"),"unsigned pending ages from the next signed time");
 }

 static void store(Path dir)throws Exception{
  PolicyStore s=new PolicyStore(dir.resolve("store/ledger.properties"));
  PolicyLedger fresh=s.load();check(fresh.pendingId().isEmpty()&&fresh.alertLevel()==PolicyLedger.Alert.Level.NONE,"missing file is a fresh ledger");
  fresh.observeSigned(T0);fresh.observePending("plan-a",T0,5);fresh.record("activation-deferred",OtaGates.Decision.blocked("not-charging"));s.save(fresh);
  PolicyLedger read=s.load();
  same(read.pendingId(),"plan-a","pending survives");same(read.lastDecision(),"not-charging","decision survives");same(read.toProperties(),fresh.toProperties(),"round trip");
  check(!Files.exists(dir.resolve("store/ledger.properties.tmp")),"no temporary file left");
  Files.writeString(s.file(),"garbage = \\uZZZZ");
  PolicyLedger corrupt=s.load();check(corrupt.resetPending,"corrupt ledger resets");
  corrupt.observeSigned(T0);PolicyLedger.Alert ra=corrupt.alert(P,T0+1);
  same(ra.level,PolicyLedger.Alert.Level.ALERT,"a reset raises an alert");check(ra.reasons.contains("policy-state-reset"),"reset reason");
  same(corrupt.alert(P,T0+7*OtaPolicy.DAY).reasons,List.of("checks-missing-7d"),"reset reason ages out");
  s.save(read);String good=Files.readString(s.file(),StandardCharsets.UTF_8);
  for(String[] tamper:new String[][]{{"missedWindows=0","missedWindows=-1"},{"version=1","version=2"},{"alertLevel=NONE","alertLevel=PANIC"},{"pendingId=plan-a","pendingId=../x"},{"resetPending=false","resetPending=maybe"}}){
   check(good.contains(tamper[0]),"fixture has "+tamper[0]);Files.writeString(s.file(),good.replace(tamper[0],tamper[1]));
   check(s.load().resetPending,"tampered "+tamper[1]+" resets");
  }
  Files.writeString(s.file(),good+"extra=1\n");check(s.load().resetPending,"unknown field resets");
  Files.writeString(s.file(),good.replace("pendingId=plan-a","pendingId="));check(s.load().resetPending,"pending fields without a plan reset");
  Files.write(s.file(),new byte[PolicyStore.MAX_BYTES+1]);check(s.load().resetPending,"oversized ledger resets");
  Files.delete(s.file());Files.createDirectory(s.file());check(s.load().resetPending,"a directory in place of the ledger resets");
  rejects("save over a directory",()->s.save(read));
  Files.delete(s.file());
 }

 /** Fake ports for the engine. */
 static final class World {
  Long signed=T0;boolean signedThrows;ZonedDateTime local=la(2026,10,15,14,0);
  DeviceSignals signals=ready().build();boolean signalsThrow;
  PolicyEngine.Discovery.Result discovery=PolicyEngine.Discovery.Result.CHECKED;boolean discoveryThrows;
  String pending;boolean pendingThrows;
  PolicyEngine.Activation.Outcome activation=PolicyEngine.Activation.Outcome.NOT_ENABLED;boolean activationThrows;
  boolean cancelled;long jitter=0;
  final List<String> calls=new ArrayList<>();
  PolicyEngine engine(OtaPolicy p,PolicyStore store){
   return new PolicyEngine(p,store,
    ()->{if(signedThrows)throw new java.io.IOException("no quorum");return signed;},
    ()->local,
    ()->{if(signalsThrow)throw new SecurityException("denied");return signals;},
    permitted->{calls.add("discover:"+permitted);if(discoveryThrows)throw new java.io.IOException("tls");return discovery;},
    ()->{if(pendingThrows)throw new java.io.IOException("journal");return pending;},
    id->{calls.add("activate:"+id);if(activationThrows)throw new IllegalStateException("installer");return activation;},
    bound->{if(jitter<0||jitter>=bound)throw new AssertionError("jitter out of range");return jitter;},
    ()->cancelled);
  }
 }

 static void engine(Path dir)throws Exception{
  // Discovery cadence: 6 h +/- 15 min, bounds inclusive.
  World w=new World();PolicyStore s=new PolicyStore(dir.resolve("engine/a.properties"));
  same(w.engine(P,s).nextDiscoveryDelay(),6*OtaPolicy.HOUR-15*OtaPolicy.MINUTE,"earliest jitter");
  w.jitter=30*OtaPolicy.MINUTE;same(w.engine(P,s).nextDiscoveryDelay(),6*OtaPolicy.HOUR+15*OtaPolicy.MINUTE,"latest jitter");
  w.jitter=15*OtaPolicy.MINUTE;same(w.engine(P,s).initialDiscoveryDelay(),15*OtaPolicy.MINUTE,"first discovery within one jitter span");
  w.jitter=0;

  PolicyEngine.Plan plan=w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);
  same(w.calls,List.of("discover:false"),"discovery never permits a download");
  same(plan.discoveryDelayMillis,6*OtaPolicy.HOUR-15*OtaPolicy.MINUTE,"next discovery scheduled");
  same(plan.download,null,"no transfer, download untouched");same(plan.activationDelayMillis,null,"nothing pending, activation cancelled");
  same(s.load().lastCheck(),T0,"check recorded at signed time");

  // No signed time: discovery is not attempted and the check is not recorded.
  w.calls.clear();w.signedThrows=true;w.signed=T0+OtaPolicy.HOUR;plan=w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);
  same(w.calls,List.of(),"no signed time, no discovery");same(plan.outcome,"discovery-deferred-signed-time-unavailable","deferral outcome");
  check(!plan.alert.current,"alert marked not current");same(s.load().lastCheck(),T0,"no check recorded");
  w.signedThrows=false;w.signed=null;w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);same(w.calls,List.of(),"null signed time is unusable too");
  w.signed=-5L;w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);same(w.calls,List.of(),"nonpositive signed time is unusable");

  // Discovery failures count as missing checks and raise alerts by signed age.
  w.signed=T0+72*OtaPolicy.HOUR;w.discoveryThrows=true;plan=w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);
  same(plan.outcome,"discovery-unavailable","a throwing discovery is unavailable");same(plan.alert.reasons,List.of("checks-missing-72h"),"72 h without a check alerts");
  w.discoveryThrows=false;w.discovery=PolicyEngine.Discovery.Result.UNAVAILABLE;w.signed=T0+7*OtaPolicy.DAY;
  plan=w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);same(plan.alert.level,PolicyLedger.Alert.Level.ESCALATE,"7 days without a check escalates");

  // A queued transfer schedules the unmetered download job.
  w.discovery=PolicyEngine.Discovery.Result.TRANSFER_QUEUED;w.calls.clear();
  plan=w.engine(P,s).run(PolicyEngine.Job.DISCOVERY);same(plan.downloadDelayMillis,OtaPolicy.MINUTE,"queued transfer schedules the download in a minute");
  same(plan.alert.level,PolicyLedger.Alert.Level.NONE,"metadata check succeeded");
  for(DeviceSignals.Network n:new DeviceSignals.Network[]{DeviceSignals.Network.METERED,DeviceSignals.Network.NONE,DeviceSignals.Network.UNKNOWN}){
   w.calls.clear();w.signals=ready().network(n).build();plan=w.engine(P,s).run(PolicyEngine.Job.DOWNLOAD);
   same(w.calls,List.of(),n+" never downloads");same(plan.downloadDelayMillis,P.activationRecheckMillis,n+" keeps waiting, backed off");same(plan.outcome,"download-deferred",n+" deferral");
  }
  w.signalsThrow=true;w.calls.clear();plan=w.engine(P,s).run(PolicyEngine.Job.DOWNLOAD);
  same(w.calls,List.of(),"unreadable signals never download");same(plan.decision.blockers,List.of("network-unknown"),"unreadable is unknown");
  w.signalsThrow=false;w.signals=ready().build();w.signed=null;w.calls.clear();plan=w.engine(P,s).run(PolicyEngine.Job.DOWNLOAD);
  same(w.calls,List.of(),"no signed time, no download");same(plan.decision.blockers,List.of("signed-time-unavailable"),"signed time blocker");
  w.signed=T0+8*OtaPolicy.DAY;w.calls.clear();plan=w.engine(P,s).run(PolicyEngine.Job.DOWNLOAD);
  same(w.calls,List.of("discover:true"),"unmetered download permitted");same(plan.downloadDelayMillis,OtaPolicy.MINUTE,"still queued keeps the job");
  w.discovery=PolicyEngine.Discovery.Result.CHECKED;plan=w.engine(P,s).run(PolicyEngine.Job.DOWNLOAD);same(plan.download,Boolean.FALSE,"finished transfer cancels the job");
  same(plan.discoveryDelayMillis,null,"download leaves discovery alone");
  OtaPolicy metered=P.toBuilder().meteredDownloadsAllowed(true).build();w.signals=ready().network(DeviceSignals.Network.METERED).build();w.calls.clear();
  w.engine(metered,s).run(PolicyEngine.Job.DOWNLOAD);same(w.calls,List.of("discover:true"),"policy permits metered");

  // Activation: the port is reached only when every gate holds.
  World a=new World();PolicyStore as=new PolicyStore(dir.resolve("engine/b.properties"));
  a.pending="plan-1";a.local=la(2026,10,15,14,0);
  plan=a.engine(P,as).run(PolicyEngine.Job.DISCOVERY);
  same(plan.activationDelayMillis,12*OtaPolicy.HOUR,"pending activation waits for 02:00 local");
  plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);
  same(a.calls,List.of("discover:false"),"closed window never activates");same(plan.decision.blockers,List.of("outside-window"),"outside the window");
  a.local=la(2026,10,16,2,0);a.signals=ready().charging(false).build();a.calls.clear();
  plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);same(a.calls,List.of(),"unplugged never activates");
  same(plan.decision.blockers,List.of("not-charging"),"charging blocker");same(plan.activationDelayMillis,P.activationRecheckMillis,"recheck while the window is open");
  a.signalsThrow=true;plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);same(a.calls,List.of(),"unreadable signals never activate");same(plan.decision.blockers.size(),11,"all unknown");
  a.signalsThrow=false;a.signals=ready().build();a.signedThrows=true;plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);
  same(a.calls,List.of(),"no signed time never activates");same(plan.decision.blockers,List.of("signed-time-unavailable"),"signed time gates activation");
  a.signedThrows=false;a.pendingThrows=true;plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);
  same(a.calls,List.of(),"unreadable journal never activates");same(plan.decision.blockers,List.of("pending-unknown"),"journal readback gates activation");
  same(plan.activationDelayMillis,P.activationRecheckMillis,"unreadable journal rechecks");
  a.pendingThrows=false;a.cancelled=true;rejects("cancelled run",()->a.engine(P,as).run(PolicyEngine.Job.ACTIVATION));same(a.calls,List.of(),"cancellation before activation");
  a.cancelled=false;plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);
  same(a.calls,List.of("activate:plan-1"),"every gate holds: the port is asked");
  same(plan.outcome,"activation-not_enabled","a disabled port reports not enabled");same(plan.decision.blockers,List.of("activation-not-enabled"),"recorded as a blocker");
  same(as.load().pendingId(),"plan-1","nothing installed: still pending");
  a.calls.clear();a.activationThrows=true;plan=a.engine(P,as).run(PolicyEngine.Job.ACTIVATION);same(plan.outcome,"activation-failed","installer failure is recorded");
  a.activationThrows=false;

  // Missed windows open a daytime opportunity; alerts use signed time.
  World d=new World();PolicyStore ds=new PolicyStore(dir.resolve("engine/c.properties"));
  d.pending="plan-2";d.local=la(2026,10,15,14,0);d.engine(P,ds).run(PolicyEngine.Job.DISCOVERY);
  d.local=la(2026,10,16,14,0);d.signed=T0+OtaPolicy.DAY;plan=d.engine(P,ds).run(PolicyEngine.Job.ACTIVATION);
  same(plan.decision.blockers,List.of("outside-window"),"one missed window: daytime stays closed");same(ds.load().missedWindows(),1,"one missed");
  d.local=la(2026,10,17,14,0);d.signed=T0+2*OtaPolicy.DAY;d.calls.clear();plan=d.engine(P,ds).run(PolicyEngine.Job.ACTIVATION);
  same(ds.load().missedWindows(),2,"two missed");same(d.calls,List.of("activate:plan-2"),"daytime fallback reaches the port");
  same(plan.activationDelayMillis,P.activationRecheckMillis,"daytime rechecks");
  d.signed=T0+3*OtaPolicy.DAY;plan=d.engine(P,ds).run(PolicyEngine.Job.ACTIVATION);
  same(plan.alert.reasons,List.of("activation-deferred-72h","checks-missing-72h"),"72 h eligible-but-deferred alerts");
  d.signed=T0+7*OtaPolicy.DAY;d.discovery=PolicyEngine.Discovery.Result.CHECKED;plan=d.engine(P,ds).run(PolicyEngine.Job.DISCOVERY);
  same(plan.alert.level,PolicyLedger.Alert.Level.ESCALATE,"7 days deferred escalates");same(plan.alert.reasons,List.of("activation-deferred-7d"),"deferred reason");
  d.pending=null;plan=d.engine(P,ds).run(PolicyEngine.Job.DISCOVERY);
  same(plan.alert.level,PolicyLedger.Alert.Level.NONE,"activation readback clears the alert");same(plan.activationDelayMillis,null,"and cancels the activation job");

  // An id outside the Pending contract is unreadable: nothing is stored that the next load refuses.
  for(String bad:new String[]{"sha256/abc+=","plan 1","x".repeat(300)}){
   World b=new World();PolicyStore bs=new PolicyStore(dir.resolve("engine/bad.properties"));Files.deleteIfExists(bs.file());
   b.pending=bad;b.local=la(2026,10,17,14,0);
   for(int day=0;day<4;day++){
    b.signed=T0+day*4*OtaPolicy.DAY;b.calls.clear();plan=b.engine(P,bs).run(PolicyEngine.Job.ACTIVATION);
    same(b.calls,List.of(),bad+" never activates");same(plan.decision.blockers,List.of("pending-unknown"),bad+" is unreadable");
    same(plan.outcome,"activation-deferred",bad+" defers");check(!plan.alert.reasons.contains("policy-state-reset"),bad+" never resets the ledger");
    check(!bs.load().resetPending,bad+" saved ledger reads back");
   }
  }

  // A ledger that cannot be saved never blocks: the Plan is returned with an alert.
  World u=new World();PolicyStore us=new PolicyStore(dir.resolve("engine/unsaved.properties"));Files.createDirectory(us.file());
  plan=u.engine(P,us).run(PolicyEngine.Job.DISCOVERY);
  same(u.calls,List.of("discover:false"),"discovery runs");same(plan.discoveryDelayMillis,6*OtaPolicy.HOUR-15*OtaPolicy.MINUTE,"next discovery still planned");
  same(plan.alert.level,PolicyLedger.Alert.Level.ALERT,"unsaved state alerts");same(plan.alert.reasons,List.of("policy-state-reset","policy-state-unsaved"),"unsaved reason");
  check(Files.isDirectory(us.file()),"nothing replaced the directory");

  // A corrupt ledger never permits anything and raises an alert.
  Files.writeString(ds.file(),"version=1\n");d.pending="plan-3";d.local=la(2026,10,25,14,0);d.calls.clear();
  plan=d.engine(P,ds).run(PolicyEngine.Job.ACTIVATION);
  same(d.calls,List.of(),"reset ledger starts with zero missed windows");check(plan.alert.reasons.contains("policy-state-reset"),"reset alert");
 }
}
