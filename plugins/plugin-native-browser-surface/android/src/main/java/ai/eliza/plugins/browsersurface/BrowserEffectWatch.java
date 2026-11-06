package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * The WebView's network watch after a task fill, click, select or scroll: the same rule as
 * packages/os/browser/src/effect-watch.mjs, fed by {@code shouldInterceptRequest}, which sees
 * every frame's requests at their start. A request the page starts before the person takes
 * over is a violation when it is not a GET or HEAD or goes to another site; a commit the page
 * reports as consented is let through once. The watch lasts until the binding expires, the
 * next task effect or a new main-frame document. Thread-safe: requests arrive on a network
 * thread, commands on the main thread.
 */
public final class BrowserEffectWatch {
    /** What shouldInterceptRequest never sees. */
    public static final List<String> UNSEEN =
            Collections.unmodifiableList(Arrays.asList("websocket", "service-worker", "webrtc"));

    private static final class Request {
        final String url;
        final String method;
        final long at;

        Request(String url, String method, long at) {
            this.url = url;
            this.method = method.toUpperCase(Locale.ROOT);
            this.at = at;
        }
    }

    private static final class Watch {
        final String origin;
        final String scope;
        final long startedAt;
        final long expiresAt;
        long closedAt = Long.MAX_VALUE;
        final List<Request> candidates = new ArrayList<>();
        String violation;

        Watch(String origin, String scope, long startedAt, long expiresAt, String violation) {
            this.origin = origin;
            this.scope = scope;
            this.startedAt = startedAt;
            this.expiresAt = expiresAt;
            this.violation = violation;
        }
    }

    private Watch watch;

    /** Starts a watch before a task effect is dispatched; returns the token for {@link #cancel}. */
    public synchronized Object arm(String origin, String scope, long now, long expiresAt) {
        Watch previous = watch;
        watch = new Watch(origin, scope, now, expiresAt,
                previous != null && previous.scope.equals(scope) ? previous.violation : null);
        return new Object[] {watch, previous};
    }

    /** The effect was refused before it reached the page: the earlier watch still holds. */
    public synchronized void cancel(Object token) {
        Object[] pair = (Object[]) token;
        if (watch == pair[0]) watch = (Watch) pair[1];
    }

    /** A new main-frame document: nothing from the watched one can run any more. */
    public synchronized void close(long at) {
        if (watch != null) watch.closedAt = Math.min(watch.closedAt, at);
    }

    /** One request at its start, from any frame. */
    public synchronized void observe(String url, String method, long at) {
        Request request = new Request(url, method == null ? "GET" : method, at);
        if (watch == null || request.at < watch.startedAt || request.at >= watch.expiresAt
                || request.at >= watch.closedAt || !violates(request, watch.origin)) return;
        watch.candidates.add(request);
    }

    /**
     * The violation for this binding, judged against the person's presses and her first
     * activated control (epoch milliseconds) and the consented commit URLs the page reports.
     */
    public synchronized String read(String scope, long[] presses, Long activatedAt, List<String> consentedUrls) {
        if (watch == null || !watch.scope.equals(scope)) return null;
        List<String> consented = new ArrayList<>(consentedUrls);
        for (Request request : watch.candidates) {
            if (watch.violation != null || byPerson(request.at, presses, activatedAt)) continue;
            int excused = -1;
            for (int i = 0; i < consented.size() && excused < 0; i++)
                if (samePath(request.url, consented.get(i))) excused = i;
            if (excused >= 0) consented.remove(excused);
            else watch.violation = "request";
        }
        watch.candidates.clear();
        return watch.violation;
    }

    private static boolean violates(Request request, String pageOrigin) {
        if (!request.method.equals("GET") && !request.method.equals("HEAD")) return true;
        try {
            String host = new URI(request.url).getHost();
            String page = new URI(pageOrigin).getHost();
            return host == null || page == null || !sameSite(host, page);
        } catch (Exception error) {
            return true;
        }
    }

    /** As effect-watch.mjs: the last two or three host labels match. */
    private static boolean sameSite(String host, String page) {
        return host.equals(page) || tail(host, 2).equals(tail(page, 2)) || tail(host, 3).equals(tail(page, 3));
    }

    private static String tail(String host, int count) {
        String[] labels = host.split("\\.");
        return String.join(".", Arrays.asList(labels).subList(Math.max(0, labels.length - count), labels.length));
    }

    private static boolean byPerson(long at, long[] presses, Long activatedAt) {
        if (activatedAt != null && at >= activatedAt) return true;
        for (long press : presses) if (at - press >= 0 && at - press <= 1500) return true;
        return false;
    }

    private static boolean samePath(String url, String other) {
        try {
            URI a = new URI(url);
            URI b = new URI(other);
            return a.getScheme() != null && a.getScheme().equalsIgnoreCase(b.getScheme())
                    && a.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
                    && a.getPort() == b.getPort() && String.valueOf(a.getPath()).equals(String.valueOf(b.getPath()));
        } catch (Exception error) {
            return false;
        }
    }
}
