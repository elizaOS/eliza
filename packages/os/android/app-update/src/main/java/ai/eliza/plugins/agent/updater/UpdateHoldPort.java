// spec/os/appUpdate/install.md, "The agent is held before the installer gets a session"; spec/os/appUpdate/install.md, "The hold is released only after a confirmed install or a proven ended attempt"
package ai.eliza.plugins.agent.updater;

import java.io.IOException;

public interface UpdateHoldPort {
  void hold(UpdateJournal.Identity target) throws IOException;
  boolean awaitHeld(UpdateJournal.Identity target, long timeoutMillis) throws IOException, InterruptedException;
  void release(UpdateJournal.Identity installed) throws IOException;
}
