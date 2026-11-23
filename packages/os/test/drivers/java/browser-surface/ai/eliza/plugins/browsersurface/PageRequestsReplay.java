// spec/os/browser/surface/pageRequests.md, "Story: Answer what a page asks, once, only while it is mine"; spec/os/browser/surface/pageRequests.md, "Story: Let a site have the device, my files or a download only as I choose"; spec/os/browser/surface/pageRequests.md, "Story: Leave the page for another app or a full browser only when I choose"
package ai.eliza.plugins.browsersurface;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

public final class PageRequestsReplay {
    private static final String SITE = "https://example.test";
    private static final String TAPPED_LINK = "tel:+15550100";
    private static final String SAVED_URI = "content://downloads/public_downloads/1";

    private record Realm(String owner, String session, long epoch) {
        static Realm of(Object raw) {
            Map<?, ?> m = (Map<?, ?>) raw;
            return new Realm((String) m.get("owner"), (String) m.get("session"), (Long) m.get("epoch"));
        }

        String json() {
            return "{\"owner\":" + quote(owner) + ",\"session\":" + quote(session) + ",\"epoch\":" + epoch + "}";
        }
    }

    private record Policy(String process, String storage, String key, String layer, boolean answersRequests, boolean interceptsNavigation) {
        static Policy of(Object raw) {
            Map<?, ?> m = (Map<?, ?>) raw;
            Map<?, ?> storage = (Map<?, ?>) m.get("storage");
            return new Policy((String) m.get("process"), (String) storage.get("tag"), (String) storage.get("key"), (String) m.get("layer"),
                    (Boolean) m.get("answersRequests"), (Boolean) m.get("interceptsNavigation"));
        }

        String json() {
            String store = key == null ? "{\"tag\":" + quote(storage) + "}" : "{\"tag\":" + quote(storage) + ",\"key\":" + quote(key) + "}";
            return "{\"process\":" + quote(process) + ",\"storage\":" + store + ",\"layer\":" + quote(layer)
                    + ",\"answersRequests\":" + answersRequests + ",\"interceptsNavigation\":" + interceptsNavigation + "}";
        }
    }

    private static final class Surface {
        final String id;
        final Realm realm;
        final long gen;
        final Policy policy;
        boolean presented, paused;
        String href;

        Surface(String id, Realm realm, long gen, Policy policy, String href) {
            this.id = id;
            this.realm = realm;
            this.gen = gen;
            this.policy = policy;
            this.href = href;
        }

        String json() {
            return "{\"id\":" + quote(id) + ",\"realm\":" + realm.json() + ",\"gen\":" + gen + ",\"policy\":" + policy.json()
                    + ",\"presented\":" + presented + ",\"paused\":" + paused + ",\"hostRectsSet\":false"
                    + ",\"bounds\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0}"
                    + ",\"clip\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0,\"topLeft\":0,\"topRight\":0,\"bottomRight\":0,\"bottomLeft\":0}"
                    + ",\"hostRects\":[],\"page\":{\"href\":" + quote(href) + ",\"result\":\"PageLoading\"}}";
        }
    }

    private static final class Request {
        final long id;
        final String surface;
        final long gen;
        final String kind;
        String status;
        BrowserSitePrompt.Plan plan;

        Request(long id, String surface, long gen, String kind, String status) {
            this.id = id;
            this.surface = surface;
            this.gen = gen;
            this.kind = kind;
            this.status = status;
        }

        String json() {
            String shown = status.startsWith("PermissionAnswered:")
                    ? "{\"tag\":\"PermissionAnswered\",\"answer\":" + quote(status.substring("PermissionAnswered:".length())) + "}"
                    : "{\"tag\":" + quote(status) + "}";
            return "{\"id\":" + id + ",\"surface\":" + quote(surface) + ",\"gen\":" + gen + ",\"kind\":" + quote(kind) + ",\"status\":" + shown + "}";
        }
    }

    private Boolean isolatedRenderer, multiProfile;
    private final List<Realm> leases = new ArrayList<>();
    private final List<Surface> surfaces = new ArrayList<>();
    private long surfacesIssued;
    private final List<Request> requests = new ArrayList<>();
    private long issued;
    private long picker;
    private final BrowserDownloadPolicy.History downloads = new BrowserDownloadPolicy.History();
    private final List<String> out = new ArrayList<>();

    private void reset() {
        isolatedRenderer = null;
        multiProfile = null;
        leases.clear();
        surfaces.clear();
        surfacesIssued = 0;
        requests.clear();
        issued = 0;
        picker = 0;
        downloads.clear();
    }

    private Surface surface(String id) {
        for (Surface x : surfaces) if (x.id.equals(id)) return x;
        return null;
    }

    private boolean admits(Realm realm) {
        return leases.contains(realm);
    }

    private boolean owns(Realm realm, String id) {
        Surface x = surface(id);
        return admits(realm) && x != null && x.realm.equals(realm);
    }

    private static boolean active(String status) {
        return status.equals("Waiting") || status.equals("PickerOpen") || status.equals("AskingAndroid");
    }

    private static boolean shownOnly(String kind) {
        return !kind.equals("OtherApp") && !kind.equals("BlockedSignIn");
    }

    private static boolean oneAtATime(String kind) {
        return !kind.equals("Dialog") && !kind.equals("SitePermission");
    }

    private static String ended(String kind) {
        return switch (kind) {
            case "Dialog" -> "DialogCancelled";
            case "FileChoice" -> "NoFiles";
            case "SitePermission" -> "PermissionAnswered:Ended";
            case "Download", "OtherApp", "BlockedSignIn" -> "Dismissed";
            default -> throw new IllegalArgumentException("unknown request kind " + kind);
        };
    }

    private static boolean foregrounded(Surface x) {
        return x.presented && !x.paused;
    }

    private static boolean allowedOn(Surface x, String kind) {
        return x.policy.answersRequests() && (!shownOnly(kind) || x.presented) && (!kind.equals("Dialog") || !x.paused);
    }

    private boolean mayHold(Request r) {
        Surface x = surface(r.surface);
        return x != null && x.gen == r.gen && allowedOn(x, r.kind);
    }

    private static BrowserSitePrompt.Plan sitePlan(Surface x) {
        return BrowserSitePrompt.plan(SITE, List.of(BrowserSitePrompt.CAMERA), x.policy.answersRequests() && foregrounded(x), true,
                kind -> BrowserSitePrompt.androidPermissions(kind).length > 0, (origin, kind) -> null);
    }

    private boolean holds(Surface x, String kind, int waiting) {
        boolean answers = x.policy.answersRequests();
        return switch (kind) {
            case "Dialog" -> BrowserPageHandoffs.dialogMayWait(answers, foregrounded(x), waiting);
            case "SitePermission" -> !sitePlan(x).asked.isEmpty() && waiting < BrowserPageHandoffs.MAX_PENDING_DIALOGS;
            case "FileChoice" -> answers && foregrounded(x);
            case "Download" -> answers && x.presented && new BrowserPageHandoffs.Download(SITE + "/report.pdf", "report.pdf", "application/pdf", -1).url != null;
            case "OtherApp" -> answers && BrowserExternalLinkPolicy.decide(TAPPED_LINK, true, null, null, null, "ai.eliza.host", Set.of()) != BrowserExternalLinkPolicy.Handoff.REFUSE;
            case "BlockedSignIn" -> answers;
            default -> throw new IllegalArgumentException("unknown request kind " + kind);
        };
    }

    private void withdrawn(List<Request> gone) {
        for (Request r : gone)
            if (r.kind.equals("SitePermission"))
                out.add("{\"tag\":\"PermissionWithdrawn\",\"surface\":" + quote(r.surface) + ",\"request\":" + r.id + "}");
    }

    private void endUnheld() {
        List<Request> gone = new ArrayList<>();
        for (Request r : requests) if (active(r.status) && !mayHold(r)) gone.add(r);
        for (Request r : gone) r.status = ended(r.kind);
        for (Request r : requests) {
            Surface x = surface(r.surface);
            if (r.status.equals("Saving") && (x == null || x.gen != r.gen)) r.status = ended(r.kind);
        }
        withdrawn(gone);
    }

    private Request waitingOn(Map<?, ?> e, String kind) {
        Realm realm = Realm.of(e.get("realm"));
        String id = (String) e.get("id");
        long request = (Long) e.get("request");
        if (!owns(realm, id)) return null;
        for (Request r : requests)
            if (r.id == request && r.surface.equals(id) && r.kind.equals(kind) && r.status.equals("Waiting")) return r;
        return null;
    }

    private Request withStatus(long request, String status) {
        for (Request r : requests) if (r.id == request && r.status.equals(status)) return r;
        return null;
    }

    private boolean honoured(Policy policy) {
        if (isolatedRenderer == null) return false;
        return (!policy.process().equals("IsolatedProcess") || isolatedRenderer) && (policy.storage().equals("HostStorage") || multiProfile);
    }

    private static String sitePermissionOutcome(boolean missing, boolean androidAnswered) {
        if (!missing) return "Granted";
        return androidAnswered ? "AndroidRefused" : "Ended";
    }

    private boolean apply(Map<?, ?> e) {
        String type = (String) e.get("type");
        switch (type) {
            case "learnSupport" -> {
                if (isolatedRenderer != null) return false;
                isolatedRenderer = (Boolean) e.get("isolatedRenderer");
                multiProfile = (Boolean) e.get("multiProfile");
                endUnheld();
            }
            case "reconcileOwner" -> {
                Realm realm = Realm.of(e.get("realm"));
                List<?> desired = (List<?>) e.get("desiredIds");
                if (realm.owner().isEmpty() || realm.session().isEmpty() || realm.epoch() <= 0) return false;
                for (Realm c : leases)
                    if (c.owner().equals(realm.owner()) && !(realm.epoch() > c.epoch() || (realm.epoch() == c.epoch() && realm.session().equals(c.session()))))
                        return false;
                leases.removeIf(c -> c.owner().equals(realm.owner()));
                leases.add(realm);
                surfaces.removeIf(x -> x.realm.owner().equals(realm.owner()) && !(x.realm.equals(realm) && desired.contains(x.id)));
                for (Surface x : surfaces) if (x.realm.owner().equals(realm.owner())) x.presented = false;
                endUnheld();
            }
            case "createSurface" -> {
                Realm realm = Realm.of(e.get("realm"));
                String id = (String) e.get("id");
                Policy policy = Policy.of(e.get("policy"));
                boolean validStorage = !(policy.storage().equals("KeyedProfile") && "".equals(policy.key()));
                if (!admits(realm) || id.isEmpty() || surface(id) != null || !honoured(policy) || !validStorage) return false;
                surfaces.add(new Surface(id, realm, ++surfacesIssued, policy, (String) e.get("url")));
                endUnheld();
            }
            case "presentSurface" -> {
                Realm realm = Realm.of(e.get("realm"));
                String id = (String) e.get("id");
                if (!admits(realm) || !(id.isEmpty() || owns(realm, id))) return false;
                for (Surface x : surfaces) if (x.realm.owner().equals(realm.owner())) x.presented = x.id.equals(id);
                endUnheld();
            }
            case "pauseSurface", "resumeSurface", "destroySurface" -> {
                Realm realm = Realm.of(e.get("realm"));
                String id = (String) e.get("id");
                if (!owns(realm, id)) return false;
                switch (type) {
                    case "pauseSurface" -> surface(id).paused = true;
                    case "resumeSurface" -> surface(id).paused = false;
                    default -> surfaces.removeIf(x -> x.id.equals(id));
                }
                endUnheld();
            }
            case "pageStarted" -> {
                String id = (String) e.get("id");
                String href = (String) e.get("href");
                Surface x = surface(id);
                if (x == null) return false;
                List<Request> gone = new ArrayList<>();
                for (Request r : requests) if (active(r.status) && r.gen == x.gen) gone.add(r);
                for (Request r : gone) r.status = ended(r.kind);
                x.href = href;
                withdrawn(gone);
                out.add("{\"tag\":\"Started\",\"surface\":" + quote(id) + ",\"href\":" + quote(href) + "}");
            }
            case "pageAsks" -> {
                String id = (String) e.get("id");
                String kind = (String) e.get("kind");
                Surface x = surface(id);
                if (x == null) return false;
                int waiting = 0;
                for (Request r : requests) if (r.gen == x.gen && r.kind.equals(kind) && active(r.status)) waiting++;
                boolean held = holds(x, kind, waiting);
                if (held && oneAtATime(kind))
                    for (Request r : requests) if (r.gen == x.gen && r.kind.equals(kind) && active(r.status)) r.status = ended(kind);
                Request asked = new Request(++issued, id, x.gen, kind, held ? "Waiting" : ended(kind));
                if (held && kind.equals("SitePermission")) asked.plan = sitePlan(x);
                requests.add(asked);
                if (held) out.add("{\"tag\":\"Asked\",\"surface\":" + quote(id) + ",\"request\":" + asked.id + ",\"kind\":" + quote(kind) + "}");
            }
            case "withdrawSitePermission" -> {
                long request = (Long) e.get("request");
                Request r = null;
                for (Request c : requests) if (c.id == request && c.kind.equals("SitePermission") && active(c.status)) r = c;
                if (r == null) return false;
                r.status = "PermissionAnswered:Ended";
                withdrawn(List.of(r));
            }
            case "answerDialog" -> {
                Request r = waitingOn(e, "Dialog");
                if (r == null) return false;
                r.status = (Boolean) e.get("accept") ? "DialogAccepted" : "DialogCancelled";
            }
            case "answerSitePermission" -> {
                Request r = waitingOn(e, "SitePermission");
                if (r == null) return false;
                r.status = r.plan.granted((Boolean) e.get("grant")).isEmpty() ? "PermissionAnswered:Denied" : "AskingAndroid";
            }
            case "androidAnswered" -> {
                Request r = withStatus((Long) e.get("request"), "AskingAndroid");
                if (r == null) return false;
                String reply = (String) e.get("reply");
                r.status = "PermissionAnswered:" + sitePermissionOutcome(!reply.equals("AndroidAllows"), reply.equals("AndroidRefuses"));
            }
            case "answerFileChooser" -> {
                Request r = waitingOn(e, "FileChoice");
                boolean open = (Boolean) e.get("open");
                if (r == null || (open && picker != 0)) return false;
                r.status = open ? "PickerOpen" : "NoFiles";
                if (open) picker = r.id;
            }
            case "pickerReturned" -> {
                if (picker == 0) return false;
                Request r = withStatus(picker, "PickerOpen");
                if (r != null) r.status = (Boolean) e.get("picked") ? "FilesGiven" : "NoFiles";
                picker = 0;
            }
            case "saveDownload" -> {
                Request r = waitingOn(e, "Download");
                if (r == null) return false;
                if (!downloads.add(new BrowserDownloadPolicy.Entry(r.id, "report.pdf", SITE, false, null).started()))
                    throw new IllegalStateException("the download list has no room");
                r.status = "Saving";
            }
            case "downloadFinished" -> {
                Request r = withStatus((Long) e.get("request"), "Saving");
                if (r == null) return false;
                BrowserDownloadPolicy.Entry entry = downloads.get(r.id).finished((Boolean) e.get("published") ? SAVED_URI : null);
                downloads.replace(entry);
                r.status = entry.failed ? "SaveFailed" : "Saved";
                Surface x = surface(r.surface);
                if (x != null && x.gen == r.gen)
                    out.add("{\"tag\":\"DownloadFinished\",\"surface\":" + quote(r.surface) + ",\"request\":" + r.id + ",\"saved\":" + !entry.failed + "}");
            }
            case "openExternalLink", "openIdentityProvider" -> {
                Request r = waitingOn(e, type.equals("openExternalLink") ? "OtherApp" : "BlockedSignIn");
                if (r == null) return false;
                r.status = (Boolean) e.get("found") ? "Dispatched" : "NoHandler";
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        }
        return true;
    }

    private String state() {
        String support = isolatedRenderer == null ? "{\"tag\":\"SupportUnknown\"}"
                : "{\"tag\":\"Supports\",\"isolatedRenderer\":" + isolatedRenderer + ",\"multiProfile\":" + multiProfile + "}";
        List<String> realms = new ArrayList<>(), shown = new ArrayList<>(), held = new ArrayList<>();
        for (Realm r : leases) realms.add(r.json());
        for (Surface x : surfaces) shown.add(x.json());
        for (Request r : requests) held.add(r.json());
        String pick = picker == 0 ? "{\"tag\":\"PickerIdle\"}" : "{\"tag\":\"PickerFor\",\"request\":" + picker + "}";
        return "{\"host\":{\"support\":" + support + ",\"leases\":[" + String.join(",", realms) + "],\"surfaces\":[" + String.join(",", shown)
                + "],\"issued\":" + surfacesIssued + ",\"keyboard\":{\"visible\":false,\"height\":0}},\"requests\":[" + String.join(",", held)
                + "],\"issued\":" + issued + ",\"picker\":" + pick + "}";
    }

    private String answer(String line) {
        out.clear();
        Map<?, ?> request = (Map<?, ?>) new Json(line).value();
        Object event = request.get("event");
        if (event == null) {
            reset();
            return "{\"state\":" + state() + ",\"out\":[]}";
        }
        boolean accepted = apply((Map<?, ?>) event);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + ",\"out\":[" + String.join(",", out) + "]}";
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : Objects.requireNonNull(s).toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    private static final class Json {
        private final String text;
        private int at;

        Json(String text) {
            this.text = text;
        }

        Object value() {
            space();
            char c = text.charAt(at);
            if (c == '{') {
                at++;
                Map<String, Object> map = new LinkedHashMap<>();
                space();
                if (text.charAt(at) == '}') { at++; return map; }
                while (true) {
                    space();
                    String key = string();
                    space();
                    expect(':');
                    map.put(key, value());
                    space();
                    if (text.charAt(at++) == '}') return map;
                }
            }
            if (c == '[') {
                at++;
                List<Object> list = new ArrayList<>();
                space();
                if (text.charAt(at) == ']') { at++; return list; }
                while (true) {
                    list.add(value());
                    space();
                    if (text.charAt(at++) == ']') return list;
                }
            }
            if (c == '"') return string();
            if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
            if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
            if (text.startsWith("null", at)) { at += 4; return null; }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            return Long.parseLong(text.substring(start, at));
        }

        private String string() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                char c = text.charAt(at++);
                if (c == '"') return b.toString();
                if (c != '\\') { b.append(c); continue; }
                char escaped = text.charAt(at++);
                switch (escaped) {
                    case 'n' -> b.append('\n');
                    case 't' -> b.append('\t');
                    case 'r' -> b.append('\r');
                    case 'b' -> b.append('\b');
                    case 'f' -> b.append('\f');
                    case 'u' -> { b.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); at += 4; }
                    default -> b.append(escaped);
                }
            }
        }

        private void expect(char c) {
            if (text.charAt(at++) != c) throw new IllegalArgumentException("expected " + c + " at " + (at - 1) + " in " + text);
        }

        private void space() {
            while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++;
        }
    }

    public static void main(String[] args) throws Exception {
        PageRequestsReplay replay = new PageRequestsReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line = input.readLine(); line != null; line = input.readLine()) {
            String reply;
            try {
                reply = replay.answer(line);
            } catch (RuntimeException failure) {
                reply = "{\"error\":" + quote(String.valueOf(failure)) + "}";
            }
            System.out.println(reply);
            System.out.flush();
        }
    }
}
