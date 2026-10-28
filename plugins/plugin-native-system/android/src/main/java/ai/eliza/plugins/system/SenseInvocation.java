package ai.eliza.plugins.system;

/** One process-local, owner-bound assistant invocation. Never accepts caller Intent extras. */
public final class SenseInvocation {
    public static final long WINDOW_MS = 5000;
    private String session;
    private String bindingId;
    private long bridgeGeneration;
    private int rendererGeneration;
    private String origin;
    private String invocationSession;
    private long arrivedAt;
    private boolean locked;

    public synchronized void bind(long bridge, int generation, String owner, String next) {
        if (bridge <= 0 || generation <= 0) throw new IllegalArgumentException("Invalid invocation generation");
        if (owner == null || !owner.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("Invalid invocation binding");
        if (next != null && !next.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid invocation session");
        // Native plugin lifetimes and renderer mounts both advance monotonically.
        // Late calls from an old WebView or mount cannot reclaim the current lease.
        if (bridge < bridgeGeneration || bridge == bridgeGeneration && generation < rendererGeneration) return;
        if (bridge > bridgeGeneration || generation > rendererGeneration) {
            reset(); bridgeGeneration = bridge; rendererGeneration = generation;
        }
        // A disposed renderer may finish cleanup after its replacement has bound.
        if (next == null && !owner.equals(bindingId)) return;
        if (!owner.equals(bindingId) || (session == null ? next != null : !session.equals(next))) clear();
        bindingId = next == null ? null : owner;
        session = next;
    }

    public synchronized void reset() { clear(); session = null; bindingId = null; }
    public synchronized void release(long bridge) { if (bridge == bridgeGeneration) reset(); }

    public synchronized void record(String hostPackage, String callerPackage, boolean sameSigner, long now, boolean lockedAtArrival) {
        origin = (hostPackage + ".sense").equals(callerPackage) && sameSigner ? "listener" : "assist";
        invocationSession = session;
        arrivedAt = now;
        locked = lockedAtArrival;
    }

    /** Returns null after consumption. Unknown or changed ownership never returns listener. */
    public synchronized String take(long bridge, int generation, String owner, String expectedSession, long now, boolean lockedNow) {
        if (bridge != bridgeGeneration || generation != rendererGeneration) return null;
        if (owner == null || !owner.equals(bindingId)) return null;
        if (origin == null) return null;
        String result = "listener".equals(origin) && session != null && session.equals(expectedSession)
                && session.equals(invocationSession) && !locked && !lockedNow && now >= arrivedAt
                && now - arrivedAt <= WINDOW_MS ? "listener" : "assist";
        clear();
        return result;
    }

    private void clear() {
        origin = null;
        invocationSession = null;
        arrivedAt = 0;
        locked = true;
    }
}
