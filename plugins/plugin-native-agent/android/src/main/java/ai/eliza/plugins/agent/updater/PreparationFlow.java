package ai.eliza.plugins.agent.updater;

import java.io.IOException;

/** Preparation only: no installation or app shutdown. Each long step is fenced
 * by current journal channel/generation and installed baseline readback. */
public class PreparationFlow {
 public static final class Fence {
  public final String channel;public final long generation;public final UpdateJournal.Identity installed;public final boolean busy;
  public Fence(String channel,long generation,UpdateJournal.Identity installed,boolean busy){this.channel=channel;this.generation=generation;this.installed=installed;this.busy=busy;}
  public boolean matches(Fence other){return !other.busy&&channel.equals(other.channel)&&generation==other.generation&&installed.matches(other.installed);}
 }
 public interface Prepared {}
 public interface Staged {}
 public interface Ports {
  Fence capture()throws Exception;
  void prune()throws Exception;
  Prepared discover(Fence fence)throws Exception; // null is authenticated deferral/no new release
  Staged stage(Prepared prepared,Fence fence)throws Exception;
  void verify(Staged staged,Fence fence)throws Exception;
  void admit(Staged staged,Fence fence,JobRunRegistry.Cancellation cancellation)throws Exception;
 }
 public enum Outcome { BUSY, DEFERRED, PREPARED }
 public static Outcome run(Ports ports,JobRunRegistry.Cancellation cancellation)throws Exception {
  check(cancellation);Fence fence=ports.capture();if(fence.busy)return Outcome.BUSY;
  check(cancellation);ports.prune();fence(ports,cancellation,fence);
  Prepared prepared=ports.discover(fence);fence(ports,cancellation,fence);
  if(prepared==null)return Outcome.DEFERRED;
  Staged staged=ports.stage(prepared,fence);fence(ports,cancellation,fence);
  if(staged==null)return Outcome.DEFERRED;
  ports.verify(staged,fence);fence(ports,cancellation,fence);
  ports.admit(staged,fence,cancellation);return Outcome.PREPARED;
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
