package ai.eliza.plugins.browsersurface;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.Locale;

/**
 * The WebView's network watch after a task fill, click, select or scroll: the same rule as
 * packages/os/browser/src/effect-watch.mjs, fed by {@code shouldInterceptRequest}, which sees
 * every frame's requests at their start. A request the page starts before the person takes
 * over is a violation when it is not a GET or HEAD; after a click, also a GET to another site.
 * A main-frame GET navigation is left to the page's own watch and the navigation gate. The one
 * commit a grant consents is let through once, known from the grant and from the page's click
 * result, so it never waits for the page to see the request complete. The watch lasts until
 * the binding expires, the next task effect or a new main-frame document. As in effect-watch.mjs,
 * a request to another site that is not a top-level navigation counts only within
 * {@link #CROSS_SITE_WINDOW_MS} of the effect, and a cross-site image or stylesheet read never
 * (known by its Accept header; the WebView names no request type), so a site's own analytics and
 * CDN traffic do not pause the task. Thread-safe: requests arrive on a network thread, commands
 * on the main thread.
 */
public final class BrowserEffectWatch {
    /** What shouldInterceptRequest never sees. */
    public static final List<String> UNSEEN =
            Collections.unmodifiableList(Arrays.asList("websocket", "service-worker", "webrtc"));

    /** How long after an effect a request to another site can be its doing. */
    public static final long CROSS_SITE_WINDOW_MS = 30000;

    /** What the page reports of the person and of the granted commit (its watchHandoff). */
    public static final class Handoff {
        final long[] presses;
        final Long activatedAt;
        final List<String> consentedUrls;
        final String expectedUrl;
        final String expectedMethod;
        final boolean expectedExact;

        public Handoff(long[] presses, Long activatedAt, List<String> consentedUrls,
                String expectedUrl, String expectedMethod, boolean expectedExact) {
            this.presses = presses == null ? new long[0] : presses;
            this.activatedAt = activatedAt;
            this.consentedUrls = consentedUrls == null ? Collections.<String>emptyList() : consentedUrls;
            this.expectedUrl = expectedUrl;
            this.expectedMethod = expectedMethod;
            this.expectedExact = expectedExact;
        }

        public static final Handoff NONE = new Handoff(null, null, null, null, null, false);
    }

    private static final class Request {
        final String url;
        final String method;
        final long at;
        /** An image or stylesheet load: it reads what the page shows. */
        final boolean passive;

        Request(String url, String method, long at, String accept) {
            this.url = url;
            this.method = method.toUpperCase(Locale.ROOT);
            this.at = at;
            String type = accept == null ? "" : accept.trim().toLowerCase(Locale.ROOT);
            this.passive = type.startsWith("image/") || type.startsWith("text/css");
        }
    }

    /** One address the granted commit may have; a null method matches any. */
    private static final class Allowed {
        final String url;
        final String method;
        final boolean exact;

        Allowed(String url, String method, boolean exact) {
            this.url = url;
            this.method = method == null ? null : method.toUpperCase(Locale.ROOT);
            this.exact = exact;
        }
    }

    private static final class Watch {
        final String origin;
        final String scope;
        final boolean click;
        final long startedAt;
        final long expiresAt;
        long closedAt = Long.MAX_VALUE;
        final List<Request> candidates = new ArrayList<>();
        /** The page sends all its presses each time; a set keeps each once. */
        final Set<Long> presses = new LinkedHashSet<>();
        long activatedAt = Long.MAX_VALUE;
        /** Null without a grant: then nothing the page reports excuses a request. */
        final List<Allowed> granted;
        boolean grantSpent;
        String violation;
        /** The earlier effect of this binding, judged once this effect's result arrives. */
        Watch previous;

        Watch(String origin, String scope, boolean click, long startedAt, long expiresAt,
                List<Allowed> granted, String violation, Watch previous) {
            this.origin = origin;
            this.scope = scope;
            this.click = click;
            this.startedAt = startedAt;
            this.expiresAt = expiresAt;
            this.granted = granted;
            this.violation = violation;
            this.previous = previous;
        }
    }

    private Watch watch;

    /**
     * Starts a watch before a task effect is dispatched; returns the token for {@link #cancel}.
     * {@code granted} says the effect carries a commit grant; {@code targetUrl} and
     * {@code targetMethod} are its request target, if it names one (a path is resolved against
     * the page's origin).
     */
    public synchronized Object arm(String origin, String scope, String subaction, long now, long expiresAt,
            boolean granted, String targetUrl, String targetMethod) {
        Watch previous = watch;
        // The earlier effect is judged once this effect's result hands over what the page saw of
        // her since the last read (report), or at the next read; one before it is judged now.
        if (previous != null) settlePrevious(previous);
        boolean sameBinding = previous != null && previous.scope.equals(scope);
        List<Allowed> allowed = null;
        if (granted) {
            allowed = new ArrayList<>();
            if (targetUrl != null) allowed.add(new Allowed(resolve(origin, targetUrl), targetMethod, true));
        }
        watch = new Watch(origin, scope, "click".equals(subaction), now, expiresAt, allowed,
                sameBinding ? previous.violation : null, sameBinding ? previous : null);
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
    public synchronized void observe(String url, String method, boolean mainFrame, long at) {
        observe(url, method, mainFrame, at, null);
    }

    /** One request at its start, with its Accept header, which tells an image or style load. */
    public synchronized void observe(String url, String method, boolean mainFrame, long at, String accept) {
        Request request = new Request(url, method == null ? "GET" : method, at, accept);
        if (watch == null || request.at < watch.startedAt || request.at >= watch.expiresAt
                || request.at >= watch.closedAt || !violates(request, mainFrame, watch)) return;
        watch.candidates.add(request);
    }

    /** Adds what a task effect's own result reports, without judging. */
    public synchronized void report(String scope, Handoff handoff) {
        report(scope, handoff, null, null);
    }

    /**
     * Adds what a task effect's own result reports, without judging. {@code previous} is what
     * the page's earlier watch (of binding {@code previousScope}) saw up to this effect; it goes
     * to the earlier effect's watch alone, which is then judged, so her press never excuses this
     * effect's requests.
     */
    public synchronized void report(String scope, Handoff handoff, String previousScope, Handoff previous) {
        if (watch == null || !watch.scope.equals(scope)) return;
        if (watch.previous != null && previous != null && watch.previous.scope.equals(previousScope))
            merge(watch.previous, previous);
        settlePrevious(watch);
        merge(watch, handoff);
    }

    /** The violation for this binding, judged after adding what the page reports. */
    public synchronized String read(String scope, Handoff handoff) {
        if (watch == null || !watch.scope.equals(scope)) return null;
        settlePrevious(watch);
        merge(watch, handoff);
        settle(watch);
        return watch.violation;
    }

    /** The effect before this watch's own: its verdict carries into this binding's watch. */
    private static void settlePrevious(Watch watch) {
        Watch previous = watch.previous;
        if (previous == null) return;
        watch.previous = null;
        settle(previous);
        if (watch.violation == null) watch.violation = previous.violation;
    }

    private static void merge(Watch watch, Handoff handoff) {
        if (handoff == null) return;
        for (long press : handoff.presses) watch.presses.add(press);
        if (handoff.activatedAt != null) watch.activatedAt = Math.min(watch.activatedAt, handoff.activatedAt);
        if (watch.granted == null) return;
        if (handoff.expectedUrl != null)
            watch.granted.add(new Allowed(handoff.expectedUrl, handoff.expectedMethod, handoff.expectedExact));
        for (String url : handoff.consentedUrls) if (url != null) watch.granted.add(new Allowed(url, null, false));
    }

    private static void settle(Watch watch) {
        for (Request request : watch.candidates) {
            if (watch.violation != null || byPerson(request.at, watch)) continue;
            if (watch.granted != null && !watch.grantSpent && allowed(request, watch.granted)) {
                watch.grantSpent = true;
                continue;
            }
            watch.violation = "request";
        }
        watch.candidates.clear();
    }

    private static boolean violates(Request request, boolean mainFrame, Watch watch) {
        boolean crossSite;
        try {
            String host = new URI(request.url).getHost();
            String page = new URI(watch.origin).getHost();
            crossSite = host == null || page == null || !sameSite(host, page);
        } catch (Exception error) {
            crossSite = true;
        }
        if (crossSite && !mainFrame && request.at - watch.startedAt > CROSS_SITE_WINDOW_MS) return false;
        if (!request.method.equals("GET") && !request.method.equals("HEAD")) return true;
        if (mainFrame || !watch.click) return false;
        return crossSite && !request.passive;
    }

    /** As effect-watch.mjs: the last two or three host labels match. */
    private static boolean sameSite(String host, String page) {
        return host.equals(page) || tail(host, 2).equals(tail(page, 2)) || tail(host, 3).equals(tail(page, 3));
    }

    private static String tail(String host, int count) {
        String[] labels = host.split("\\.");
        return String.join(".", Arrays.asList(labels).subList(Math.max(0, labels.length - count), labels.length));
    }

    private static boolean byPerson(long at, Watch watch) {
        if (at >= watch.activatedAt) return true;
        for (long press : watch.presses) if (at - press >= 0 && at - press <= 1500) return true;
        return false;
    }

    private static boolean allowed(Request request, List<Allowed> granted) {
        for (Allowed allowed : granted) {
            if (allowed.method != null && !allowed.method.equals(request.method)) continue;
            if (allowed.exact ? sameAddress(request.url, allowed.url) : samePath(request.url, allowed.url))
                return true;
        }
        return false;
    }

    private static String resolve(String origin, String url) {
        try {
            return new URI(origin).resolve(url).toString();
        } catch (Exception error) {
            return url;
        }
    }

    private static boolean sameAddress(String url, String other) {
        try {
            URI a = new URI(url);
            URI b = new URI(other);
            return samePath(url, other) && String.valueOf(a.getRawQuery()).equals(String.valueOf(b.getRawQuery()));
        } catch (Exception error) {
            return false;
        }
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
