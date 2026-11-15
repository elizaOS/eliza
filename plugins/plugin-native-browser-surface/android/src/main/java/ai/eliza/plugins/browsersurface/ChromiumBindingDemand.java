package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.List;

/**
 * The owned-Chromium binding's state machine: who holds it, when it binds, retries, becomes ready
 * and is released. The host's standing {@link #pin()} (the old always-on {@code start()}) and open
 * {@link Hold}s (a page or a task that needs the browser now) each keep the binding wanted. When
 * the last holder lets go, the binding stays for the idle delay, so a page that closes and the
 * next task that opens soon after share one warm browser; after the delay it is unbound, so
 * Android can freeze or reclaim the browser, and the next hold pays a cold start.
 *
 * <p>A ready callback belongs to its hold: it runs once, on the first verified connection while
 * the hold is open, and is dropped when the hold closes. It never runs when the browser refuses
 * the binding, is untrusted, or the demand is closed, so a caller that must not wait forever keeps
 * its own deadline and closes its hold at that deadline.
 *
 * <p>Plain JVM, not thread-safe: every call is made on one thread (Android's main thread), where
 * {@link ChromiumBrowserConnection} marshals its callers. {@link #isReady()} and
 * {@link #isClosed()} may be read from any thread.
 */
public final class ChromiumBindingDemand {
    static final long FIRST_RETRY_MILLIS = 1000;
    static final long MAX_RETRY_MILLIS = 30000;

    /** The outcome of one attempt to bind the browser service. */
    public enum BindResult {
        /** The binding is in place; a connection callback follows. */
        ACCEPTED,
        /** The system did not accept the binding now; retried with backoff while wanted. */
        REFUSED,
        /** The package or signing certificate does not match provisioning; not retried. */
        UNTRUSTED,
        /** The system denied the binding outright; not retried. */
        DENIED
    }

    /** The platform side: binding, unbinding and delayed work. */
    public interface Host {
        BindResult bind();
        void unbind();
        void schedule(Runnable task, long delayMillis);
        void cancel(Runnable task);
    }

    /** One holder's need for the browser; {@link #close()} lets it go. Idempotent. */
    public final class Hold implements AutoCloseable {
        private boolean open;

        private Hold(boolean open) { this.open = open; }

        public boolean isOpen() { return open; }

        /**
         * Runs {@code callback} once the verified service is connected: now when it already is,
         * otherwise on the next verified connection while this hold is open. Dropped when this
         * hold or the demand closes.
         */
        public void whenReady(Runnable callback) {
            if (!open || closed) return;
            if (ready) callback.run();
            else waiting.add(new Waiter(this, callback));
        }

        @Override public void close() {
            if (!open) return;
            open = false;
            waiting.removeIf(waiter -> waiter.hold == this);
            if (closed) return;
            leases--;
            if (!wanted()) releaseLater();
        }
    }

    private static final class Waiter {
        final Hold hold;
        final Runnable callback;

        Waiter(Hold hold, Runnable callback) {
            this.hold = hold;
            this.callback = callback;
        }
    }

    private final long idleMillis;
    private final Host host;
    private final Runnable reconnect = this::bind;
    private final Runnable idleRelease = this::releaseWhenIdle;
    private final List<Waiter> waiting = new ArrayList<>();
    private boolean pinned;
    private int leases;
    private boolean bound;
    private volatile boolean ready;
    private volatile boolean closed;
    private long retryMillis = FIRST_RETRY_MILLIS;

    public ChromiumBindingDemand(long idleMillis, Host host) {
        if (idleMillis < 0) throw new IllegalArgumentException("idleMillis must not be negative");
        this.idleMillis = idleMillis;
        this.host = host;
    }

    public long idleMillis() { return idleMillis; }

    public boolean wanted() { return pinned || leases > 0; }

    public boolean isBound() { return bound; }

    /** Whether the verified browser service is connected now (its warmup only requested). */
    public boolean isReady() { return ready; }

    /** How many ready callbacks are queued; a closed hold's callbacks are gone at once. */
    public int waitingCallbacks() { return waiting.size(); }

    /** Closed by the host or by a failed identity check; nothing binds again. */
    public boolean isClosed() { return closed; }

    /** Holds the binding until {@link #unpin()} or {@link #close()}; repeated pins are one hold. */
    public void pin() {
        if (closed) return;
        pinned = true;
        bindNow();
    }

    public void unpin() {
        if (closed || !pinned) return;
        pinned = false;
        if (!wanted()) releaseLater();
    }

    /** Holds the binding until the hold closes. After {@link #close()} the hold is already closed. */
    public Hold acquire() {
        if (closed) return new Hold(false);
        leases++;
        bindNow();
        return new Hold(true);
    }

    /** Whether a connection callback belongs to the current binding (not a late or closed one). */
    public boolean awaitingConnection() { return !closed && bound; }

    /** The current binding connected to the verified browser: ready, and run the waiting callbacks. */
    public void connected() {
        if (!awaitingConnection()) return;
        retryMillis = FIRST_RETRY_MILLIS;
        ready = true;
        List<Waiter> due = new ArrayList<>(waiting);
        waiting.clear();
        for (Waiter waiter : due) {
            if (closed || !ready) break;
            if (waiter.hold.open) waiter.callback.run();
        }
    }

    /** The service process went away; Android keeps the binding and reconnects it. */
    public void disconnected() { ready = false; }

    /** The binding died or was refused at connection: unbind and retry while wanted. */
    public void bindingLost() {
        unbind();
        retry();
    }

    /** Ends every hold for good and unbinds. */
    public void close() {
        closed = true;
        waiting.clear();
        host.cancel(reconnect);
        host.cancel(idleRelease);
        unbind();
    }

    private void bindNow() {
        host.cancel(idleRelease);
        bind();
    }

    private void releaseLater() {
        host.cancel(idleRelease);
        host.schedule(idleRelease, idleMillis);
    }

    private void releaseWhenIdle() {
        if (closed || wanted()) return;
        host.cancel(reconnect);
        retryMillis = FIRST_RETRY_MILLIS;
        unbind();
    }

    private void bind() {
        if (closed || bound || !wanted()) return;
        BindResult result = host.bind();
        if (result == BindResult.ACCEPTED) bound = true;
        else if (result == BindResult.REFUSED) retry();
        else host.cancel(reconnect);
    }

    private void retry() {
        if (closed || !wanted()) return;
        host.cancel(reconnect);
        host.schedule(reconnect, retryMillis);
        retryMillis = Math.min(retryMillis * 2, MAX_RETRY_MILLIS);
    }

    private void unbind() {
        ready = false;
        if (!bound) return;
        bound = false;
        host.unbind();
    }
}
