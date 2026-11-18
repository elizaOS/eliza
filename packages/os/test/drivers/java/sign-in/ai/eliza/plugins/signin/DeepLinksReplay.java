// spec/os/android/deepLinks.md, "Story: Open the link I followed exactly once, even across a cold start"; spec/os/android/deepLinks.md, "Story: Keep two links I followed apart, even when they are the same URL"
package ai.eliza.plugins.signin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public final class DeepLinksReplay {
  private static final Pattern TYPE = Pattern.compile("\"type\"\\s*:\\s*\"(\\w+)\"");
  private static final Pattern ID = Pattern.compile("\"id\"\\s*:\\s*(-?\\d+)");
  private static final Pattern WITH_LINK = Pattern.compile("\"withLink\"\\s*:\\s*(true|false)");
  private static final Pattern OUTCOME = Pattern.compile("\"linkOutcome\"\\s*:\\s*\"(\\w+)\"");
  private static final String URL = "https://links.example.test/open/same";

  private static final class Durable implements SecureSlot {
    private String value;
    @Override public String read() { return value; }
    @Override public boolean compareExchange(String expected, String next) {
      if (!Objects.equals(expected, value)) return false;
      value = next;
      return true;
    }
  }

  private Durable slot;
  private DeepLinkCapture nativeHalf;
  private boolean ready;
  private final TreeSet<Long> waiting = new TreeSet<>(), running = new TreeSet<>(), done = new TreeSet<>(), settled = new TreeSet<>(), acks = new TreeSet<>();

  private void reset() throws Exception {
    slot = new Durable();
    nativeHalf = DeepLinkCapture.launch(slot, null);
    ready = false;
    for (TreeSet<Long> set : java.util.List.of(waiting, running, done, settled, acks)) set.clear();
  }

  private static String set(TreeSet<Long> values) {
    return values.stream().map(String::valueOf).collect(Collectors.joining(",", "[", "]"));
  }

  private String state() throws Exception {
    DeepLinkCapture.Pending pending = nativeHalf.pending();
    return "{\"captured\":" + nativeHalf.captured() + ",\"pending\":" + (pending == null ? 0 : pending.receipt())
        + ",\"coldLaunch\":" + nativeHalf.coldLaunch() + ",\"ready\":" + ready + ",\"waiting\":" + set(waiting)
        + ",\"running\":" + set(running) + ",\"done\":" + set(done) + ",\"settled\":" + set(settled) + ",\"acks\":" + set(acks) + "}";
  }

  private boolean apply(String type, String body) throws Exception {
    switch (type) {
      case "launch" -> {
        nativeHalf = DeepLinkCapture.launch(slot, Boolean.parseBoolean(group(WITH_LINK, body)) ? URL : null);
        ready = false;
        waiting.clear();
        running.clear();
        done.clear();
        return true;
      }
      case "capture" -> {
        nativeHalf.capture(URL);
        return true;
      }
      case "deliver" -> {
        long id = Long.parseLong(group(ID, body));
        if (id < 1 || id > nativeHalf.captured()) return false;
        boolean known = waiting.contains(id) || running.contains(id) || done.contains(id);
        if (!known) (ready ? running : waiting).add(id);
        if (done.contains(id)) acks.add(id);
        return true;
      }
      case "rendererReady" -> {
        if (ready) return false;
        ready = true;
        running.addAll(waiting);
        waiting.clear();
        return true;
      }
      case "finish" -> {
        long id = Long.parseLong(group(ID, body));
        if (!running.remove(id)) return false;
        if (!"LinkFailed".equals(group(OUTCOME, body))) {
          done.add(id);
          settled.add(id);
          acks.add(id);
        }
        return true;
      }
      case "acknowledge" -> {
        long id = Long.parseLong(group(ID, body));
        if (!acks.remove(id)) return false;
        nativeHalf.acknowledge(id, URL);
        return true;
      }
      default -> throw new IllegalArgumentException("unknown event " + type);
    }
  }

  private static String group(Pattern pattern, String body) {
    Matcher found = pattern.matcher(body);
    if (!found.find()) throw new IllegalArgumentException("a field is missing from " + body);
    return found.group(1);
  }

  private String answer(String line) throws Exception {
    int event = line.indexOf("\"event\"");
    if (event < 0) {
      reset();
      return "{\"state\":" + state() + "}";
    }
    String body = line.substring(event);
    boolean accepted = apply(group(TYPE, body), body);
    return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
  }

  public static void main(String[] args) throws Exception {
    DeepLinksReplay replay = new DeepLinksReplay();
    replay.reset();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = input.readLine(); line != null; line = input.readLine()) {
      String reply;
      try {
        reply = replay.answer(line);
      } catch (Exception failure) {
        reply = "{\"error\":\"" + String.valueOf(failure.getMessage()).replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
      }
      System.out.println(reply);
      System.out.flush();
    }
  }
}
