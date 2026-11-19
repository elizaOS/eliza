// spec/os/voice/microphone.md, "Story: Share the microphone between live capture and dictation"; spec/os/voice/microphone.md, "Story: Dictate a draft while live capture was running"
// Copied from eliza-develop plugins/plugin-local-inference/native/android/src/main/java/ai/eliza/voice/LocalMicrophoneLease.java
package ai.eliza.voice;

public final class LocalMicrophoneLease {
 public enum User{LIVE_CAPTURE,DRAFT_RECORDER}
 public enum Phase{FREE,OPENING,RUNNING,CLOSING,UNCONFIRMED}
 public enum Refusal{NONE,SLOT_BUSY,FENCED_REOPEN}
 public enum Draft{NONE,DRAINING,ADMITTED,REFUSED}
 public enum Report{UNREPORTED,STARTED,ENDED}

 public static final class Refused extends IllegalStateException {
  public final Refusal refusal;
  Refused(Refusal refusal){super(refusal==Refusal.FENCED_REOPEN?"Microphone reopen is fenced by a draft":"Microphone is in use");this.refusal=refusal;}
 }

 public static final class Snapshot {
  public final User user;public final Phase phase;public final long token,issued;public final Refusal refusal;public final boolean reopenFenced;public final Draft draft;public final Report report;
  Snapshot(User user,Phase phase,long token,long issued,Refusal refusal,boolean reopenFenced,Draft draft,Report report){
   this.user=user;this.phase=phase;this.token=token;this.issued=issued;this.refusal=refusal;this.reopenFenced=reopenFenced;this.draft=draft;this.report=report;
  }
 }

 public static final class Slot {
  private LocalMicrophoneLease holder;
  private Phase phase=Phase.FREE;
  private long issued;
  private Refusal refusal=Refusal.NONE;
  private boolean reopenFenced;
  private Draft draft=Draft.NONE;
  private Report report=Report.UNREPORTED;
  private Runnable admitted,refused;

  public LocalMicrophoneLease reserve(User user,boolean reopen,Runnable stop){
   if(user==null||reopen&&user!=User.LIVE_CAPTURE)throw new IllegalArgumentException("Only live capture reopens the microphone");
   synchronized(this){
    if(phase!=Phase.FREE){refusal=Refusal.SLOT_BUSY;throw new Refused(Refusal.SLOT_BUSY);}
    if(reopen&&reopenFenced){refusal=Refusal.FENCED_REOPEN;throw new Refused(Refusal.FENCED_REOPEN);}
    holder=new LocalMicrophoneLease(this,user,++issued,stop);
    phase=Phase.OPENING;refusal=Refusal.NONE;reopenFenced=reopenFenced&&user==User.DRAFT_RECORDER;report=Report.UNREPORTED;
    if(draft==Draft.ADMITTED)draft=Draft.NONE;
    return holder;
   }
  }

  public boolean requestDraft(Runnable admitted,Runnable refused){
   Runnable now,stop=null;
   synchronized(this){
    if(draft==Draft.DRAINING||holder!=null&&holder.user==User.DRAFT_RECORDER)return false;
    reopenFenced=true;
    switch(phase){
     case FREE->{draft=Draft.ADMITTED;now=admitted;}
     case UNCONFIRMED->{draft=Draft.REFUSED;now=refused;}
     case OPENING,RUNNING,CLOSING->{
      phase=Phase.CLOSING;draft=Draft.DRAINING;
      if(report==Report.STARTED)report=Report.ENDED;
      this.admitted=admitted;this.refused=refused;now=null;stop=holder.stop;
     }
     default->throw new IllegalStateException("Unknown microphone phase "+phase);
    }
   }
   if(now!=null)now.run();
   if(stop!=null)stop.run();
   return true;
  }

  public synchronized Snapshot snapshot(){
   return new Snapshot(holder==null?null:holder.user,phase,holder==null?0:holder.token,issued,refusal,reopenFenced,draft,report);
  }

  private synchronized boolean opened(LocalMicrophoneLease lease){
   if(holder!=lease||phase!=Phase.OPENING)return false;
   phase=Phase.RUNNING;
   if(lease.user==User.LIVE_CAPTURE)report=Report.STARTED;
   return true;
  }

  private synchronized boolean cancel(LocalMicrophoneLease lease){
   if(holder!=lease||phase!=Phase.OPENING&&phase!=Phase.RUNNING)return false;
   phase=Phase.CLOSING;
   if(report==Report.STARTED)report=Report.ENDED;
   return true;
  }

  private boolean released(long token){
   Runnable handoff=null;
   synchronized(this){
    boolean receipt=phase==Phase.OPENING||phase==Phase.CLOSING||phase==Phase.UNCONFIRMED&&holder.user==User.DRAFT_RECORDER;
    if(token<1||token>issued||!receipt)return false;
    if(token==holder.token){
     holder=null;phase=Phase.FREE;
     if(draft==Draft.DRAINING){draft=Draft.ADMITTED;handoff=admitted;admitted=null;refused=null;}
    }
   }
   if(handoff!=null)handoff.run();
   return true;
  }

  private boolean releaseUnconfirmed(LocalMicrophoneLease lease){
   Runnable handoff=null;
   synchronized(this){
    if(holder!=lease||phase!=Phase.OPENING&&phase!=Phase.CLOSING)return false;
    phase=Phase.UNCONFIRMED;
    if(draft==Draft.DRAINING){draft=Draft.REFUSED;handoff=refused;admitted=null;refused=null;}
   }
   if(handoff!=null)handoff.run();
   return true;
  }
 }

 public static final Slot PROCESS=new Slot();

 private final Slot slot;
 private final Runnable stop;
 public final User user;
 public final long token;

 private LocalMicrophoneLease(Slot slot,User user,long token,Runnable stop){
  this.slot=slot;this.user=user;this.token=token;this.stop=stop==null?()->{}:stop;
 }

 public boolean opened(){return slot.opened(this);}
 public boolean cancel(){return slot.cancel(this);}
 public boolean release(){return slot.released(token);}
 public boolean releaseUnconfirmed(){return slot.releaseUnconfirmed(this);}
}
