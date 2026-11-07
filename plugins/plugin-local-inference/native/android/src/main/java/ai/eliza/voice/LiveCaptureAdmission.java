package ai.eliza.voice;

/** Per-capture admission, reserved before permission/start and cancelled without waiting for startup. */
public final class LiveCaptureAdmission {
 public static final class Ticket {
  public final String id;public final long epoch;
  private boolean cancelled,discard;
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
 public synchronized void stop(String id){if(active!=null&&active.id.equals(id))cancel(active,false);}
 public synchronized void cancelAll(){if(active!=null)cancel(active,true);}
 private void cancel(Ticket ticket,boolean discard){
  ticket.cancelled=true;ticket.discard|=discard;
  if(ticket.cancel!=null){Runnable cancel=ticket.cancel;ticket.cancel=null;cancel.run();}
 }
}
