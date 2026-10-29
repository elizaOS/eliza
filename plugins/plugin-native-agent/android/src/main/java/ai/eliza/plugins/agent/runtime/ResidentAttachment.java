package ai.eliza.plugins.agent.runtime;

import java.util.Iterator;
import java.util.LinkedHashSet;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Decides whether a surface (Home, an assistant surface) may attach to the resident agent that is
 * already admitted and running, instead of starting it again. Attaching never advances the runtime
 * epoch, clears the owner enrollment, pairs again or touches the service; it only lets the calling
 * surface begin issuing its own requests against the same runtime. Every refusal falls back to the
 * ordinary start path.
 *
 * <p>Also the resident lifecycle's shared readings of the native boot state: a confirmed shutdown,
 * and the startup refusals the renderer reports instead of retrying.
 *
 * <p>Pure policy: no Android, Capacitor or service types, so the JVM contract test exercises the
 * exact production decision.
 */
public final class ResidentAttachment {
  private ResidentAttachment() {}

  /** The owner session must outlive the attach by this margin; matches enrollment reuse. */
  public static final long ENROLLMENT_MARGIN_MS = 30_000;

  /** Process-wide facts captured under the plugin's lifecycle lock. */
  public static final class Facts {
    public boolean accepting, stopping, credentialMutating, credentialShutdownPending, attachUnverified;
    /** Token of the runtime that is running now, and the one the enrollment was made against. */
    public String currentRoot, enrolledRoot;

    public String ownerToken, ownerIdentity;
    public long expiresAt, now;
    /**
     * Provider admission generation the running process was launched with, and the stored one
     * ({@link NativeProviderAdmission#NO_PROVIDER_GENERATION} for an unbound resident).
     */
    public String launchedGeneration, currentGeneration;
  }

  /**
   * Returns null when the caller may attach, otherwise a short non-sensitive reason. Reasons are
   * diagnostics only: they never contain tokens, identities or provider values.
   */
  public static String refusal(JSONObject bootState, Facts facts) {
    if (facts == null) return "unavailable";
    if (facts.attachUnverified) return "attach-unverified";
    if (!facts.accepting || facts.stopping) return "lifecycle-retiring";
    if (facts.credentialMutating || facts.credentialShutdownPending) return "provider-changing";
    if (bootState == null
        || !"listening".equals(bootState.optString("state"))
        || !bootState.optBoolean("serviceActive", false)
        || !bootState.optBoolean("socketListening", false)) return "runtime-not-running";
    if (empty(facts.currentRoot)) return "runtime-token-unavailable";
    // A pending, not-yet-completed enrollment is never shared. Until one surface's pairing has
    // stored an owner session, a second surface takes the ordinary start path and supersedes the
    // first. Sharing would let a surface issue requests on a session it did not see complete;
    // refusing costs only one extra pairing.
    if (empty(facts.enrolledRoot) || empty(facts.ownerToken) || empty(facts.ownerIdentity)) return "not-enrolled";
    if (!facts.currentRoot.equals(facts.enrolledRoot)) return "runtime-changed";
    if (facts.expiresAt <= facts.now + ENROLLMENT_MARGIN_MS) return "enrollment-expiring";
    // A process launched under another provider admission must be restarted by the normal path.
    if (empty(facts.launchedGeneration) || empty(facts.currentGeneration)) return "provider-unadmitted";
    if (!facts.launchedGeneration.equals(facts.currentGeneration)) return "provider-changed";
    return null;
  }

  private static boolean empty(String value) {
    return value == null || value.isEmpty();
  }

  /** Renderer-visible result of the read-only attachment query. */
  public static JSONObject describe(String refusal) throws JSONException {
    JSONObject result = new JSONObject().put("attachable", refusal == null);
    if (refusal != null) result.put("reason", refusal);
    return result;
  }

  /** The service is dead, inactive and no longer listening: a stop or credential shutdown completed. */
  public static boolean shutdownConfirmed(JSONObject status) {
    return status != null
        && "dead".equals(status.optString("state"))
        && !status.optBoolean("serviceActive", true)
        && !status.optBoolean("socketListening", true);
  }

  /**
   * The renderer message for a boot-state reason that restarting will not fix, or null when the
   * start should keep waiting. Records are always preserved; the messages never suggest clearing
   * app data.
   */
  public static String startupRefusalMessage(String reason) {
    if ("ipc-recovery-retention-limit".equals(reason))
      return "Your agent needs recovery review. Your records were kept. Restarting will not fix this; do not clear app data.";
    if ("ipc-recovery-required".equals(reason))
      return "Your agent needs recovery review. Your records were kept. Do not clear app data or rerun unfinished work.";
    if ("runtime-identity-unavailable".equals(reason))
      return "Local startup could not verify its runtime files. Your records were preserved. Check the installed runtime before reconnecting.";
    return null;
  }

  /**
   * Bounded memory of start requests that attached. A later cancelStart for one of them is a
   * no-op: an attaching surface never owns the launch, so it can never retire it.
   */
  public static final class Requests {
    public static final int LIMIT = 32;
    private final LinkedHashSet<String> ids = new LinkedHashSet<>();

    public void add(String id) {
      if (id == null) return;
      ids.remove(id);
      ids.add(id);
      while (ids.size() > LIMIT) {
        Iterator<String> oldest = ids.iterator();
        oldest.next();
        oldest.remove();
      }
    }

    public boolean remove(String id) {
      return id != null && ids.remove(id);
    }

    public int size() {
      return ids.size();
    }
  }
}
