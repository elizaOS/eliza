// spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"
package ai.eliza.plugins.securestore.nativeonly;

import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Caller;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.ExchangeOutcome;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Expectation;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Frame;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Proposal;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.PublicationReceipt;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotExchange;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotRead;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotRequest;
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.SlotRule;
import android.content.Context;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

public final class SecureSlots {
  public static final String PLUGIN = "ElizaSecureStore";
  public static final String DIRECTORY = "eliza-secure-slots";
  public static final String KEY_ALIAS = "ai.eliza.secure-slots.v1";
  private static final String CAPACITOR_CONFIG = "capacitor.config.json";

  public sealed interface Reading permits Refused, Absent, Unreadable, Present {}
  public record Refused() implements Reading {}
  public record Absent() implements Reading {}
  public record Unreadable() implements Reading {}
  public record Present(String value) implements Reading {}

  private static volatile SecureSlots host;

  private final SecureSlotPolicy policy;
  private final JsonCredentialSlots slots;

  public SecureSlots(File directory, String alias, SecureSlotPolicy policy) {
    this.policy = policy;
    this.slots = new JsonCredentialSlots(directory, alias, name -> budget(name, false), name -> budget(name, true));
  }

  public static SecureSlots forHost(Context context) {
    SecureSlots current = host;
    if (current != null) return current;
    synchronized (SecureSlots.class) {
      if (host == null) {
        JSONObject config = hostConfig(context);
        host = new SecureSlots(new File(context.getApplicationContext().getNoBackupFilesDir(), DIRECTORY), KEY_ALIAS,
            SecureSlotPolicy.parse(config == null ? null : plain(config)));
      }
      return host;
    }
  }

  public SecureSlotPolicy policy() { return policy; }

  public void ensureAvailable() throws Exception { slots.ensureKey(); }

  private static JSONObject hostConfig(Context context) {
    try (InputStream input = context.getAssets().open(CAPACITOR_CONFIG)) {
      java.io.ByteArrayOutputStream text = new java.io.ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      for (int read = input.read(chunk); read != -1; read = input.read(chunk)) text.write(chunk, 0, read);
      JSONObject plugins = new JSONObject(text.toString("UTF-8")).optJSONObject("plugins");
      return plugins == null ? null : plugins.optJSONObject(PLUGIN);
    } catch (java.io.FileNotFoundException absent) {
      return null;
    } catch (java.io.IOException | org.json.JSONException unreadable) {
      throw new IllegalArgumentException("The host's Capacitor configuration is unreadable", unreadable);
    }
  }

  public Reading read(Caller by, String name) {
    synchronized (JsonCredentialSlots.LOCK) {
      SlotRule rule = policy.rule(name);
      if (rule == null || !SecureSlotPolicy.admits(by, SlotRequest.ReadRequest, rule)) return new Refused();
      Observed observed = observe(rule);
      if (observed.read instanceof SecureSlotPolicy.Absent) return new Absent();
      if (observed.read instanceof SecureSlotPolicy.Unreadable) return new Unreadable();
      return new Present(observed.text);
    }
  }

  public ExchangeOutcome write(Caller by, String name, String value) {
    return exchange(by, name, new SecureSlotPolicy.Unconditional(), null, value);
  }

  public ExchangeOutcome remove(Caller by, String name) {
    return exchange(by, name, new SecureSlotPolicy.Unconditional(), null, null);
  }

  public ExchangeOutcome compareAndExchange(Caller by, String name, String expected, String value) {
    return exchange(by, name, expected == null ? new SecureSlotPolicy.ExpectAbsent() : new SecureSlotPolicy.ExpectText(false), expected, value);
  }

  private ExchangeOutcome exchange(Caller by, String name, Expectation expectation, String expected, String value) {
    synchronized (JsonCredentialSlots.LOCK) {
      SlotRule rule = policy.rule(name);
      if (rule == null) return ExchangeOutcome.Refused;
      Proposal proposal = value == null ? new SecureSlotPolicy.RemoveValue() : new SecureSlotPolicy.PutValue(proposedBytes(value));
      if (!SecureSlotPolicy.admits(by, SecureSlotPolicy.requestOf(expectation, proposal), rule)) return ExchangeOutcome.Refused;
      Observed observed = observe(rule);
      if (expectation instanceof SecureSlotPolicy.ExpectText) expectation = new SecureSlotPolicy.ExpectText(expected.equals(observed.text));
      SlotExchange state = SecureSlotPolicy.begin(new SecureSlotPolicy.Ready(), by, rule, expectation, proposal, observed.read);
      if (state instanceof SecureSlotPolicy.Writing) state = settleWrite(state, name, value);
      else if (state instanceof SecureSlotPolicy.Removing) state = settleRemove(state, name);
      return SecureSlotPolicy.outcomeOf(state);
    }
  }

  private SlotExchange settleWrite(SlotExchange writing, String name, String value) {
    try {
      slots.write(name, value);
      return SecureSlotPolicy.settleWrite(writing, PublicationReceipt.SuccessReceipt, true);
    } catch (JsonCredentialSlots.UnconfirmedException unconfirmed) {
      return SecureSlotPolicy.settleWrite(writing, PublicationReceipt.SuccessReceipt, false);
    } catch (Exception failed) {
      return SecureSlotPolicy.settleWrite(writing, PublicationReceipt.FailureReceipt, false);
    }
  }

  private SlotExchange settleRemove(SlotExchange removing, String name) {
    try {
      slots.remove(name);
      return SecureSlotPolicy.settleRemove(removing, true);
    } catch (Exception lingering) {
      return SecureSlotPolicy.settleRemove(removing, false);
    }
  }

  private record Observed(SlotRead read, String text) {}

  private Observed observe(SlotRule rule) {
    Frame frame;
    String text = null;
    try {
      text = slots.read(rule.slot());
      frame = text == null ? new SecureSlotPolicy.NoFile() : new SecureSlotPolicy.Authentic(text.getBytes(StandardCharsets.UTF_8).length);
    } catch (Exception unreadable) {
      frame = new SecureSlotPolicy.Rejected();
    }
    SlotRead read = SecureSlotPolicy.readFrame(frame, rule);
    return new Observed(read, read instanceof SecureSlotPolicy.Value ? text : null);
  }

  private static long proposedBytes(String value) {
    if (value.isEmpty()) return 0;
    try {
      JsonCredentialSlots.parseJson(value);
    } catch (Exception notJson) {
      return 0;
    }
    return value.getBytes(StandardCharsets.UTF_8).length;
  }

  private int budget(String name, boolean retained) {
    SlotRule rule = policy.rule(name);
    if (rule == null) throw new IllegalArgumentException("Invalid secure slot name");
    return (int) (retained ? rule.retained() : rule.limit());
  }

  private static Map<String, Object> plain(JSONObject object) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
      String key = keys.next();
      map.put(key, plain(object.opt(key)));
    }
    return map;
  }

  private static Object plain(Object value) {
    if (value instanceof JSONObject object) return plain(object);
    if (value instanceof JSONArray array) {
      List<Object> items = new ArrayList<>();
      for (int i = 0; i < array.length(); i++) items.add(plain(array.opt(i)));
      return items;
    }
    return value == JSONObject.NULL ? null : value;
  }
}
