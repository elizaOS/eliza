package ai.eliza.plugins.agent.updater;

import java.io.IOException;
import java.util.Set;

/** Preparation only: no installation or app shutdown. Each long step is fenced
 * by current journal channel/generation and installed baseline readback. A
 * VERIFIED plan is refreshed instead of prepared, and a RECOVERY_READY plan
 * whose recovery can never load gives way to discovery. */
public class PreparationFlow {
 public static final class Fence {
  public final String channel,planId;public final long generation;public final UpdateJournal.Identity installed;public final UpdateJournal.Phase phase;public final boolean busy;
  /** planId is the journal's plan, or null. */
  public Fence(String channel,long generation,UpdateJournal.Identity installed,UpdateJournal.Phase phase,String planId){this.channel=channel;this.generation=generation;this.installed=installed;this.phase=phase;this.planId=planId;busy=busy(phase);}
  public boolean matches(Fence other){return !other.busy&&channel.equals(other.channel)&&generation==other.generation&&installed.matches(other.installed);}
 }
 /** Discovery waits while a plan is admitted or an install or recovery is under way. */
 public static boolean busy(UpdateJournal.Phase phase){
  return phase!=UpdateJournal.Phase.IDLE&&phase!=UpdateJournal.Phase.STAGING&&phase!=UpdateJournal.Phase.HEALTHY&&phase!=UpdateJournal.Phase.RECOVERED&&phase!=UpdateJournal.Phase.QUARANTINED;
 }
 /** Commit decisions that end a VERIFIED plan for good. Others, such as
  * stale-metadata, wait for a later refresh. */
 public static final Set<String> DISCARDS=Set.of("expired","revoked-artifact","below-security-floor","superseded");
 /** Recovery decisions that revocations or floors keep for good. Lost
  * prepared or admission state is an error, not one of these: the wait goes on
  * and is reported, since state loss is not evidence the recovery is unsafe. */
 public static final Set<String> RECOVERY_REFUSALS=Set.of("revoked-artifact","below-security-floor");
 public interface Prepared {}
 public interface Staged {}
 public interface Ports {
  Fence capture()throws Exception;
  void prune()throws Exception;
  Prepared discover(Fence fence)throws Exception; // null is authenticated deferral/no new release
  Staged stage(Prepared prepared,Fence fence)throws Exception;
  void verify(Staged staged,Fence fence)throws Exception;
  void admit(Staged staged,Fence fence,JobRunRegistry.Cancellation cancellation)throws Exception;
  /** Fetches and authenticates metadata for the VERIFIED plan; stages nothing.
   * A failed fetch defers; an unreadable trust cache throws. */
  void refresh(Fence fence)throws Exception;
  /** EvaluatePreparedForCommit for the VERIFIED plan now, with no refresh bound. */
  String commitDecision(Fence fence)throws Exception;
  void discardVerified(Fence fence,String reason)throws Exception;
  /** EvaluatePreparedRecovery for the RECOVERY_READY plan. */
  String recoveryDecision(Fence fence)throws Exception;
  void recoveryUnavailable(Fence fence,String reason)throws Exception;
 }
 public enum Outcome { BUSY, DEFERRED, PREPARED, REFRESHED, DISCARDED }
 public static Outcome run(Ports ports,JobRunRegistry.Cancellation cancellation)throws Exception {
  check(cancellation);Fence fence=ports.capture();
  if(fence.phase==UpdateJournal.Phase.VERIFIED)return refreshVerified(ports,cancellation,fence);
  if(fence.phase==UpdateJournal.Phase.RECOVERY_READY) {
   String decision=ports.recoveryDecision(fence);check(cancellation);
   if(!RECOVERY_REFUSALS.contains(decision))return Outcome.BUSY;
   // The failed candidate stays installed; only a newer release can fix it.
   ports.recoveryUnavailable(fence,decision);fence=ports.capture();
  }
  if(fence.busy)return Outcome.BUSY;
  check(cancellation);ports.prune();fence(ports,cancellation,fence);
  Prepared prepared=ports.discover(fence);fence(ports,cancellation,fence);
  if(prepared==null)return Outcome.DEFERRED;
  Staged staged=ports.stage(prepared,fence);fence(ports,cancellation,fence);
  if(staged==null)return Outcome.DEFERRED;
  ports.verify(staged,fence);fence(ports,cancellation,fence);
  ports.admit(staged,fence,cancellation);return Outcome.PREPARED;
 }
 /** Admission is not a lasting permission: a refresh can show the plan may no
  * longer install, and the journal then drops it. */
 private static Outcome refreshVerified(Ports ports,JobRunRegistry.Cancellation cancellation,Fence fence)throws Exception {
  ports.refresh(fence);check(cancellation);
  String decision=ports.commitDecision(fence);check(cancellation);
  if(!DISCARDS.contains(decision))return Outcome.REFRESHED;
  ports.discardVerified(fence,decision);return Outcome.DISCARDED;
 }
 private static void fence(Ports ports,JobRunRegistry.Cancellation cancellation,Fence original)throws Exception {
  check(cancellation);if(!original.matches(ports.capture()))throw new IOException("Preparation observations changed");check(cancellation);
 }
 public static void check(JobRunRegistry.Cancellation cancellation)throws IOException {
  if(cancellation.isCancelled()||Thread.currentThread().isInterrupted())throw new IOException("Preparation cancelled");
 }
 /** One nonblocking cancellation hook follows successive native resources.
  * Registration after cancellation closes immediately; retired resources cannot
  * accidentally replace the next step's cancellation target. */
 public static final class Resources implements AutoCloseable {
  private Runnable active;private boolean cancelled;
  public synchronized void attach(Runnable close)throws IOException {
   if(cancelled){close.run();throw new IOException("Preparation cancelled");}
   if(active!=null)throw new IllegalStateException("Preparation resource already active");active=close;
  }
  public void release(){Runnable close;synchronized(this){close=active;active=null;}if(close!=null)close.run();}
  @Override public void close(){Runnable close;synchronized(this){cancelled=true;close=active;active=null;}if(close!=null)close.run();}
 }
}
