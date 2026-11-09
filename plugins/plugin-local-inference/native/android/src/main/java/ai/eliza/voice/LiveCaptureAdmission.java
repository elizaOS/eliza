package ai.eliza.voice;

import java.util.Collection;

/** Per-capture admission, reserved before permission/start and cancelled without waiting for startup. */
public final class LiveCaptureAdmission {
 public static final class Ticket {
  public final String id;public final long epoch;
  private boolean cancelled,discard,running,ended;
  private String reason;
  private Runnable cancel;
  public Ticket(String id,long epoch){this.id=id;this.epoch=epoch;}
 }
 private Ticket active;
 public synchronized Ticket begin(String id,long epoch){
  cancelAll();active=new Ticket(id,epoch);return active;
 }
 public synchronized boolean current(Ticket ticket){return active==ticket&&!ticket.cancelled;}
 /** Explicit Stop permits the captured tail; replacement/lifecycle cancellation discards it. */
 public synchronized boolean events(Ticket ticket){return active==ticket&&!ticket.discard;}
 public synchronized boolean attach(Ticket ticket,Runnable cancel){
  if(!current(ticket)){cancel.run();return false;}
  ticket.cancel=cancel;return true;
 }
 /** Marks a started capture running; false once its ticket was cancelled. */
 public synchronized boolean run(Ticket ticket){if(!current(ticket))return false;ticket.running=true;return true;}
 /** The capture's own end event may reach the host (once); a later pause then reports nothing. */
 public synchronized boolean end(Ticket ticket){if(!events(ticket)||ticket.ended)return false;ticket.ended=true;return true;}
 /** Cancels and discards {@code ticket} if it is still the active one. */
 public synchronized void discard(Ticket ticket){if(active==ticket)cancel(ticket,true);}
 /** Why the ticket was cancelled before it ran (for example a phone call), or null. */
 public synchronized String reason(Ticket ticket){return ticket.reason;}
 public synchronized void stop(String id){stop(id,false);}
 /** A discarded stop suppresses the captured tail and retires startup. */
 public synchronized void stop(String id,boolean discard){if(active!=null&&active.id.equals(id))cancel(active,discard);}
 public synchronized void cancelAll(){if(active!=null)cancel(active,true);}
 /**
  * Cancels a reservation that has not started, recording {@code reason}, and returns it (else null);
  * the host interrupts a running capture itself.
  */
 public synchronized Ticket interrupt(String reason){
  if(active==null||active.running||active.cancelled)return null;
  active.reason=reason;cancel(active,true);return active;
 }
 /**
  * Pause: cancels the active ticket unless it is a reservation in {@code waiting} (one held by a
  * permission prompt). Returns the running ticket whose events this ends, or null.
  */
 public synchronized Ticket pause(Collection<Ticket> waiting){
  if(active==null||!active.running&&waiting.contains(active))return null;
  Ticket ended=active.running&&!active.discard&&!active.ended?active:null;
  if(ended!=null)ended.ended=true;
  cancel(active,true);return ended;
 }
 private void cancel(Ticket ticket,boolean discard){
  ticket.cancelled=true;ticket.discard|=discard;
  if(ticket.cancel!=null){Runnable cancel=ticket.cancel;ticket.cancel=null;cancel.run();}
 }
}
