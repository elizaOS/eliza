package ai.eliza.plugins.agent.updater.policy;

import java.io.IOException;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Properties;

/** Durable policy state: the pending activation, missed overnight windows, the
 * last successful check and the alert signal.
 *
 * Signed-time fields (trackingSince, lastCheck, pendingSince, resetSince) hold the
 * lower bound of the updater's signed-time interval and alone decide alert ages.
 * Wall-clock fields (pendingSinceWall, windowsThroughWall) hold the local clock
 * and only count missed comfort windows. */
public final class PolicyLedger {
 static final int VERSION=1;
 static final int MISSED_CAP=1000;

 public static final class Alert {
  public enum Level {NONE,ALERT,ESCALATE}
  public final Level level;
  public final List<String> reasons;
  /** False when this run had no signed time: the level is the last one computed. */
  public final boolean current;
  Alert(Level level,List<String> reasons,boolean current){this.level=level;this.reasons=Collections.unmodifiableList(new ArrayList<>(reasons));this.current=current;}
  @Override public String toString(){return level+(reasons.isEmpty()?"":" "+String.join(",",reasons))+(current?"":" (not current)");}
 }

 long trackingSince,lastCheck,pendingSince,pendingSinceWall,windowsThroughWall,resetSince;
 String pendingId="";
 int missedWindows;
 boolean resetPending;
 Alert.Level alertLevel=Alert.Level.NONE;
 String alertReasons="",lastOutcome="",lastDecision="";

 public String pendingId(){return pendingId;}
 public int missedWindows(){return missedWindows;}
 public long lastCheck(){return lastCheck;}
 public String lastOutcome(){return lastOutcome;}
 public String lastDecision(){return lastDecision;}
 public Alert.Level alertLevel(){return alertLevel;}

 /** A fresh ledger that replaced unreadable state; it raises an alert until it ages out. */
 static PolicyLedger reset(){PolicyLedger l=new PolicyLedger();l.resetPending=true;return l;}

 void observeSigned(long lower){
  if(lower<=0)throw new IllegalArgumentException("signed time");
  if(trackingSince==0)trackingSince=lower;
  if(!pendingId.isEmpty()&&pendingSince==0)pendingSince=lower;
  if(resetPending){resetSince=lower;resetPending=false;}
 }
 void checked(long lower){lastCheck=Math.max(lastCheck,lower);}

 /** id is the prepared plan awaiting activation, or empty when none. */
 void observePending(String id,Long signedLower,long wallNow){
  if(id==null||id.isEmpty()){pendingId="";pendingSince=0;pendingSinceWall=0;windowsThroughWall=0;missedWindows=0;return;}
  if(id.equals(pendingId))return;
  pendingId=id;pendingSince=signedLower==null?0:signedLower;pendingSinceWall=wallNow;windowsThroughWall=wallNow;missedWindows=0;
 }

 /** Local comfort clock only. A clock moved backwards counts nothing and never uncounts. */
 void countWindows(OtaPolicy policy,ZonedDateTime now){
  if(pendingId.isEmpty())return;
  long nowWall=now.toInstant().toEpochMilli(),from=Math.max(pendingSinceWall,windowsThroughWall);
  int ended=ComfortWindow.windowsEnded(policy,ZonedDateTime.ofInstant(Instant.ofEpochMilli(from),now.getZone()),now,MISSED_CAP);
  missedWindows=(int)Math.min(MISSED_CAP,(long)missedWindows+ended);
  windowsThroughWall=Math.max(windowsThroughWall,nowWall);
 }

 /** Signed time only. Without it the last level stands and is marked not current. */
 Alert alert(OtaPolicy policy,Long signedLower){
  if(signedLower==null){
   List<String> reasons=new ArrayList<>(split(alertReasons));if(!reasons.contains("signed-time-unavailable"))reasons.add("signed-time-unavailable");
   return new Alert(alertLevel,reasons,false);
  }
  long now=signedLower;Alert.Level level=Alert.Level.NONE;List<String> reasons=new ArrayList<>();
  if(!pendingId.isEmpty()&&pendingSince>0)level=age(policy,now-pendingSince,"activation-deferred",reasons,level);
  long reference=lastCheck>0?lastCheck:trackingSince;
  if(reference>0)level=age(policy,now-reference,"checks-missing",reasons,level);
  if(resetSince>0&&now-resetSince<policy.escalateAfterMillis){reasons.add("policy-state-reset");if(level==Alert.Level.NONE)level=Alert.Level.ALERT;}
  alertLevel=level;alertReasons=String.join(",",reasons);
  return new Alert(level,reasons,true);
 }
 private static Alert.Level age(OtaPolicy policy,long age,String name,List<String> reasons,Alert.Level level){
  if(age>=policy.escalateAfterMillis){reasons.add(name+"-7d");return Alert.Level.ESCALATE;}
  if(age>=policy.alertAfterMillis){reasons.add(name+"-72h");return level==Alert.Level.ESCALATE?level:Alert.Level.ALERT;}
  return level;
 }

 void record(String outcome,OtaGates.Decision decision){lastOutcome=outcome==null?"":outcome;lastDecision=decision==null?"":decision.toString();}

 Properties toProperties(){
  Properties p=new Properties();
  p.setProperty("version",Integer.toString(VERSION));
  p.setProperty("trackingSince",Long.toString(trackingSince));p.setProperty("lastCheck",Long.toString(lastCheck));
  p.setProperty("pendingId",pendingId);p.setProperty("pendingSince",Long.toString(pendingSince));
  p.setProperty("pendingSinceWall",Long.toString(pendingSinceWall));p.setProperty("windowsThroughWall",Long.toString(windowsThroughWall));
  p.setProperty("missedWindows",Integer.toString(missedWindows));
  p.setProperty("resetSince",Long.toString(resetSince));p.setProperty("resetPending",Boolean.toString(resetPending));
  p.setProperty("alertLevel",alertLevel.name());p.setProperty("alertReasons",alertReasons);
  p.setProperty("lastOutcome",lastOutcome);p.setProperty("lastDecision",lastDecision);
  return p;
 }
 static PolicyLedger fromProperties(Properties p)throws IOException {
  try{
   if(VERSION!=Integer.parseInt(required(p,"version")))throw new IOException("Unsupported policy ledger version");
   PolicyLedger l=new PolicyLedger();
   l.trackingSince=nonNegative(p,"trackingSince");l.lastCheck=nonNegative(p,"lastCheck");
   l.pendingId=required(p,"pendingId");l.pendingSince=nonNegative(p,"pendingSince");
   l.pendingSinceWall=nonNegative(p,"pendingSinceWall");l.windowsThroughWall=nonNegative(p,"windowsThroughWall");
   long missed=nonNegative(p,"missedWindows");if(missed>MISSED_CAP)throw new IOException("missedWindows");l.missedWindows=(int)missed;
   l.resetSince=nonNegative(p,"resetSince");
   String resetPending=required(p,"resetPending");if(!resetPending.equals("true")&&!resetPending.equals("false"))throw new IOException("resetPending");l.resetPending=Boolean.parseBoolean(resetPending);
   l.alertLevel=Alert.Level.valueOf(required(p,"alertLevel"));l.alertReasons=required(p,"alertReasons");
   l.lastOutcome=required(p,"lastOutcome");l.lastDecision=required(p,"lastDecision");
   if(l.pendingId.length()>256||!l.pendingId.matches("[A-Za-z0-9._:-]*"))throw new IOException("pendingId");
   if(l.pendingId.isEmpty()&&(l.pendingSince!=0||l.pendingSinceWall!=0||l.windowsThroughWall!=0||l.missedWindows!=0))throw new IOException("Pending fields without a pending activation");
   if(p.size()!=14)throw new IOException("Unexpected policy ledger fields");
   return l;
  }catch(IllegalArgumentException invalid){throw new IOException("Invalid policy ledger",invalid);}
 }
 private static String required(Properties p,String key)throws IOException{String v=p.getProperty(key);if(v==null)throw new IOException("Missing "+key);return v;}
 private static long nonNegative(Properties p,String key)throws IOException{long v=Long.parseLong(required(p,key));if(v<0)throw new IOException("Negative "+key);return v;}
 private static List<String> split(String value){return value.isEmpty()?Collections.<String>emptyList():Arrays.asList(value.split(","));}
}
