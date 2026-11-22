// spec/os/agentService/lifecycle.md, "A start begins a new launch only from Stopped or Failed, and a start asked during a stop runs after the exit"
package ai.eliza.os.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;
import android.util.Log;

public class AgentStartReceiver extends BroadcastReceiver {
  private static final String TAG = "ElizaAgentStart";

  @Override public void onReceive(Context context, Intent intent) {
    String action = intent == null ? null : intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
    UserManager users = context.getSystemService(UserManager.class);
    if (users != null && !users.isUserUnlocked()) return;
    Context app = context.getApplicationContext();
    PendingResult pending = goAsync();
    Thread starter = new Thread(() -> {
      try {
        if (AgentService.signedIn()) AgentService.start(app);
      } catch (Exception refused) {
        Log.w(TAG, "The agent was not started after " + action, refused);
      } finally {
        pending.finish();
      }
    }, "ElizaAgentStart");
    starter.setDaemon(true);
    starter.start();
  }
}
