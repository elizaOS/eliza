package ai.eliza.plugins.agent.updater;
import java.io.IOException;
import java.util.*;
/** Drives the real UpdateJournal, with its real codec, through every recipe state
 * crossed with every event, and compares each result with a reference step. The
 * reference matches plugins/plugin-native-agent/quint/UpdateJournal.qnt, including
 * durable installer reports,
 * a timed wait before an unreported release and a per-candidate retry budget.
 * scripts/check-update-journal.ts also compares the Quint step directly with
 * the real codec-backed results for this complete table.
 * Model identities are version codes: the baseline is 1, plan p has candidate
 * 2p and recovery 2p+1, and 9 is a package nobody planned. */
public final class UpdateJournalConformanceTest {
  /** A plan that is still fresh: these cases are about the install, not commit freshness. */
  static final UpdateJournal.FreshnessCheck FRESH=(plan,generation)->{};
  record Event(String kind,int plan,long base,long installed,long generation,int session,boolean pending,String blocked,String outcome,UpdateJournal.InstallerFailure failure) {
    @Override public String toString(){return kind+"(p="+plan+",base="+base+",inst="+installed+",g="+generation+",s="+session+",pending="+pending+",blocked="+blocked+",outcome="+outcome+",failure="+failure+")";}
  }
  /** The model's journal: UpdateJournal.State without revision, channel or timing. */
  static final class J {
    String phase="IDLE",reason="";int plan,session,attempts,releases;long base,gen,released;TreeSet<Long> q=new TreeSet<>();
    /** A report kept while the session was listed; the model's durable rejected flag. */
    UpdateJournal.InstallerFailure reported;
    J copy(){J c=new J();c.phase=phase;c.reason=reason;c.plan=plan;c.session=session;c.attempts=attempts;c.base=base;c.gen=gen;c.q=new TreeSet<>(q);c.reported=reported;c.released=released;c.releases=releases;return c;}
    String key(){return phase.equals("REFUSED")?"REFUSED":phase+"|"+reason+"|"+plan+"|"+base+"|"+session+"|"+attempts+"|"+gen+"|"+q+"|"+reported+"|"+released+"x"+releases;}
    J cleared(String phase,String reason){J c=copy();c.phase=phase;c.reason=reason;c.plan=0;c.base=0;c.session=0;c.reported=null;return c;}
  }
  static final J REFUSED=refused();
  static J refused(){J j=new J();j.phase="REFUSED";return j;}
  static final Set<String> ACTIVE=Set.of("STAGING","VERIFIED","COMMITTING","PROBATION","RECOVERY_READY","RECOVERING","RECOVERY_PROBATION","SUPPORT");
  static final Set<String> AWAIT=Set.of("user_action_required","policy_blocked","install_timeout","install_clock_invalid","install_outcome_unknown");
  static final int BUDGET=UpdateJournal.MAX_INSTALL_ATTEMPTS_PER_CANDIDATE;
  static long cand(int p){return 2L*p;}
  static long rec(int p){return 2L*p+1;}
  static boolean awaiting(J j){return j.phase.equals("COMMITTING")||j.phase.equals("RECOVERING")||(j.phase.equals("SUPPORT")&&AWAIT.contains(j.reason));}

  static J stepReconcile(J j,Event e) {
    if(!awaiting(j)||j.plan==0||j.plan!=e.plan||j.session!=e.session)return j;
    boolean wasBlocked=j.phase.equals("SUPPORT"),recovering=j.phase.equals("RECOVERING")||(wasBlocked&&j.attempts==1);
    long expected=recovering?rec(j.plan):cand(j.plan),previous=recovering?cand(j.plan):j.base;
    J n=j.copy();
    if(e.installed==expected){n.phase=recovering?"RECOVERY_PROBATION":"PROBATION";n.reason="";n.reported=null;if(!recovering){n.released=0;n.releases=0;}return n;}
    if(e.installed!=previous){n.phase="SUPPORT";n.reason="unexpected_installed_identity";return n;}
    if(e.blocked!=null){n.phase="SUPPORT";n.reason=e.blocked;return n;}
    // A report while the session is listed is kept, never dropped.
    if(e.pending){if(!recovering)n.reported=stronger(j.reported,e.failure);return n;}
    if(recovering){if(wasBlocked)return j;n.phase="SUPPORT";n.q.add(cand(j.plan));n.reason="recovery_install_failed";return n;}
    // Only a reported candidate fault, now or earlier, quarantines.
    UpdateJournal.InstallerFailure evidence=stronger(j.reported,e.failure);
    if(evidence==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED){n.phase="QUARANTINED";n.q.add(cand(j.plan));n.reason="candidate_install_failed";n.reported=null;return n;}
    // A fault of the moment: the install can no longer happen, so release it.
    if(evidence==UpdateJournal.InstallerFailure.RETRYABLE)return release(j);
    // No report: wait, in observed time, for a late callback (observeUnknown).
    if(wasBlocked&&j.reason.equals("install_outcome_unknown"))return j;
    n.phase="SUPPORT";n.reason="install_outcome_unknown";return n;
  }
  static UpdateJournal.InstallerFailure stronger(UpdateJournal.InstallerFailure a,UpdateJournal.InstallerFailure b) {
    if(a==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED||b==UpdateJournal.InstallerFailure.CANDIDATE_REJECTED)return UpdateJournal.InstallerFailure.CANDIDATE_REJECTED;
    return a!=null?a:b;
  }
  /** The model's FixExit with a retry budget per candidate. */
  static J release(J j) {
    long candidate=cand(j.plan);int releases=j.released==candidate?j.releases+1:1;
    J n=releases>=BUDGET?j.copy():j.cleared("IDLE","install_not_completed");
    n.released=candidate;n.releases=releases;n.reported=null;
    if(releases>=BUDGET){n.phase="QUARANTINED";n.q.add(candidate);n.reason="install_retry_budget_spent";}
    return n;
  }
  static J stepAdmit(J j,Event e,String target) {
    boolean resume=target.equals("VERIFIED")&&j.phase.equals("STAGING")&&j.plan==e.plan&&j.base==e.base;
    if(e.base>=cand(e.plan)||!(!ACTIVE.contains(j.phase)||resume)||j.gen!=e.generation||e.base!=e.installed
        ||j.q.contains(cand(e.plan))||j.q.contains(rec(e.plan)))return REFUSED;
    J n=j.copy();n.phase=target;n.plan=e.plan;n.base=e.base;n.session=0;n.attempts=0;n.reason="";n.reported=null;return n;
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
      // A freshness check that refuses leaves the journal as it was.
      case "staleCommit" -> {return REFUSED;}
      case "discardVerified" -> {
        if(j.plan==0||j.plan!=e.plan||!j.phase.equals("VERIFIED")||j.gen!=e.generation)return REFUSED;
        return j.cleared("IDLE","verified_invalidated:revoked-artifact");
      }
      // The model's FixForward: a recovery that cannot load ends the wait.
      case "recoveryUnavailable" -> {
        if(j.plan==0||j.plan!=e.plan||!j.phase.equals("RECOVERY_READY")||j.attempts!=0)return REFUSED;
        n.q.add(cand(j.plan));n.q.add(rec(j.plan));n.phase="QUARANTINED";n.reason="recovery_unavailable:revoked-artifact";return n;
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
      case "observeUnknown" -> {
        // A regressed clock restarts the wait; only enough observed time releases.
        if(!j.phase.equals("SUPPORT")||!j.reason.equals("install_outcome_unknown")||j.plan!=e.plan||j.session!=e.session||!e.outcome.equals("timeout"))return j;
        return release(j);
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
      case "committing" -> journal.committingWithAction(plan,e.session,e.generation,FRESH,()->{});
      case "staleCommit" -> journal.committingWithAction(plan,e.session,e.generation,(p,g)->{throw new IOException("stale-metadata");},()->{throw new AssertionError("Stale plan handed off");});
      case "discardVerified" -> journal.discardVerified(plan,e.generation,"revoked-artifact");
      case "recoveryUnavailable" -> journal.recoveryUnavailable(plan,"revoked-artifact");
      case "recovering" -> journal.recoveringWithAction(plan,e.session,()->{});
      case "reconcile" -> journal.reconcileInstallerResult(plan,e.session,id(e.installed),e.pending,e.blocked,e.failure);
      // The model abstracts duration; these monotonic readings reach each outcome.
      case "observe" -> {
        if(e.outcome.equals("below"))journal.observePending(plan,e.session,1,0,1000);
        else if(e.outcome.equals("timeout")){journal.observePending(plan,e.session,1,0,1000);journal.observePending(plan,e.session,1,5000,1000);}
        else {journal.observePending(plan,e.session,5,1000,1000);journal.observePending(plan,e.session,5,500,1000);}
      }
      case "observeUnknown" -> {
        if(e.outcome.equals("below"))journal.observeOutcomeUnknown(plan,e.session,1,0,1000);
        else if(e.outcome.equals("timeout")){journal.observeOutcomeUnknown(plan,e.session,1,0,1000);journal.observeOutcomeUnknown(plan,e.session,1,5000,1000);}
        else {journal.observeOutcomeUnknown(plan,e.session,5,1000,1000);journal.observeOutcomeUnknown(plan,e.session,5,500,1000);}
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
    j.reported=s.reportedFailure;j.released=s.releasedCandidate.isEmpty()?0:Long.parseLong(s.releasedCandidate,16);j.releases=s.releases;
    return j;
  }

  static Event ev(String kind){return new Event(kind,0,0,0,0,0,false,null,"",null);}
  static Event admit(String kind,int p,long base,long installed,long generation){return new Event(kind,p,base,installed,generation,0,false,null,"",null);}
  static Event commit(int p,int s,long generation){return new Event("committing",p,0,0,generation,s,false,null,"",null);}
  static Event recover(int p,int s){return new Event("recovering",p,0,0,0,s,false,null,"",null);}
  static Event reconcile(int p,int s,long installed,boolean pending,String blocked){return reconcile(p,s,installed,pending,blocked,null);}
  static Event reconcile(int p,int s,long installed,boolean pending,String blocked,UpdateJournal.InstallerFailure failure){return new Event("reconcile",p,0,installed,0,s,pending,blocked,"",failure);}
  static Event observe(int p,int s,String outcome){return new Event("observe",p,0,0,0,s,false,null,outcome,null);}
  static Event observeUnknown(int p,int s,String outcome){return new Event("observeUnknown",p,0,0,0,s,false,null,outcome,null);}
  static Event health(String kind,long installed){return new Event(kind,0,0,installed,0,0,false,null,"",null);}
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
    r.put("recovered",then(rp,health("healthy",3)));r.put("quarantined",then(com,reconcile(1,1,1,false,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED)));
    r.put("supPolicy",then(com,reconcile(1,1,1,false,"policy_blocked")));r.put("supUser",then(com,reconcile(1,1,1,false,"user_action_required")));
    r.put("supTimeout",then(com,observe(1,1,"timeout")));r.put("supClock",then(com,observe(1,1,"regress")));r.put("supUnexpected",then(com,reconcile(1,1,9,false,null)));
    r.put("supRPolicy",then(rg,reconcile(1,2,2,false,"policy_blocked")));r.put("supRTimeout",then(rg,observe(1,2,"timeout")));r.put("supRClock",then(rg,observe(1,2,"regress")));
    r.put("supRUnexpected",then(rg,reconcile(1,2,9,false,null)));r.put("supRFailed",then(rg,reconcile(1,2,2,false,null)));r.put("supRHealth",then(rp,health("healthFailed",3)));
    r.put("healthyChannel",then(healthy,ev("setChannel")));r.put("secondPlan",then(healthy,admit("begin",2,2,2,0)));
    List<Event> unknown=then(com,reconcile(1,1,1,false,null));r.put("outcomeUnknown",unknown);r.put("released",then(unknown,observeUnknown(1,1,"timeout")));
    r.put("reportedRejected",then(com,reconcile(1,1,1,true,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED)));
    r.put("reportedRetryable",then(com,reconcile(1,1,1,true,null,UpdateJournal.InstallerFailure.RETRYABLE)));
    r.put("timeoutReported",then(com,reconcile(1,1,1,true,null,UpdateJournal.InstallerFailure.CANDIDATE_REJECTED),observe(1,1,"timeout")));
    // One release short of the budget, then committing again.
    List<Event> spent=new ArrayList<>();
    for(int i=1;i<BUDGET;i++){spent.add(b1);spent.add(commit(1,1,0));spent.add(reconcile(1,1,1,false,null,UpdateJournal.InstallerFailure.RETRYABLE));}
    r.put("budgetLeft",spent);r.put("budgetCommitting",then(spent,b1,commit(1,1,0)));
    r.put("budgetSpent",then(spent,b1,commit(1,1,0),reconcile(1,1,1,false,null,UpdateJournal.InstallerFailure.RETRYABLE)));
    r.put("verifiedDiscarded",List.of(b1,new Event("discardVerified",1,0,0,0,0,false,null,"",null)));
    r.put("recoveryUnavailable",then(rr,new Event("recoveryUnavailable",1,0,0,0,0,false,null,"",null)));
    return r;
  }
  /** Fresh and stale plans, sessions, generations and readbacks for every API. */
  static List<Event> events() {
    List<Event> e=new ArrayList<>();e.add(ev("setChannel"));
    for(String kind:new String[]{"stage","begin"})for(int p=1;p<=2;p++)for(long base=1;base<=2;base++)for(long inst=1;inst<=2;inst++)for(long g=0;g<=1;g++)e.add(admit(kind,p,base,inst,g));
    for(int p=1;p<=2;p++)for(long g=0;g<=1;g++){e.add(new Event("discard",p,0,0,g,0,false,null,"",null));e.add(commit(p,5,g));}
    for(int p=1;p<=2;p++)e.add(recover(p,6));
    for(int p=1;p<=2;p++)for(int s:new int[]{1,2,7})for(long inst:new long[]{1,2,3,9})for(boolean pending:new boolean[]{false,true})
      for(String blocked:new String[]{null,"policy_blocked","user_action_required"})e.add(reconcile(p,s,inst,pending,blocked));
    for(int s=1;s<=2;s++)for(String outcome:new String[]{"below","timeout","regress"})e.add(observe(1,s,outcome));
    for(long inst:new long[]{1,2,3,9}){e.add(health("healthy",inst));e.add(health("healthFailed",inst));}
    // Installer reports, which the model carries as its rejected flag.
    for(int p=1;p<=2;p++)for(int s:new int[]{1,2,7})for(long inst:new long[]{1,2,3,9})for(boolean pending:new boolean[]{false,true})
      for(UpdateJournal.InstallerFailure failure:UpdateJournal.InstallerFailure.values())e.add(reconcile(p,s,inst,pending,null,failure));
    for(int s=1;s<=2;s++)for(String outcome:new String[]{"below","timeout","regress"})e.add(observeUnknown(1,s,outcome));
    // A refused freshness check, a refresh that drops the plan, and a recovery that cannot load.
    for(int p=1;p<=2;p++)for(long g=0;g<=1;g++){e.add(new Event("discardVerified",p,0,0,g,0,false,null,"",null));e.add(new Event("staleCommit",p,0,0,g,5,false,null,"",null));}
    for(int p=1;p<=2;p++)e.add(new Event("recoveryUnavailable",p,0,0,0,0,false,null,"",null));
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
    // The first 27 states and 201 events are the model's original 5,427-case table.
    if(recipes.size()!=37||events.size()!=313||cases!=11581)throw new AssertionError("Case table changed: "+recipes.size()+" x "+events.size());
    System.out.println("UpdateJournalConformance: "+cases+" cases ("+recipes.size()+" states x "+events.size()+" events, "+refused+" refusals), 0 differences");
  }
}
