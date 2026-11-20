// spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"
package ai.eliza.plugins.securestore.nativeonly;

import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Answered;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Caller;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Expectation;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Proposal;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.PublicationReceipt;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotExchange;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotRead;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotRule;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SlotExchangeReplay {
  private SlotExchange state = new SecureSlotPolicy.Ready();

  private static final class Json {
    private final String text;
    private int at;

    private Json(String text) { this.text = text; }

    static Object parse(String text) {
      Json json = new Json(text);
      Object value = json.value();
      json.space();
      if (json.at != text.length()) throw new IllegalArgumentException("trailing text in " + text);
      return value;
    }

    private void space() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }

    private boolean take(char expected) {
      space();
      if (at < text.length() && text.charAt(at) == expected) { at++; return true; }
      return false;
    }

    private Object value() {
      space();
      char first = text.charAt(at);
      if (first == '{') {
        at++;
        Map<String, Object> object = new LinkedHashMap<>();
        if (take('}')) return object;
        do {
          space();
          String key = string();
          if (!take(':')) throw new IllegalArgumentException("expected : at " + at);
          object.put(key, value());
        } while (take(','));
        if (!take('}')) throw new IllegalArgumentException("expected } at " + at);
        return object;
      }
      if (first == '[') {
        at++;
        List<Object> array = new ArrayList<>();
        if (take(']')) return array;
        do array.add(value()); while (take(','));
        if (!take(']')) throw new IllegalArgumentException("expected ] at " + at);
        return array;
      }
      if (first == '"') return string();
      for (String word : List.of("true", "false", "null"))
        if (text.startsWith(word, at)) { at += word.length(); return word.equals("null") ? null : Boolean.valueOf(word); }
      int start = at;
      while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
      if (start == at) throw new IllegalArgumentException("unexpected " + first + " at " + at);
      return Double.parseDouble(text.substring(start, at));
    }

    private String string() {
      if (text.charAt(at) != '"') throw new IllegalArgumentException("expected a string at " + at);
      at++;
      StringBuilder out = new StringBuilder();
      for (char c = text.charAt(at++); c != '"'; c = text.charAt(at++)) {
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
      return out.toString();
    }
  }

  private static String quote(String text) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : text.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
      else out.append(c);
    }
    return out.append('"').toString();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> object(Object value, String field) {
    if (!(value instanceof Map<?, ?>)) throw new IllegalArgumentException("not an object: " + field);
    return (Map<String, Object>) value;
  }

  private static String text(Map<String, Object> object, String field) {
    if (!(object.get(field) instanceof String value)) throw new IllegalArgumentException("not a string: " + field);
    return value;
  }

  private static long whole(Map<String, Object> object, String field) {
    if (!(object.get(field) instanceof Double value) || value != Math.rint(value)) throw new IllegalArgumentException("not a whole number: " + field);
    return value.longValue();
  }

  private static boolean flag(Map<String, Object> object, String field) {
    if (!(object.get(field) instanceof Boolean value)) throw new IllegalArgumentException("not a boolean: " + field);
    return value;
  }

  private static SlotRule rule(Map<String, Object> raw) {
    return new SlotRule(text(raw, "slot"), SecureSlotPolicy.SlotFamily.valueOf(text(raw, "family")),
        SecureSlotPolicy.SlotAccess.valueOf(text(raw, "access")), whole(raw, "limit"), whole(raw, "retained"));
  }

  private static Expectation expectation(Map<String, Object> raw) {
    return switch (text(raw, "tag")) {
      case "Unconditional" -> new SecureSlotPolicy.Unconditional();
      case "ExpectAbsent" -> new SecureSlotPolicy.ExpectAbsent();
      case "ExpectText" -> new SecureSlotPolicy.ExpectText(flag(raw, "sameAsStored"));
      default -> throw new IllegalArgumentException("unknown expectation");
    };
  }

  private static Proposal proposal(Map<String, Object> raw) {
    return switch (text(raw, "tag")) {
      case "RemoveValue" -> new SecureSlotPolicy.RemoveValue();
      case "PutValue" -> new SecureSlotPolicy.PutValue(whole(raw, "bytes"));
      default -> throw new IllegalArgumentException("unknown proposal");
    };
  }

  private static SlotRead observed(Map<String, Object> raw) {
    return switch (text(raw, "tag")) {
      case "Absent" -> new SecureSlotPolicy.Absent();
      case "Unreadable" -> new SecureSlotPolicy.Unreadable();
      case "Value" -> new SecureSlotPolicy.Value(whole(raw, "bytes"));
      default -> throw new IllegalArgumentException("unknown read");
    };
  }

  private String state() {
    if (state instanceof SecureSlotPolicy.Writing writing) return "{\"tag\":\"Writing\",\"slot\":" + quote(writing.slot()) + "}";
    if (state instanceof SecureSlotPolicy.Removing removing) return "{\"tag\":\"Removing\",\"slot\":" + quote(removing.slot()) + "}";
    if (state instanceof Answered answered)
      return "{\"tag\":\"Answered\",\"slot\":" + quote(answered.slot()) + ",\"outcome\":\"" + answered.outcome().name() + "\"}";
    return "{\"tag\":\"Ready\"}";
  }

  private boolean apply(Map<String, Object> event, Caller by) {
    switch (text(event, "type")) {
      case "begin" -> {
        if (!SecureSlotPolicy.canBegin(state)) return false;
        state = SecureSlotPolicy.begin(state, by, rule(object(event.get("rule"), "rule")), expectation(object(event.get("expectation"), "expectation")),
            proposal(object(event.get("proposal"), "proposal")), observed(object(event.get("observed"), "observed")));
        return true;
      }
      case "settleWrite" -> {
        PublicationReceipt receipt = PublicationReceipt.valueOf(text(event, "receipt"));
        if (!SecureSlotPolicy.canSettleWrite(state, receipt)) return false;
        state = SecureSlotPolicy.settleWrite(state, receipt, flag(event, "readBack"));
        return true;
      }
      case "settleRemove" -> {
        if (!SecureSlotPolicy.canSettleRemove(state)) return false;
        state = SecureSlotPolicy.settleRemove(state, flag(event, "allGone"));
        return true;
      }
      default -> throw new IllegalArgumentException("unknown event " + event.get("type"));
    }
  }

  private String answer(String line) {
    Map<String, Object> request = object(Json.parse(line), "request");
    if (!request.containsKey("event")) {
      state = new SecureSlotPolicy.Ready();
      return "{\"state\":" + state() + "}";
    }
    Caller by = request.get("by") instanceof String sender ? Caller.valueOf(sender) : Caller.NativeCaller;
    boolean accepted = apply(object(request.get("event"), "event"), by);
    return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
  }

  public static void main(String[] args) throws Exception {
    SlotExchangeReplay replay = new SlotExchangeReplay();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = input.readLine(); line != null; line = input.readLine()) {
      String reply;
      try {
        reply = replay.answer(line);
      } catch (RuntimeException failure) {
        reply = "{\"error\":" + quote(String.valueOf(failure.getMessage())) + "}";
      }
      System.out.println(reply);
      System.out.flush();
    }
  }
}
