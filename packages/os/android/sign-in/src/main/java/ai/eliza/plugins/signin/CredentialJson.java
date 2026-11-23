// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"
package ai.eliza.plugins.signin;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class CredentialJson {
  private CredentialJson() {}

  public static final class Malformed extends IllegalArgumentException {
    Malformed(String what) { super("malformed JSON: " + what); }
  }

  public static Object parse(String text) {
    CredentialJson.Reader reader = new CredentialJson.Reader(text);
    Object value = reader.value();
    reader.space();
    if (reader.at < text.length()) throw new Malformed("trailing text");
    return value;
  }

  public static Map<String, Object> object(Object value, String what) {
    if (!(value instanceof Map<?, ?> map)) throw new Malformed(what);
    @SuppressWarnings("unchecked") Map<String, Object> typed = (Map<String, Object>) map;
    return typed;
  }

  public static List<Object> list(Object value, String what) {
    if (!(value instanceof List<?> list)) throw new Malformed(what);
    @SuppressWarnings("unchecked") List<Object> typed = (List<Object>) list;
    return typed;
  }

  public static String text(Map<String, Object> source, String key) {
    if (!(source.get(key) instanceof String value)) throw new Malformed(key);
    return value;
  }

  public static long whole(Map<String, Object> source, String key) {
    if (!(source.get(key) instanceof Long value)) throw new Malformed(key);
    return value;
  }

  public static int small(Map<String, Object> source, String key) {
    long value = whole(source, key);
    if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) throw new Malformed(key);
    return (int) value;
  }

  public static boolean flag(Map<String, Object> source, String key) {
    if (!(source.get(key) instanceof Boolean value)) throw new Malformed(key);
    return value;
  }

  public static String write(Object value) {
    StringBuilder out = new StringBuilder();
    write(out, value);
    return out.toString();
  }

  private static void write(StringBuilder out, Object value) {
    switch (value) {
      case null -> out.append("null");
      case String text -> out.append(quote(text));
      case Boolean flag -> out.append(flag);
      case Long whole -> out.append(whole);
      case Integer whole -> out.append(whole);
      case Double real when Double.isFinite(real) -> out.append(real);
      case Map<?, ?> map -> {
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (!first) out.append(',');
          first = false;
          out.append(quote((String) entry.getKey())).append(':');
          write(out, entry.getValue());
        }
        out.append('}');
      }
      case List<?> list -> {
        out.append('[');
        for (int at = 0; at < list.size(); at++) {
          if (at > 0) out.append(',');
          write(out, list.get(at));
        }
        out.append(']');
      }
      default -> throw new Malformed("unwritable value");
    }
  }

  public static String quote(String value) {
    StringBuilder out = new StringBuilder(value.length() + 2).append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }

  private static final class Reader {
    private final String text;
    private int at;
    private int depth;

    Reader(String text) {
      if (text == null) throw new Malformed("absent");
      this.text = text;
    }

    void space() {
      while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++;
    }

    private char next() {
      if (at >= text.length()) throw new Malformed("end of text");
      return text.charAt(at++);
    }

    private void expect(String word) {
      if (!text.startsWith(word, at)) throw new Malformed("expected " + word);
      at += word.length();
    }

    Object value() {
      space();
      if (at >= text.length()) throw new Malformed("end of text");
      char c = text.charAt(at);
      return switch (c) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> { expect("true"); yield Boolean.TRUE; }
        case 'f' -> { expect("false"); yield Boolean.FALSE; }
        case 'n' -> { expect("null"); yield null; }
        default -> number();
      };
    }

    private void enter() {
      if (++depth > 32) throw new Malformed("nesting");
    }

    private Map<String, Object> object() {
      enter();
      at++;
      Map<String, Object> out = new LinkedHashMap<>();
      space();
      if (at < text.length() && text.charAt(at) == '}') { at++; depth--; return out; }
      while (true) {
        space();
        if (at >= text.length() || text.charAt(at) != '"') throw new Malformed("key");
        String key = string();
        space();
        if (next() != ':') throw new Malformed("colon");
        if (out.containsKey(key)) throw new Malformed("duplicate " + key);
        out.put(key, value());
        space();
        char c = next();
        if (c == '}') { depth--; return out; }
        if (c != ',') throw new Malformed("comma");
      }
    }

    private List<Object> array() {
      enter();
      at++;
      List<Object> out = new ArrayList<>();
      space();
      if (at < text.length() && text.charAt(at) == ']') { at++; depth--; return out; }
      while (true) {
        out.add(value());
        space();
        char c = next();
        if (c == ']') { depth--; return out; }
        if (c != ',') throw new Malformed("comma");
      }
    }

    private String string() {
      at++;
      StringBuilder out = new StringBuilder();
      while (true) {
        char c = next();
        if (c == '"') return out.toString();
        if (c < 0x20) throw new Malformed("control character");
        if (c != '\\') { out.append(c); continue; }
        char e = next();
        switch (e) {
          case '"', '\\', '/' -> out.append(e);
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> {
            if (at + 4 > text.length()) throw new Malformed("escape");
            try { out.append((char) Integer.parseInt(text.substring(at, at + 4), 16)); }
            catch (NumberFormatException bad) { throw new Malformed("escape"); }
            at += 4;
          }
          default -> throw new Malformed("escape");
        }
      }
    }

    private Object number() {
      int start = at;
      while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
      String raw = text.substring(start, at);
      if (raw.isEmpty()) throw new Malformed("value");
      try {
        if (raw.matches("-?(0|[1-9][0-9]{0,17})")) return Long.parseLong(raw);
        return Double.parseDouble(raw);
      } catch (NumberFormatException bad) {
        throw new Malformed("number");
      }
    }
  }
}
