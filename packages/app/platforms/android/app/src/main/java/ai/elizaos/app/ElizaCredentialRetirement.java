package ai.elizaos.app;

import ai.eliza.plugins.agent.runtime.ResidentAttachment;
import android.content.Context;

/** Resident packaging binds credential retirement to the real service's exact stop lease. */
final class ElizaCredentialRetirement {
    static final class RequestObservation {
        private final ElizaAgentService.RequestObservation runtime = ElizaAgentService.observeRequests();
        boolean same(RequestObservation other) { return other != null && runtime.same(other.runtime); }
        <T> T withCurrent(java.util.concurrent.Callable<T> effect) throws Exception { return runtime.withCurrent(effect); }
    }
    static RequestObservation observeRequests() { return new RequestObservation(); }
    static long reserve() { return ElizaAgentService.reserveCredentialShutdown(); }
    static void request(Context context, long request) { ElizaAgentService.retryCredentialShutdown(context, request); }
    static boolean stopped(Context context) throws Exception {
        return ResidentAttachment.shutdownConfirmed(ElizaAgentService.getLocalAgentBootState(context));
    }
    static boolean acknowledged(long request) { return ElizaAgentService.isCredentialShutdownConfirmed(request); }
    static void release(long request) { ElizaAgentService.releaseCredentialShutdown(request); }
    static void abandon(long request) { ElizaAgentService.abandonCredentialShutdown(request); }
}
