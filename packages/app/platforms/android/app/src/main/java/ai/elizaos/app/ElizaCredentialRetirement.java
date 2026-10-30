package ai.elizaos.app;

import ai.eliza.plugins.agent.runtime.ResidentAttachment;
import android.content.Context;

/** Resident packaging binds credential retirement to the real service's exact stop lease. */
final class ElizaCredentialRetirement {
    static long request(Context context) { return ElizaAgentService.stopForCredentialChange(context); }
    static boolean stopped(Context context) throws Exception {
        return ResidentAttachment.shutdownConfirmed(ElizaAgentService.getLocalAgentBootState(context));
    }
    static boolean acknowledged(long request) { return ElizaAgentService.isCredentialShutdownConfirmed(request); }
    static void release(long request) { ElizaAgentService.releaseCredentialShutdown(request); }
}
