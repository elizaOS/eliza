// spec/os/image/firstRun.md, "Story: Have my device's default apps set on first boot without overriding my choices"
package ai.eliza.firstrun;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class FirstRunReplay {
    private FirstRunPolicy.State state = FirstRunPolicy.INITIAL;

    public static void main(String[] args) throws Exception {
        FirstRunReplay replay = new FirstRunReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        for (String line; (line = input.readLine()) != null;) {
            if (line.isBlank()) continue;
            try { output.println(replay.answer(line)); }
            catch (RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
        }
    }

    private String answer(String line) {
        Map<String, Object> request = object(new Json(line).value());
        Object event = request.containsKey("event") ? request.get("event") : request.get("raw");
        if (event == null) {
            state = FirstRunPolicy.INITIAL;
            return "{\"state\":" + encode(state) + ",\"out\":[]}";
        }
        boolean accepted = step(object(event));
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + encode(state) + ",\"out\":[]}";
    }

    private boolean step(Map<String, Object> event) {
        switch ((String) event.get("type")) {
            case "begin" -> {
                Map<String, Object> d = object(event.get("descriptor")), v = object(event.get("device"));
                Map<FirstRunPolicy.Role, String> packages = new EnumMap<>(FirstRunPolicy.Role.class);
                for (FirstRunPolicy.Role role : roles(d.get("roles"))) packages.put(role, "com.example.product");
                FirstRunPolicy.Descriptor descriptor = new FirstRunPolicy.Descriptor((Boolean) d.get("active"), packages);
                FirstRunPolicy.Device device = new FirstRunPolicy.Device((Boolean) v.get("systemUser"), (Boolean) v.get("mainUser"),
                        (Boolean) v.get("managed"), (Boolean) v.get("profile"), (Boolean) v.get("telephony"));
                FirstRunPolicy.Reading reading = reading(event.get("reading"));
                if (!FirstRunPolicy.canBegin(state, descriptor, device, reading)) return false;
                state = FirstRunPolicy.begin(state, descriptor, device, reading);
                return true;
            }
            case "readBack" -> {
                FirstRunPolicy.Reading reading = reading(event.get("reading"));
                if (!FirstRunPolicy.canReadBack(state, reading)) return false;
                state = FirstRunPolicy.readBack(state, reading);
                return true;
            }
            default -> throw new IllegalArgumentException("unknown event " + event.get("type"));
        }
    }

    private static FirstRunPolicy.Reading reading(Object value) {
        Map<String, Object> r = object(value);
        return new FirstRunPolicy.Reading(roles(r.get("unavailable")), roles(r.get("product")), roles(r.get("owner")));
    }

    private static final Map<String, FirstRunPolicy.Role> ROLES = Map.of("HomeRole", FirstRunPolicy.Role.HOME,
            "AssistantRole", FirstRunPolicy.Role.ASSISTANT, "DialerRole", FirstRunPolicy.Role.DIALER, "SmsRole", FirstRunPolicy.Role.SMS);

    private static Set<FirstRunPolicy.Role> roles(Object value) {
        Set<FirstRunPolicy.Role> roles = EnumSet.noneOf(FirstRunPolicy.Role.class);
        for (Object name : (List<?>) value) {
            FirstRunPolicy.Role role = ROLES.get((String) name);
            if (role == null) throw new IllegalArgumentException("unknown role " + name);
            roles.add(role);
        }
        return roles;
    }

    private static String encode(FirstRunPolicy.State s) {
        String phase = s.phase().name().charAt(0) + s.phase().name().substring(1).toLowerCase();
        return "{\"phase\":\"" + phase + "\",\"required\":" + names(s.required()) + ",\"confirmed\":" + names(s.confirmed())
                + ",\"assigning\":" + names(s.assigning()) + "}";
    }

    private static String names(Set<FirstRunPolicy.Role> roles) {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, FirstRunPolicy.Role> entry : ROLES.entrySet()) if (roles.contains(entry.getValue())) out.add(quote(entry.getKey()));
        out.sort(null);
        return "[" + String.join(",", out) + "]";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("not an object: " + value);
        return (Map<String, Object>) value;
    }

    private static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private static final class Json {
        private final String text;
        private int at;

        Json(String text) { this.text = text; }

        Object value() {
            skip();
            char c = text.charAt(at);
            if (c == '{') {
                Map<String, Object> out = new LinkedHashMap<>();
                at++;
                skip();
                if (text.charAt(at) == '}') { at++; return out; }
                do {
                    skip();
                    String key = (String) value();
                    skip();
                    expect(':');
                    out.put(key, value());
                    skip();
                } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != '}') throw new IllegalArgumentException("malformed object at " + at);
                return out;
            }
            if (c == '[') {
                List<Object> out = new ArrayList<>();
                at++;
                skip();
                if (text.charAt(at) == ']') { at++; return out; }
                do { out.add(value()); skip(); } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != ']') throw new IllegalArgumentException("malformed array at " + at);
                return out;
            }
            if (c == '"') {
                StringBuilder out = new StringBuilder();
                for (at++; text.charAt(at) != '"'; at++) {
                    char ch = text.charAt(at);
                    if (ch != '\\') { out.append(ch); continue; }
                    char escaped = text.charAt(++at);
                    switch (escaped) {
                        case 'n' -> out.append('\n');
                        case 't' -> out.append('\t');
                        case 'r' -> out.append('\r');
                        case 'b' -> out.append('\b');
                        case 'f' -> out.append('\f');
                        case 'u' -> { out.append((char) Integer.parseInt(text.substring(at + 1, at + 5), 16)); at += 4; }
                        default -> out.append(escaped);
                    }
                }
                at++;
                return out.toString();
            }
            for (String literal : new String[] {"true", "false", "null"})
                if (text.startsWith(literal, at)) { at += literal.length(); return literal.equals("null") ? null : Boolean.valueOf(literal); }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            if (start == at) throw new IllegalArgumentException("unexpected " + c + " at " + at);
            return Double.valueOf(text.substring(start, at));
        }

        private void skip() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }

        private void expect(char c) {
            if (text.charAt(at++) != c) throw new IllegalArgumentException("expected " + c + " at " + (at - 1));
        }
    }
}
