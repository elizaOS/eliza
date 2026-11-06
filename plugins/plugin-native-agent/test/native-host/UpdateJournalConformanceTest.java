package ai.eliza.plugins.agent.updater;
import java.io.IOException;
import java.util.*;
/** Drives the real UpdateJournal, with its real codec, through every recipe state
 * crossed with every event, and compares each result with a reference step. The
 * reference is a line-by-line copy of the Step operator of the OtaInstallJournal
 * TLA+ model, so a change to either side shows up as a numbered difference.
 * Model identities are version codes: the baseline is 1, plan p has candidate
 * 2p and recovery 2p+1, and 9 is a package nobody planned. */
public final class UpdateJournalConformanceTest {
  record Event(String kind,int plan,long base,long installed,long generation,int session,boolean pending,String blocked,String outcome) {
    @Override public String toString(){return kind+"(p="+plan+",base="+base+",inst="+installed+",g="+generation+",s="+session+",pending="+pending+",blocked="+blocked+",outcome="+outcome+")";}
  }
  /** The model's journal: UpdateJournal.State without revision, channel or timing. */
  static final class J {
    String phase="IDLE",reason="";int plan,session,attempts;long base,gen;TreeSet<Long> q=new TreeSet<>();
    J copy(){J c=new J();c.phase=phase;c.reason=reason;c.plan=plan;c.session=session;c.attempts=attempts;c.base=base;c.gen=gen;c.q=new TreeSet<>(q);return c;}
    String key(){return phase.equals("REFUSED")?"REFUSED":phase+"|"+reason+"|"+plan+"|"+base+"|"+session+"|"+attempts+"|"+gen+"|"+q;}
    J cleared(String phase,String reason){J c=copy();c.phase=phase;c.reason=reason;c.plan=0;c.base=0;c.session=0;return c;}
  }
  static final J REFUSED=refused();
  static J refused(){J j=new J();j.phase="REFUSED";return j;}
  static final Set<String> ACTIVE=Set.of("STAGING","VERIFIED","COMMITTING","PROBATION","RECOVERY_READY","RECOVERING","RECOVERY_PROBATION","SUPPORT");
  static final Set<String> AWAIT=Set.of("user_action_required","policy_blocked","install_timeout","install_clock_invalid");
  static long cand(int p){return 2L*p;}
  static long rec(int p){return 2L*p+1;}
  static boolean awaiting(J j){return j.phase.equals("COMMITTING")||j.phase.equals("RECOVERING")||(j.phase.equals("SUPPORT")&&AWAIT.contains(j.reason));}

  static J stepReconcile(J j,Event e) {
    if(!awaiting(j)||j.plan==0||j.plan!=e.plan||j.session!=e.session)return j;
    boolean wasBlocked=j.phase.equals("SUPPORT"),recovering=j.phase.equals("RECOVERING")||(wasBlocked&&j.attempts==1);
    long expected=recovering?rec(j.plan):cand(j.plan),previous=recovering?cand(j.plan):j.base;
    J n=j.copy();
    if(e.installed==expected){n.phase=recovering?"RECOVERY_PROBATION":"PROBATION";n.reason="";return n;}
    if(e.installed!=previous){n.phase="SUPPORT";n.reason="unexpected_installed_identity";return n;}
    if(e.blocked!=null){n.phase="SUPPORT";n.reason=e.blocked;return n;}
    if(wasBlocked||e.pending)return j;
    n.phase=recovering?"SUPPORT":"QUARANTINED";n.q.add(cand(j.plan));n.reason=recovering?"recovery_install_failed":"candidate_install_failed";return n;
  }
  static J stepAdmit(J j,Event e,String target) {
    boolean resume=target.equals("VERIFIED")&&j.phase.equals("STAGING")&&j.plan==e.plan&&j.base==e.base;
    if(e.base>=cand(e.plan)||!(!ACTIVE.contains(j.phase)||resume)||j.gen!=e.generation||e.base!=e.installed
        ||j.q.contains(cand(e.plan))||j.q.contains(rec(e.plan)))return REFUSED;
    J n=j.copy();n.phase=target;n.plan=e.plan;n.base=e.base;n.session=0;n.attempts=0;n.reason="";return n;
  }
  static J step(J j,Event e) {
    J n=j.copy();
    switch(e.kind) {
      case "setChannel" -> {n.gen++;if(j.phase.equals("VERIFIED")||j.phase.equals("STAGING")){n=n.cleared("IDLE","channel_changed");}return n;}
      case "stage" -> {return stepAdmit(j,e,"STAGING");}
      case "begin" -> {return stepAdmit(j,e,"VERIFIED");}
      case "discard" -> {
        if(j.plan!=e.plan||j.plan==0||!j.phase.equals("STAGING")||j.gen!=e.generation)return REFUSED;
        return j.cleared("IDLE","staging_invalidated");
      }
      case "committing" -> {
        if(j.plan==0||j.plan!=e.plan||!j.phase.equals("VERIFIED")||j.gen!=e.generation)return REFUSED;
        n.session=e.session;n.phase="COMMITTING";return n;
      }
      case "recovering" -> {
        if(j.plan==0||j.plan!=e.plan||!j.phase.equals("RECOVERY_READY")||j.attempts!=0)return REFUSED;
        n.session=e.session;n.attempts++;n.phase="RECOVERING";return n;
      }
      case "reconcile" -> {return stepReconcile(j,e);}
      case "observe" -> {
        if(!(j.phase.equals("COMMITTING")||j.phase.equals("RECOVERING"))||j.plan==0||j.plan!=e.plan||j.session!=e.session||e.outcome.equals("below"))return j;
        n.phase="SUPPORT";n.reason=e.outcome.equals("timeout")?"install_timeout":"install_clock_invalid";return n;
      }
      case "healthy" -> {
        if(!(j.phase.equals("PROBATION")||j.phase.equals("RECOVERY_PROBATION"))||j.plan==0)return REFUSED;
        boolean recovery=j.phase.equals("RECOVERY_PROBATION");
        if(e.installed!=(recovery?rec(j.plan):cand(j.plan)))return REFUSED;
        n.phase=recovery?"RECOVERED":"HEALTHY";n.reason="";return n;
      }
      case "healthFailed" -> {
        if(!(j.phase.equals("PROBATION")||j.phase.equals("HEALTHY")||j.phase.equals("RECOVERY_PROBATION"))||j.plan==0)return REFUSED;
        boolean recovery=j.phase.equals("RECOVERY_PROBATION");
        if(e.installed!=(recovery?rec(j.plan):cand(j.plan)))return REFUSED;
        n.q.add(cand(j.plan));if(recovery)n.q.add(rec(j.plan));
        n.phase=j.attempts==0?"RECOVERY_READY":"SUPPORT";n.reason="local_health_failed";return n;
      }
      default -> throw new IllegalStateException(e.kind);
    }
  }

  static UpdateJournal.Identity id(long code){return new UpdateJournal.Identity(code,String.format(Locale.ROOT,"%064x",code));}
  static UpdateJournal.Plan plan(int p,long base,String channel){return new UpdateJournal.Plan("p"+p,channel,"launcher",id(base),id(cand(p)),id(rec(p)));}
  static void apply(UpdateJournal journal,Event e)throws IOException {
    String plan="p"+e.plan;
    switch(e.kind) {
      case "setChannel" -> journal.setChannel(journal.read().channel.equals("stable")?"beta":"stable");
      case "stage" -> journal.stageValidated(plan(e.plan,e.base,journal.read().channel),id(e.installed),e.generation,()->{});
      case "begin" -> journal.beginValidated(plan(e.plan,e.base,journal.read().channel),id(e.installed),e.generation,()->{});
      case "discard" -> journal.discardStaging(plan,e.generation);
      case "committing" -> journal.committingWithAction(plan,e.session,e.generation,()->{});
      case "recovering" -> journal.recoveringWithAction(plan,e.session,()->{});
      case "reconcile" -> journal.reconcileInstallerResult(plan,e.session,id(e.installed),e.pending,e.blocked);
      // The model abstracts duration; these monotonic readings reach each outcome.
      case "observe" -> {
        if(e.outcome.equals("below"))journal.observePending(plan,e.session,1,0,1000);
        else if(e.outcome.equals("timeout")){journal.observePending(plan,e.session,1,0,1000);journal.observePending(plan,e.session,1,5000,1000);}
        else {journal.observePending(plan,e.session,5,1000,1000);journal.observePending(plan,e.session,5,500,1000);}
      }
      case "healthy" -> journal.installedHealthy(journal.read(),id(e.installed));
      case "healthFailed" -> journal.localHealthFailed(journal.read(),id(e.installed));
      default -> throw new IllegalStateException(e.kind);
    }
  }
  static J observed(UpdateJournal.Snapshot s) {
    J j=new J();j.phase=s.phase.name();j.reason=s.reason;j.plan=s.plan==null?0:Integer.parseInt(s.plan.id.substring(1));
    j.base=s.plan==null?0:s.plan.baseline.code;j.session=Math.max(s.sessionId,0);j.attempts=s.recoveryAttempts;j.gen=s.channelGeneration;
    for(String digest:s.quarantine)j.q.add(Long.parseLong(digest,16));
    return j;
  }

  static Event ev(String kind){return new Event(kind,0,0,0,0,0,false,null,"");}
  static Event admit(String kind,int p,long base,long installed,long generation){return new Event(kind,p,base,installed,generation,0,false,null,"");}
  static Event commit(int p,int s,long generation){return new Event("committing",p,0,0,generation,s,false,null,"");}
  static Event recover(int p,int s){return new Event("recovering",p,0,0,0,s,false,null,"");}
  static Event reconcile(int p,int s,long installed,boolean pending,String blocked){return new Event("reconcile",p,0,installed,0,s,pending,blocked,"");}
  static Event observe(int p,int s,String outcome){return new Event("observe",p,0,0,0,s,false,null,outcome);}
  static Event health(String kind,long installed){return new Event(kind,0,0,installed,0,0,false,null,"");}
  @SafeVarargs static List<Event> then(List<Event> prefix,Event... more){List<Event> all=new ArrayList<>(prefix);all.addAll(List.of(more));return all;}

  /** Every reachable phase and reason, each as the shortest event path from a new device. */
  static LinkedHashMap<String,List<Event>> recipes() {
    Event b1=admit("begin",1,1,1,0);
    List<Event> com=List.of(b1,commit(1,1,0)),prob=then(com,reconcile(1,1,2,false,null)),healthy=then(prob,health("healthy",2)),
      rr=then(prob,health("healthFailed",2)),rg=then(rr,recover(1,2)),rp=then(rg,reconcile(1,2,3,false,null));
    LinkedHashMap<String,List<Event>> r=new LinkedHashMap<>();
    r.put("idle",List.of());r.put("gen1",List.of(ev("setChannel")));r.put("staging",List.of(admit("stage",1,1,1,0)));r.put("verified",List.of(b1));
    r.put("channelChanged",List.of(b1,ev("setChannel")));r.put("committing",com);r.put("probation",prob);r.put("healthy",healthy);
    r.put("rr",rr);r.put("rrHealthy",then(healthy,health("healthFailed",2)));r.put("recovering",rg);r.put("rprob",rp);
    r.put("recovered",then(rp,health("healthy",3)));r.put("quarantined",then(com,reconcile(1,1,1,false,null)));
    r.put("supPolicy",then(com,reconcile(1,1,1,false,"policy_blocked")));r.put("supUser",then(com,reconcile(1,1,1,false,"user_action_required")));
    r.put("supTimeout",then(com,observe(1,1,"timeout")));r.put("supClock",then(com,observe(1,1,"regress")));r.put("supUnexpected",then(com,reconcile(1,1,9,false,null)));
    r.put("supRPolicy",then(rg,reconcile(1,2,2,false,"policy_blocked")));r.put("supRTimeout",then(rg,observe(1,2,"timeout")));r.put("supRClock",then(rg,observe(1,2,"regress")));
    r.put("supRUnexpected",then(rg,reconcile(1,2,9,false,null)));r.put("supRFailed",then(rg,reconcile(1,2,2,false,null)));r.put("supRHealth",then(rp,health("healthFailed",3)));
    r.put("healthyChannel",then(healthy,ev("setChannel")));r.put("secondPlan",then(healthy,admit("begin",2,2,2,0)));
    return r;
  }
  /** Fresh and stale plans, sessions, generations and readbacks for every API. */
  static List<Event> events() {
    List<Event> e=new ArrayList<>();e.add(ev("setChannel"));
    for(String kind:new String[]{"stage","begin"})for(int p=1;p<=2;p++)for(long base=1;base<=2;base++)for(long inst=1;inst<=2;inst++)for(long g=0;g<=1;g++)e.add(admit(kind,p,base,inst,g));
    for(int p=1;p<=2;p++)for(long g=0;g<=1;g++){e.add(new Event("discard",p,0,0,g,0,false,null,""));e.add(commit(p,5,g));}
    for(int p=1;p<=2;p++)e.add(recover(p,6));
    for(int p=1;p<=2;p++)for(int s:new int[]{1,2,7})for(long inst:new long[]{1,2,3,9})for(boolean pending:new boolean[]{false,true})
      for(String blocked:new String[]{null,"policy_blocked","user_action_required"})e.add(reconcile(p,s,inst,pending,blocked));
    for(int s=1;s<=2;s++)for(String outcome:new String[]{"below","timeout","regress"})e.add(observe(1,s,outcome));
    for(long inst:new long[]{1,2,3,9}){e.add(health("healthy",inst));e.add(health("healthFailed",inst));}
    return e;
  }

  /** The encoded journal in memory: every case round-trips the real codec, with no fsync. */
  static final class MemoryStore implements UpdateJournal.Store {
    private byte[] published;
    @Override public synchronized <T> T exclusive(UpdateJournal.Exclusive<T> body)throws IOException{return body.run();}
    @Override public byte[] read(){return published==null?null:published.clone();}
    @Override public void publish(byte[] envelope){published=envelope.clone();}
  }
  public static void main(String[] args)throws Exception {
    LinkedHashMap<String,List<Event>> recipes=recipes();List<Event> events=events();
    int cases=0,refused=0;List<String> differences=new ArrayList<>();
    for(Map.Entry<String,List<Event>> recipe:recipes.entrySet()) {
      J model=new J();
      for(Event e:recipe.getValue()){model=step(model,e);if(model==REFUSED)throw new AssertionError("Model refuses recipe "+recipe.getKey());}
      for(int index=0;index<events.size();index++) {
        Event e=events.get(index);
        UpdateJournal journal=new UpdateJournal(new MemoryStore());
        for(Event setup:recipe.getValue())apply(journal,setup);
        String actual;
        try{apply(journal,e);actual=observed(journal.read()).key();}
        catch(IOException|IllegalArgumentException refusal){actual="REFUSED";}
        String expected=step(model,e).key();
        cases++;if(expected.equals("REFUSED"))refused++;
        if(!expected.equals(actual))differences.add(recipe.getKey()+" + "+e+": journal "+actual+", model "+expected);
      }
    }
    if(!differences.isEmpty())throw new AssertionError(differences.size()+" differences, first: "+differences.subList(0,Math.min(5,differences.size())));
    if(recipes.size()!=27||events.size()!=201||cases!=5427)throw new AssertionError("Case table changed: "+recipes.size()+" x "+events.size());
    System.out.println("UpdateJournalConformance: "+cases+" cases ("+recipes.size()+" states x "+events.size()+" events, "+refused+" refusals), 0 differences");
  }
}
