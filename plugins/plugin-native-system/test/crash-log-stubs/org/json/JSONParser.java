package org.json;

/** Minimal recursive-descent JSON reader/writer for the host test stand-ins. */
final class JSONParser {
    private final String text;
    private int at;
    private JSONParser(String text) { this.text = text; }
    static Object parse(String text) throws JSONException {
        if (text == null) throw new JSONException("null");
        JSONParser parser = new JSONParser(text);
        Object value = parser.value();
        parser.space();
        if (parser.at != text.length()) throw new JSONException("trailing text");
        return value;
    }
    private void space() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
    private char peek() throws JSONException { space(); if (at >= text.length()) throw new JSONException("end"); return text.charAt(at); }
    private void expect(char c) throws JSONException { if (peek() != c) throw new JSONException("expected " + c); at++; }
    private Object value() throws JSONException {
        char c = peek();
        if (c == '{') {
            at++;
            JSONObject out = new JSONObject();
            if (peek() == '}') { at++; return out; }
            while (true) {
                String key = string();
                expect(':');
                out.values.put(key, value());
                if (peek() == ',') { at++; continue; }
                expect('}');
                return out;
            }
        }
        if (c == '[') {
            at++;
            JSONArray out = new JSONArray();
            if (peek() == ']') { at++; return out; }
            while (true) {
                out.values.add(value());
                if (peek() == ',') { at++; continue; }
                expect(']');
                return out;
            }
        }
        if (c == '"') return string();
        if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
        if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
        if (text.startsWith("null", at)) { at += 4; return JSONObject.NULL; }
        int start = at;
        while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
        if (start == at) throw new JSONException("unexpected " + c);
        String number = text.substring(start, at);
        try {
            if (number.contains(".") || number.contains("e") || number.contains("E")) return Double.parseDouble(number);
            long value = Long.parseLong(number);
            return value == (int) value ? (Object) (int) value : (Object) value;
        } catch (NumberFormatException bad) { throw new JSONException("number"); }
    }
    private String string() throws JSONException {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (at < text.length()) {
            char c = text.charAt(at++);
            if (c == '"') return out.toString();
            if (c == '\\') {
                char e = text.charAt(at++);
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 't': out.append('\t'); break;
                    case 'u': out.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); at += 4; break;
                    default: out.append(e);
                }
            } else out.append(c);
        }
        throw new JSONException("unterminated string");
    }
    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }
    static String write(Object value) {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof String) return quote((String) value);
        return value.toString();
    }
}
