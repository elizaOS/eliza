// spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"
package ai.eliza.os.agent;

import android.content.Context;
import java.io.IOException;
import java.nio.file.Path;

public final class UpdateHold {
  private static final long POLL_MS = 100;
  private final UpdateHoldFile file;

  public UpdateHold(Path directory) throws IOException {
    file = new UpdateHoldFile(directory);
  }

  static UpdateHoldFile of(Context context) throws IOException {
    return new UpdateHoldFile(context.getNoBackupFilesDir().toPath().resolve("agent-update-hold"));
  }

  public static void holdForUpdate(Context context, long versionCode, String digest) throws IOException {
    AgentService.holdForUpdate(context, new AgentPolicy.UpdateTarget(versionCode, digest));
  }

  public static boolean awaitHeld(Context context, long versionCode, String digest, long timeoutMs) throws IOException, InterruptedException {
    AgentPolicy.UpdateTarget target = new AgentPolicy.UpdateTarget(versionCode, digest);
    long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
    UpdateHoldFile hold = of(context);
    while (!target.equals(hold.held())) {
      if (System.nanoTime() >= deadline) return false;
      Thread.sleep(POLL_MS);
    }
    return true;
  }

  public static boolean releaseUpdate(Context context, long installedCode, String installedDigest, boolean attemptEnded) throws IOException {
    return AgentService.releaseUpdate(context, installedCode, installedDigest, attemptEnded);
  }

  public AgentPolicy.UpdateTarget held() throws IOException { return file.held(); }
}
