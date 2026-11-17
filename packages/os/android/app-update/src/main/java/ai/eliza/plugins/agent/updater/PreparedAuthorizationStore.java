package ai.eliza.plugins.agent.updater;

import java.io.File;
import java.io.IOException;

/** Private journal-coordinated retention. No IPC or renderer-controlled paths.
 * Discovery may race cleanup before admission; a deleted result is rejected by
 * begin, so it cannot become an active transaction without its recovery permit.
 * The future discovery controller should prune before preparing its next pair. */
public class PreparedAuthorizationStore {
  public interface Authority {
    void prune(String directory,String retainedId)throws Exception;
    void verify(String directory,UpdateJournal.Plan plan,long generation,byte[] candidate,byte[] recovery)throws Exception;
  }
  private final Authority authority;
  private final UpdateJournal journal;
  private final File directory;
  public PreparedAuthorizationStore(UpdateJournal journal,File directory,Authority authority) {
    this.journal=java.util.Objects.requireNonNull(journal);this.directory=java.util.Objects.requireNonNull(directory);this.authority=java.util.Objects.requireNonNull(authority);
  }
  public void prune()throws IOException {
    journal.withLockedSnapshot(state->{
      try { authority.prune(directory.getAbsolutePath(),state.plan==null?"":state.plan.id); }
      catch(Exception e){throw new IOException("Cannot safely retire prepared authorizations",e);}
    });
  }
  public UpdateJournal.Snapshot begin(UpdateJournal.Plan plan,UpdateJournal.Identity installed,long generation,byte[] candidate,byte[] recovery)throws IOException {
    return journal.beginValidated(plan,installed,generation,()->{
      try { authority.verify(directory.getAbsolutePath(),plan,generation,candidate,recovery); }
      catch(Exception e){throw new IOException("Prepared authorization is no longer available or matching",e);}
    });
  }
}
