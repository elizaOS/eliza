// spec/os/android/passwords/autofill.md, "Story: Fill a form only for its site, from my choice"; spec/os/android/passwords/autofill.md, "Story: Save a password only when I choose Save and unlock"
package ai.eliza.passwords;

import ai.eliza.plugins.passwords.PasswordFormPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Node;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Target;
import ai.eliza.plugins.passwords.PasswordMatching;
import ai.eliza.plugins.passwords.PasswordRequests;
import ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession;
import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class AutofillReplay {
    static final String HOST = "ai.example.host", BROWSER = "org.example.browser", OTHER = "org.example.other";
    static final long GRANT_MILLIS = 58_000;
    static final int TEXT = 1, TEXT_PASSWORD = 0x81, TEXT_EMAIL = 0x21, BOUNDS = 41;

    long now, grantNow;
    final PasswordRequests requests = new PasswordRequests(() -> now, new SecureRandom());
    final CredentialAccessSession grant = new CredentialAccessSession(() -> grantNow, GRANT_MILLIS);
    final List<String> tokens = new ArrayList<>();
    final Map<String, Boolean> fillTokens = new HashMap<>();
    final Set<String> delivered = new HashSet<>();
    final Map<String, String> specFacets = new HashMap<>();
    final Map<String, Integer> labels = new HashMap<>();
    Picker picker;
    Review review;
    Prompt prompt;
    long begun;
    int filled, saved;

    interface Owner {
        boolean finishing();
        void unlocked(long ticket);
        void failed();
    }

    final class Prompt {
        final Owner owner;
        final long ticket;
        boolean finished;
        Prompt(Owner owner, long ticket) { this.owner = owner; this.ticket = ticket; }
        void complete(boolean accepted) {
            if (finished) return;
            finished = true;
            if (accepted && !owner.finishing() && grant.complete(ticket, true)) owner.unlocked(ticket);
            else { grant.lock(ticket); owner.failed(); }
        }
    }

    long prompt(Owner owner) {
        long ticket = grant.begin();
        if (ticket == 0) { owner.failed(); return 0; }
        begun = ticket;
        prompt = new Prompt(owner, ticket);
        return ticket;
    }

    boolean challenging(long ticket) { return ticket != 0 && grant.pending() && begun == ticket; }

    void abandonPrompt(Owner owner) { if (prompt != null && prompt.owner == owner) prompt.complete(false); }

    final Owner other = new Owner() {
        public boolean finishing() { return false; }
        public void unlocked(long ticket) { }
        public void failed() { }
    };

    final class Picker implements Owner {
        final String token;
        Target target;
        long challenge, ticket;
        boolean prompting, finished, listed;
        Picker(String token) { this.token = token; }
        void create() {
            target = requests.takeFill(token);
            if (target == null) { cancel(); return; }
            prompting = true;
            challenge = prompt(this);
        }
        public boolean finishing() { return finished; }
        public void unlocked(long granted) { ticket = granted; prompting = false; if (!finished) listed = true; }
        public void failed() { prompting = false; if (!finished) cancel(); }
        boolean current() { return !finished && target != null && requests.currentFill(token) && grant.authenticated(ticket); }
        boolean offers(Binding entry) { return listed && current() && PasswordMatching.matches(entry.bindings, target, entry.signers); }
        void choose(Binding entry) {
            if (!current()) { cancel(); return; }
            boolean read = grant.authenticated(ticket) && PasswordMatching.matches(entry.bindings, target, entry.signers);
            if (!read || !current() || !requests.claimFill(token)) { cancel(); return; }
            finished = true;
            filled++;
            destroy();
        }
        void leave() {
            if (prompting) abandonPrompt(this);
            if (!prompting) cancel();
        }
        void cancel() {
            if (finished) return;
            finished = true;
            target = null;
            requests.cancelFill(token);
            grant.lock(ticket);
            destroy();
        }
        void destroy() {
            requests.cancelFill(token);
            grant.lock(ticket);
            abandonPrompt(this);
            if (picker == this) picker = null;
        }
    }

    final class Review implements Owner {
        PasswordRequests.SaveCapture captured;
        long challenge, ticket;
        boolean prompting, finished, writing;
        void create(String token) {
            captured = requests.takeSave(token);
            if (captured == null) close();
        }
        public boolean finishing() { return finished; }
        void save() {
            if (finished || captured == null) return;
            prompting = true;
            challenge = prompt(this);
        }
        public void unlocked(long granted) { ticket = granted; prompting = false; if (!finished) writing = true; }
        public void failed() { prompting = false; }
        void write(boolean persisted) {
            writing = false;
            if (grant.authenticated(ticket) && persisted) saved++;
            close();
        }
        void leave() {
            if (prompting) abandonPrompt(this);
            close();
        }
        void close() {
            if (finished) return;
            finished = true;
            captured = null;
            grant.lock(ticket);
            abandonPrompt(this);
            if (review == this) review = null;
        }
    }

    record Binding(List<String> bindings, PasswordMatching.SignerCheck signers) { }

    int label(String facet) { return labels.computeIfAbsent(facet, key -> labels.size()); }

    URI webFacet(String facet) {
        try {
            String canonical = PasswordFacets.web(facet);
            if (canonical.equals(facet)) return URI.create(canonical);
        } catch (IOException notAnOrigin) { }
        return URI.create("https://facet-" + label(facet) + ".test");
    }

    String appPackage(String facet) {
        try {
            PasswordFacets.android(facet, "0".repeat(64));
            return facet;
        } catch (IOException notAPackage) {
            return "encoded.facet" + label(facet);
        }
    }

    static String certificate(String packageName) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(packageName.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception unavailable) {
            throw new IllegalStateException(unavailable);
        }
    }

    static Node field(String id, int inputType) {
        Node node = new Node();
        node.id = id;
        node.text = true;
        node.inputType = inputType;
        return node;
    }

    static Node web(String domain, String scheme) {
        Node node = new Node();
        node.webDomain = domain;
        node.webScheme = scheme;
        return node;
    }

    static int count(Map<String, Object> form, String name) {
        int value = (int) number(form.get(name));
        if (value < 0) throw new IllegalArgumentException("no form has " + value + " " + name);
        return value;
    }

    record Form(String packageName, boolean hostIsBrowser, Node root, String expected) { }

    Form form(Map<String, Object> evidence, String facet, boolean save) {
        if (facet.isEmpty()) throw new IllegalArgumentException("no form proves an empty facet");
        String requester = (String) evidence.get("requester");
        boolean own = requester.equals("OwnBrowser");
        int passwords = count(evidence, "passwordFields"), entered = count(evidence, "enteredPasswords");
        int domains = count(evidence, "webDomains"), tops = count(evidence, "topOrigins");
        boolean agree = (Boolean) evidence.get("enteredAgree");
        if (save && (entered > passwords || (!agree && entered < 2)))
            throw new IllegalArgumentException("no form has " + passwords + " password fields with " + entered + " entered" + (agree ? "" : " that differ"));
        Node user = field("user", TEXT_EMAIL);
        List<Node> login = new ArrayList<>(List.of(user));
        for (int i = 0; i < passwords; i++) login.add(field("password-" + i, TEXT_PASSWORD));
        if (save) {
            user.value = "synthetic.user@example.test";
            for (int i = 0; i < entered; i++) login.get(i + 1).value = !agree && i == 1 ? "synthetic-value-2" : "synthetic-value-1";
        }
        Node root = new Node(), holder = root;
        String expected, top;
        if (domains == 0) {
            expected = appPackage(facet);
            top = "https://" + expected.replace('.', '-') + ".test";
            login.forEach(root::add);
        } else {
            URI site = webFacet(facet);
            if (!own && site.getPort() != -1) throw new IllegalArgumentException("only the host's own browser reports a port, for " + facet);
            expected = own ? site.toString() : "https://" + site.getHost();
            top = (Boolean) evidence.get("topHostMatches") ? expected : "https://elsewhere.test";
            holder = web(site.getHost(), (Boolean) evidence.get("httpsOnly") ? "https" : "http");
            root.add(holder);
            for (int i = 1; i < domains; i++) {
                Node frame = web("frame-" + i + ".test", "https");
                Node text = field("frame-field-" + i, TEXT);
                text.fieldOrigin = "https://frame-" + i + ".test";
                holder.add(frame.add(text));
            }
            String origin = (Boolean) evidence.get("fieldOriginsExact") ? expected : "https://elsewhere.test";
            if ((Boolean) evidence.get("loginFieldsWeb")) {
                for (Node node : login) { node.fieldOrigin = origin; holder.add(node); }
            } else {
                login.forEach(root::add);
                Node text = field("page-field", TEXT);
                text.fieldOrigin = origin;
                holder.add(text);
            }
        }
        for (int i = 0; i < tops; i++) {
            Node carrier = i == 0 ? holder : new Node();
            carrier.topOrigin = i == 0 ? top : "https://top-" + i + ".test";
            if (i > 0) holder.add(carrier);
        }
        if (!(Boolean) evidence.get("withinBounds"))
            for (int i = 0; i < BOUNDS; i++) root = new Node().add(root);
        String packageName = switch (requester) {
            case "OwnInterface", "OwnBrowser" -> HOST;
            case "TrustedBrowser" -> domains == 0 ? appPackage(facet) : BROWSER;
            case "OtherApp" -> domains == 0 ? appPackage(facet) : OTHER;
            default -> throw new IllegalArgumentException("unknown requester " + requester);
        };
        return new Form(packageName, own, root, expected);
    }

    Target evaluate(Map<String, Object> evidence, Form form, boolean save) {
        if (!(Boolean) evidence.get("admitted")) return null;
        try {
            return PasswordFormPolicy.evaluate(form.packageName(), HOST, form.hostIsBrowser(), form.root(), BROWSER::equals, save);
        } catch (PasswordFormPolicy.Rejected rejected) {
            return null;
        }
    }

    String issue(String token, boolean fill) {
        tokens.add(token);
        fillTokens.put(token, fill);
        return token;
    }

    void offerFill(Map<String, Object> evidence, String facet) {
        Form form = form(evidence, facet, false);
        Target target = evaluate(evidence, form, false);
        if (target == null) return;
        specFacets.put(form.expected(), facet);
        if (picker != null) picker.leave();
        issue(requests.offerFill(target), true);
    }

    void offerSave(Map<String, Object> evidence, String facet) {
        Form form = form(evidence, facet, true);
        Target target = evaluate(evidence, form, true);
        if (target == null) return;
        String signer = (Boolean) evidence.get("appSignerKnown") ? certificate(form.expected()) : null;
        String proved, expected;
        try {
            proved = target.web() ? target.webOrigin : PasswordFacets.android(target.appPackage, signer);
            expected = target.web() ? form.expected() : PasswordFacets.android(form.expected(), certificate(form.expected()));
        } catch (IOException unknownSigner) {
            return;
        }
        specFacets.put(expected, facet);
        issue(requests.offerSave(target, proved), false);
    }

    String token(long number) { return number >= 1 && number <= tokens.size() ? tokens.get((int) number - 1) : null; }

    boolean deliverable(String token, boolean fill) { return token != null && fillTokens.get(token) == fill && delivered.add(token); }

    void openFill(long number) {
        String token = token(number);
        Object pending = read(requests, "fill");
        if (pending == null || (Boolean) read(pending, "taken") || !read(pending, "token").equals(token)) return;
        if (!deliverable(token, true)) return;
        if (picker != null) picker.leave();
        picker = new Picker(token);
        picker.create();
    }

    void openSave(long number) {
        String token = token(number);
        if (review != null || !deliverable(token, false)) return;
        review = new Review();
        review.create(token);
    }

    Binding binding(Map<String, Object> entry) {
        String facet = (String) entry.get("facet");
        boolean confirmed = (Boolean) entry.get("signerConfirmed");
        return switch ((String) entry.get("kind")) {
            case "WebTarget" -> new Binding(List.of(webFacet(facet).toString()), (pkg, cert) -> false);
            case "AppTarget" -> {
                String pkg = appPackage(facet);
                try {
                    yield new Binding(List.of(PasswordFacets.android(pkg, certificate(pkg))), (named, cert) -> confirmed && cert.equals(certificate(named)));
                } catch (IOException invalid) {
                    throw new IllegalStateException(invalid);
                }
            }
            case "NoTarget" -> new Binding(List.of(), (pkg, cert) -> false);
            default -> throw new IllegalArgumentException("unknown binding " + entry.get("kind"));
        };
    }

    void deliverFill(long number, Map<String, Object> entry) {
        String token = token(number);
        Binding chosen = binding(entry);
        if (picker != null && picker.token.equals(token) && picker.offers(chosen)) picker.choose(chosen);
    }

    void cancelFill(long number) {
        String token = token(number);
        if (token == null) return;
        if (picker != null && picker.token.equals(token)) picker.leave();
        else requests.cancelFill(token);
    }

    void answerPrompt(long ticket, boolean accepted) {
        if (prompt != null && !prompt.finished && prompt.ticket == ticket && challenging(ticket)) prompt.complete(accepted);
    }

    void chooseSave() {
        if (review == null || review.writing) return;
        if (review.prompting) {
            if (challenging(review.challenge)) return;
            abandonPrompt(review);
        }
        review.save();
    }

    boolean apply(Map<String, Object> event) {
        switch ((String) event.get("type")) {
            case "advanceClock" -> { long next = number(event.get("now")); if (next > now) now = next; }
            case "offerFill" -> offerFill(object(event.get("form")), (String) event.get("facet"));
            case "offerSave" -> offerSave(object(event.get("form")), (String) event.get("facet"));
            case "openFill" -> openFill(number(event.get("token")));
            case "deliverFill" -> deliverFill(number(event.get("token")), object(event.get("binding")));
            case "cancelFill" -> cancelFill(number(event.get("token")));
            case "beginOtherUnlock" -> prompt(other);
            case "answerPrompt" -> answerPrompt(number(event.get("ticket")), (Boolean) event.get("accepted"));
            case "expireGrant" -> { if (grant.authenticated()) grantNow += GRANT_MILLIS; }
            case "openSave" -> openSave(number(event.get("token")));
            case "chooseSave" -> chooseSave();
            case "settleSave" -> { if (review != null && review.writing) review.write((Boolean) event.get("persisted")); }
            case "closeSave" -> { if (review != null) review.leave(); }
            case "lockAutofill" -> { grant.lock(); requests.clear(); return true; }
            default -> throw new IllegalArgumentException("unknown event " + event.get("type"));
        }
        return false;
    }

    static Object read(Object owner, String name) {
        try {
            java.lang.reflect.Field field = owner.getClass().getDeclaredField(name);
            field.setAccessible(true);
            return field.get(owner);
        } catch (ReflectiveOperationException unreadable) {
            throw new IllegalStateException(unreadable);
        }
    }

    String facetOf(String proved) { return specFacets.getOrDefault(proved, proved); }

    static String site(Target target) { return target.web() ? "WebTarget" : "AppTarget"; }

    long number(String token) { return tokens.indexOf(token) + 1; }

    String state() {
        Map<String, Object> fill = new LinkedHashMap<>(Map.of("phase", "NoFill", "token", 0L, "created", 0L, "site", "NoTarget", "facet", "", "ticket", 0L));
        Object pending = read(requests, "fill");
        if (pending != null) {
            String token = (String) read(pending, "token");
            Target target = (Target) read(pending, "target");
            boolean taken = (Boolean) read(pending, "taken");
            fill.put("phase", taken ? "FillPicking" : "FillOffered");
            fill.put("token", number(token));
            fill.put("created", read(pending, "created"));
            fill.put("site", site(target));
            fill.put("facet", facetOf(target.web() ? target.webOrigin : target.appPackage));
            fill.put("ticket", taken && picker != null && picker.token.equals(token) ? picker.challenge : 0L);
        }
        Map<String, Object> capture = new LinkedHashMap<>(Map.of("token", 0L, "created", 0L, "site", "NoTarget", "facet", ""));
        Object save = read(requests, "save");
        if (save != null) {
            capture.put("token", number((String) read(save, "token")));
            capture.put("created", read(save, "created"));
            capture.put("site", site((Target) read(save, "target")));
            capture.put("facet", facetOf((String) read(save, "facet")));
        }
        Map<String, Object> open = new LinkedHashMap<>(Map.of("phase", "NoReview", "site", "NoTarget", "facet", "", "ticket", 0L));
        if (review != null && review.captured != null) {
            boolean unlocking = review.prompting && challenging(review.challenge);
            open.put("phase", review.writing ? "ReviewWriting" : unlocking ? "ReviewUnlocking" : "Reviewing");
            open.put("site", site(review.captured.target));
            open.put("facet", facetOf(review.captured.facet));
            open.put("ticket", review.writing ? review.ticket : unlocking ? review.challenge : 0L);
        }
        String phase = grant.pending() ? "GrantChallenging" : grant.authenticated() ? "GrantLive" : "GrantIdle";
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("fill", fill);
        state.put("capture", capture);
        state.put("review", open);
        state.put("grant", new LinkedHashMap<>(Map.of("phase", phase, "generation", read(grant, "generation"))));
        state.put("filled", (long) filled);
        state.put("saved", (long) saved);
        return json(state);
    }

    String held() { return state() + "|" + now + "|" + tokens.size(); }

    static AutofillReplay current = new AutofillReplay();

    static String answer(String line) {
        Map<String, Object> request = object(new Parser(line).value());
        if (!request.containsKey("event")) {
            current = new AutofillReplay();
            return "{\"state\":" + current.state() + "}";
        }
        String before = current.held();
        boolean always = current.apply(object(request.get("event")));
        boolean accepted = always || !before.equals(current.held());
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + current.state() + "}";
    }

    public static void main(String[] args) throws Exception {
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line = input.readLine(); line != null; line = input.readLine()) {
            String reply;
            try {
                reply = answer(line);
            } catch (RuntimeException failure) {
                reply = "{\"error\":" + json(failure.getClass().getSimpleName() + ": " + failure.getMessage()) + "}";
            }
            System.out.println(reply);
            System.out.flush();
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("expected an object, not " + value);
        return (Map<String, Object>) value;
    }

    static long number(Object value) {
        if (!(value instanceof Long whole)) throw new IllegalArgumentException("expected a whole number, not " + value);
        return whole;
    }

    static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof String text) {
            StringBuilder out = new StringBuilder("\"");
            for (char c : text.toCharArray()) {
                if (c == '"' || c == '\\') out.append('\\').append(c);
                else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                else out.append(c);
            }
            return out.append('"').toString();
        }
        if (value instanceof Map<?, ?> map) {
            List<String> members = new ArrayList<>();
            map.forEach((key, member) -> members.add(json(key) + ":" + json(member)));
            return "{" + String.join(",", members) + "}";
        }
        return String.valueOf(value);
    }

    static final class Parser {
        final String text;
        int at;
        Parser(String text) { this.text = text; }
        void space() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
        char next() { space(); if (at >= text.length()) throw new IllegalArgumentException("unexpected end of " + text); return text.charAt(at); }
        void expect(char c) { if (next() != c) throw new IllegalArgumentException("expected " + c + " at " + at + " in " + text); at++; }
        Object value() {
            char c = next();
            if (c == '{') {
                Map<String, Object> map = new LinkedHashMap<>();
                at++;
                if (next() == '}') { at++; return map; }
                do { String key = string(); expect(':'); map.put(key, value()); } while (comma());
                expect('}');
                return map;
            }
            if (c == '[') {
                List<Object> list = new ArrayList<>();
                at++;
                if (next() == ']') { at++; return list; }
                do list.add(value()); while (comma());
                expect(']');
                return list;
            }
            if (c == '"') return string();
            if (text.startsWith("true", at)) { at += 4; return true; }
            if (text.startsWith("false", at)) { at += 5; return false; }
            if (text.startsWith("null", at)) { at += 4; return null; }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            String digits = text.substring(start, at);
            if (digits.isEmpty()) throw new IllegalArgumentException("unexpected " + c + " at " + start + " in " + text);
            return digits.matches("-?\\d+") ? (Object) Long.parseLong(digits) : (Object) Double.parseDouble(digits);
        }
        boolean comma() { if (next() == ',') { at++; return true; } return false; }
        String string() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (text.charAt(at) != '"') {
                char c = text.charAt(at++);
                if (c != '\\') { out.append(c); continue; }
                char escaped = text.charAt(at++);
                switch (escaped) {
                    case 'n' -> out.append('\n');
                    case 't' -> out.append('\t');
                    case 'r' -> out.append('\r');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'u' -> { out.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); at += 4; }
                    default -> out.append(escaped);
                }
            }
            at++;
            return out.toString();
        }
    }
}
