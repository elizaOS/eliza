package ai.eliza.plugins.agent.updater.policy;

import java.io.IOException;
import java.time.ZonedDateTime;
import java.util.function.BooleanSupplier;

/** One policy run for one scheduled job. Pure: every clock, signal, discovery,
 * journal and installer effect is a port, so the JVM fault suite drives it.
 *
 * - DISCOVERY wakes every 6 h +/- jitter on any network. It needs signed time
 *   and never permits a payload download.
 * - DOWNLOAD runs only when discovery queued a transfer, and only proceeds on an
 *   unmetered network (or a metered one when the policy allows it).
 * - ACTIVATION evaluates the installation gates for a prepared update. It calls
 *   the Activation port only when every gate holds. A host that has not
 *   enabled installation binds a port that reports NOT_ENABLED.
 * The run returns a Plan for the scheduler; the alert is computed every run. */
public final class PolicyEngine {
 public enum Job {DISCOVERY,DOWNLOAD,ACTIVATION}

 /** Signed time: the interval's lower bound, or null when no usable signed time. */
 public interface SignedClock {Long lowerBound()throws Exception;}
 /** Local wall clock and zone, for comfort windows only. */
 public interface ComfortClock {ZonedDateTime local();}
 public interface Signals {DeviceSignals read()throws Exception;}
 public interface Discovery {
  enum Result {CHECKED,TRANSFER_QUEUED,UNAVAILABLE}
  /** downloadPermitted is false on DISCOVERY runs and true only after the download gate passed. */
  Result discover(boolean downloadPermitted)throws Exception;
 }
 /** The prepared plan awaiting activation, or null/empty when none. */
 public interface Pending {String preparedId()throws Exception;}
 public interface Activation {
  enum Outcome {NOT_ENABLED,STARTED,FAILED}
  Outcome activate(String preparedId)throws Exception;
 }
 /** Uniform in [0, bound). */
 public interface Jitter {long next(long bound);}

 public static final class Plan {
  public final Job job;
  /** Next discovery wakeup; null leaves the existing one. */
  public final Long discoveryDelayMillis;
  /** TRUE schedules the unmetered download job, FALSE cancels it, null leaves it. */
  public final Boolean download;
  /** Earliest next download run when download is TRUE, else null. */
  public final Long downloadDelayMillis;
  /** Next activation evaluation; null cancels it (nothing pending). */
  public final Long activationDelayMillis;
  public final PolicyLedger.Alert alert;
  /** Gate decision of this run (download or activation), or null. */
  public final OtaGates.Decision decision;
  public final String outcome;
  Plan(Job job,Long discovery,Boolean download,Long downloadDelay,Long activation,PolicyLedger.Alert alert,OtaGates.Decision decision,String outcome){
   this.job=job;discoveryDelayMillis=discovery;this.download=download;downloadDelayMillis=downloadDelay;activationDelayMillis=activation;this.alert=alert;this.decision=decision;this.outcome=outcome;
  }
  @Override public String toString(){return job+" "+outcome+" decision="+decision+" alert="+alert+" next(discovery="+discoveryDelayMillis+",download="+download+"@"+downloadDelayMillis+",activation="+activationDelayMillis+")";}
 }

 private final OtaPolicy policy;private final PolicyStore store;private final SignedClock signed;private final ComfortClock comfort;
 private final Signals signals;private final Discovery discovery;private final Pending pending;private final Activation activation;private final Jitter jitter;private final BooleanSupplier cancelled;

 public PolicyEngine(OtaPolicy policy,PolicyStore store,SignedClock signed,ComfortClock comfort,Signals signals,Discovery discovery,Pending pending,Activation activation,Jitter jitter,BooleanSupplier cancelled){
  this.policy=policy;this.store=store;this.signed=signed;this.comfort=comfort;this.signals=signals;this.discovery=discovery;this.pending=pending;this.activation=activation;this.jitter=jitter;this.cancelled=cancelled;
 }

 /** The first discovery after enrollment or boot: within one jitter span. */
 public long initialDiscoveryDelay(){return jitter.next(policy.discoveryJitterMillis+1);}
 /** 6 h +/- jitter. */
 public long nextDiscoveryDelay(){return policy.discoveryIntervalMillis-policy.discoveryJitterMillis+jitter.next(2*policy.discoveryJitterMillis+1);}

 public Plan run(Job job)throws IOException {
  PolicyLedger ledger=store.load();
  Long now=signedLower();
  ZonedDateTime local=comfort.local();
  if(now!=null)ledger.observeSigned(now);
  String outcome;OtaGates.Decision decision=null;Boolean download=null;Long downloadDelay=null;Long discoveryDelay=null;
  switch(job){
   case DISCOVERY:{
    discoveryDelay=nextDiscoveryDelay();
    if(now==null){outcome="discovery-deferred-signed-time-unavailable";break;}
    check();Discovery.Result result=discover(false);outcome="discovery-"+result.name().toLowerCase(java.util.Locale.ROOT);
    if(result!=Discovery.Result.UNAVAILABLE)ledger.checked(now);
    if(result==Discovery.Result.TRANSFER_QUEUED){download=Boolean.TRUE;downloadDelay=OtaPolicy.MINUTE;}
    break;
   }
   case DOWNLOAD:{
    decision=OtaGates.download(policy,readSignals());
    if(now==null)decision=decision.with("signed-time-unavailable");
    if(!decision.allowed){outcome="download-deferred";download=Boolean.TRUE;downloadDelay=policy.activationRecheckMillis;break;}
    check();Discovery.Result result=discover(true);outcome="download-"+result.name().toLowerCase(java.util.Locale.ROOT);
    if(result!=Discovery.Result.UNAVAILABLE)ledger.checked(now);
    download=result==Discovery.Result.CHECKED?Boolean.FALSE:Boolean.TRUE;
    if(result==Discovery.Result.TRANSFER_QUEUED)downloadDelay=OtaPolicy.MINUTE;
    else if(result==Discovery.Result.UNAVAILABLE)downloadDelay=policy.activationRecheckMillis;
    break;
   }
   default:outcome="no-pending-activation";
  }
  String prepared=null;boolean pendingKnown=true;
  try{prepared=pending.preparedId();}catch(Exception unreadable){pendingKnown=false;}
  if(pendingKnown)ledger.observePending(prepared,now,local.toInstant().toEpochMilli());
  ledger.countWindows(policy,local);
  Long activationDelay=null;
  if(!ledger.pendingId().isEmpty()){
   ComfortWindow.State window=ComfortWindow.state(policy,local.toLocalTime(),ledger.missedWindows());
   if(job==Job.ACTIVATION){
    decision=OtaGates.activation(policy,readSignals(),window);
    if(now==null)decision=decision.with("signed-time-unavailable");
    if(!pendingKnown)decision=decision.with("pending-unknown");
    if(decision.allowed){
     check();Activation.Outcome result;
     try{result=activation.activate(ledger.pendingId());}catch(Exception failure){result=Activation.Outcome.FAILED;}
     outcome="activation-"+result.name().toLowerCase(java.util.Locale.ROOT);
     if(result==Activation.Outcome.NOT_ENABLED)decision=OtaGates.Decision.blocked("activation-not-enabled");
    }else outcome="activation-deferred";
   }
   activationDelay=window==ComfortWindow.State.CLOSED?Math.max(OtaPolicy.MINUTE,ComfortWindow.untilOpen(policy,local).toMillis()):policy.activationRecheckMillis;
  }
  if(!pendingKnown&&activationDelay==null)activationDelay=policy.activationRecheckMillis;
  PolicyLedger.Alert alert=ledger.alert(policy,now);
  ledger.record(outcome,decision);
  store.save(ledger);
  return new Plan(job,discoveryDelay,download,downloadDelay,activationDelay,alert,decision,outcome);
 }

 private Long signedLower(){
  try{Long value=signed.lowerBound();return value!=null&&value>0?value:null;}
  catch(Exception unavailable){return null;}
 }
 private DeviceSignals readSignals(){
  try{DeviceSignals value=signals.read();return value==null?DeviceSignals.unknown():value;}
  catch(Exception unreadable){return DeviceSignals.unknown();}
 }
 private Discovery.Result discover(boolean permitted){
  try{Discovery.Result value=discovery.discover(permitted);return value==null?Discovery.Result.UNAVAILABLE:value;}
  catch(Exception failure){return Discovery.Result.UNAVAILABLE;}
 }
 private void check()throws IOException {if(cancelled.getAsBoolean())throw new IOException("Policy run cancelled");}
}
