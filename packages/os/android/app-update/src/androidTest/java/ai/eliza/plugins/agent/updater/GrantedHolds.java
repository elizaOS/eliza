// spec/os/appUpdate/install.md, "The agent is held before the installer gets a session"
package ai.eliza.plugins.agent.updater;

public final class GrantedHolds implements UpdateHoldPort {
  @Override public void hold(UpdateJournal.Identity target) {}
  @Override public boolean awaitHeld(UpdateJournal.Identity target, long timeoutMillis) { return true; }
  @Override public void release(UpdateJournal.Identity installed) {}

  public static UpdateJournal.Snapshot admitHeld(UpdateJournal journal, UpdateJournal.Plan plan) throws java.io.IOException {
    admit(journal, plan);
    journal.requestHold(plan.id);
    return journal.acknowledgeHold(plan.id, plan.candidate);
  }

  public static UpdateJournal.Snapshot admit(UpdateJournal journal, UpdateJournal.Plan plan) throws java.io.IOException {
    long generation = journal.read().channelGeneration;
    journal.stageValidated(plan, plan.baseline, generation, () -> {});
    return journal.begin(plan, plan.baseline, generation);
  }
}
