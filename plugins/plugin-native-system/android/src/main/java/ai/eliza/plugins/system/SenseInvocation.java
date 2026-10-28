package ai.eliza.plugins.system;

/**
 * One process-local, owner-bound assistant invocation. Never accepts caller Intent extras.
 *
 * <p>Two origins may start a voice turn: {@link #LISTENER}, a wake from the same-signer image
 * listener, and {@link #SYSTEM}, an assistant gesture (press-and-hold power, the assist gesture, a
 * long press on Home or the navigation handle) that the platform-signed system UI launched with
 * its identity shared. Every other launch is {@link #ASSIST}: it opens the assistant only.
 *
 * <p>A voice origin that arrives before any authenticated renderer binding (a cold process, or a
 * renderer that is not signed in yet) normally only opens the assistant. When the host registers a
 * native {@link OwnerAdmission}, such an invocation is held for {@link #COLD_WINDOW_MS}: the first
 * authenticated binding may claim it only if the host's native owner at that binding equals the
 * native owner recorded when it arrived, and the take still requires the same session, no lock at
 * arrival or now, and foreground. Renderer input never fills that gap; only native owner state does.
 */
public final class SenseInvocation {
    public static final long WINDOW_MS = 5000;
    /** How long a wake that arrived before an authenticated binding may wait for one. */
    public static final long COLD_WINDOW_MS = 15000;
    /** Absent clock: a cold wake cannot be claimed. */
    public static final long NO_CLOCK = Long.MIN_VALUE;
    /** A wake from the same-signer image listener. */
    public static final String LISTENER = "listener";
    /** An assistant gesture launched by the platform-signed system UI with its identity shared. */
    public static final String SYSTEM = "system";
    /** A warm press on the host's permission-protected Power activity (native hook only). */
    public static final String POWER = "power";
    /** Any other launch: the assistant opens and no voice turn starts. */
    public static final String ASSIST = "assist";

    /**
     * The host's native, non-secret identity of the owner whose authenticated session may claim a
     * wake that arrived before a renderer bound one (for example a durable account-binding
     * generation). Null when no owner is admitted. Called under this object's lock: keep it cheap
     * and never call back into the invocation. Never return a credential or token.
     */
    public interface OwnerAdmission { String currentOwner(); }

    private String session;
    private String bindingId;
    private long bridgeGeneration;
    private int rendererGeneration;
    private String origin;
    private String invocationSession;
    private long arrivedAt;
    private boolean locked;
    private OwnerAdmission admission;
    /** Native owner recorded with a wake that arrived before an authenticated binding. */
    private String coldOwner;
    /** The current listener origin was claimed from such a wake. */
    private boolean adopted;

    /** Registers (or with null removes) the host's native owner admission. */
    public synchronized void admit(OwnerAdmission next) { admission = next; }

    public synchronized void bind(long bridge, int generation, String owner, String next) {
        bind(bridge, generation, owner, next, NO_CLOCK);
    }

    public synchronized void bind(long bridge, int generation, String owner, String next, long now) {
        if (bridge <= 0 || generation <= 0) throw new IllegalArgumentException("Invalid invocation generation");
        if (owner == null || !owner.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")) throw new IllegalArgumentException("Invalid invocation binding");
        if (next != null && !next.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid invocation session");
        // Native plugin lifetimes and renderer mounts both advance monotonically.
        // Late calls from an old WebView or mount cannot reclaim the current lease.
        if (bridge < bridgeGeneration || bridge == bridgeGeneration && generation < rendererGeneration) return;
        String waitingOwner = coldWaiting() ? coldOwner : null;
        String waitingOrigin = origin;
        long waitingSince = arrivedAt;
        if (bridge > bridgeGeneration || generation > rendererGeneration) {
            reset(); bridgeGeneration = bridge; rendererGeneration = generation;
        }
        // A disposed renderer may finish cleanup after its replacement has bound.
        if (next != null || owner.equals(bindingId)) {
            if (!owner.equals(bindingId) || (session == null ? next != null : !session.equals(next))) clear();
            bindingId = next == null ? null : owner;
            session = next;
        }
        if (waitingOwner != null) carry(waitingOrigin, waitingOwner, waitingSince, next, now);
    }

    public synchronized void reset() { clear(); session = null; bindingId = null; }
    public synchronized void release(long bridge) { if (bridge == bridgeGeneration) reset(); }

    public synchronized void record(String hostPackage, String callerPackage, boolean sameSigner, long now, boolean lockedAtArrival) {
        record(hostPackage, callerPackage, sameSigner, false, now, lockedAtArrival);
    }

    /**
     * Records one launch of the assistant surface. {@code systemAssist} is true only when Android
     * reported the platform-signed system UI as the caller (see
     * {@link SenseListenerClient#recordInvocation}); a listener caller still takes precedence.
     */
    public synchronized void record(String hostPackage, String callerPackage, boolean sameSigner, boolean systemAssist, long now, boolean lockedAtArrival) {
        origin = (hostPackage + ".sense").equals(callerPackage) && sameSigner ? LISTENER : systemAssist ? SYSTEM : ASSIST;
        invocationSession = session;
        arrivedAt = now;
        locked = lockedAtArrival;
        adopted = false;
        coldOwner = startsVoice(origin) && session == null && !lockedAtArrival ? admittedOwner() : null;
    }

    public synchronized boolean isCurrentRenderer(long bridge, int generation) {
        return bridge == bridgeGeneration && generation == rendererGeneration;
    }

    public synchronized boolean boundTo(long bridge, int generation, String owner, String expectedSession) {
        return bridge == bridgeGeneration && generation == rendererGeneration && owner != null && owner.equals(bindingId)
                && session != null && session.equals(expectedSession);
    }

    /** Native protected-activity hook. A cold or replaced bridge cannot inherit a Power gesture. */
    public synchronized boolean recordProtectedPower(long bridge, long now, boolean lockedAtArrival) {
        if (bridge != bridgeGeneration || bridgeGeneration <= 0 || rendererGeneration <= 0 || bindingId == null || session == null) return false;
        clear();
        origin = POWER; invocationSession = session; arrivedAt = now; locked = lockedAtArrival;
        return true;
    }

    /** Renderer may drop only its own pending Power receipt, never listener delivery or another owner. */
    public synchronized void discardProtectedPower(long bridge, int generation, String owner, String expectedSession) {
        if (bridge == bridgeGeneration && generation == rendererGeneration && owner != null
                && owner.equals(bindingId) && session != null && session.equals(expectedSession)
                && POWER.equals(origin) && session.equals(invocationSession)) clear();
    }

    /** The origins that may start a voice turn. */
    private static boolean startsVoice(String origin) { return LISTENER.equals(origin) || SYSTEM.equals(origin) || POWER.equals(origin); }

    /**
     * Returns null after consumption. Unknown or changed ownership never returns a voice origin
     * ({@link #LISTENER}, {@link #SYSTEM} or {@link #POWER}); it returns {@link #ASSIST}.
     */
    public synchronized String take(long bridge, int generation, String owner, String expectedSession, long now, boolean lockedNow) {
        if (bridge != bridgeGeneration || generation != rendererGeneration) return null;
        if (owner == null || !owner.equals(bindingId)) return null;
        if (origin == null) return null;
        long window = adopted ? COLD_WINDOW_MS : WINDOW_MS;
        boolean ownerUnchanged = !adopted || coldOwner != null && coldOwner.equals(admittedOwner());
        String result = startsVoice(origin) && session != null && session.equals(expectedSession)
                && session.equals(invocationSession) && !locked && !lockedNow && now >= arrivedAt
                && now - arrivedAt <= window && ownerUnchanged ? origin : ASSIST;
        clear();
        return result;
    }

    /** A voice origin recorded before an authenticated binding, with an admitted native owner. */
    private boolean coldWaiting() {
        return coldOwner != null && !adopted && startsVoice(origin) && invocationSession == null && !locked;
    }

    /** Keep, claim or drop a waiting cold invocation after a binding change; its origin is kept. */
    private void carry(String waitingOrigin, String waitingOwner, long waitingSince, String next, long now) {
        if (now == NO_CLOCK || now < waitingSince || now - waitingSince > COLD_WINDOW_MS) { clear(); return; }
        if (next == null) {
            // Still unauthenticated (or a disposed renderer's cleanup): keep waiting.
            origin = waitingOrigin; invocationSession = null; arrivedAt = waitingSince; locked = false; coldOwner = waitingOwner; adopted = false;
            return;
        }
        if (!waitingOwner.equals(admittedOwner())) { clear(); return; }
        origin = waitingOrigin; invocationSession = next; arrivedAt = waitingSince; locked = false; coldOwner = waitingOwner; adopted = true;
    }

    private String admittedOwner() {
        OwnerAdmission current = admission;
        if (current == null) return null;
        try {
            String owner = current.currentOwner();
            return owner != null && !owner.isEmpty() && owner.length() <= 256 ? owner : null;
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    private void clear() {
        origin = null;
        invocationSession = null;
        arrivedAt = 0;
        locked = true;
        coldOwner = null;
        adopted = false;
    }
}
