// spec/os/voice/cloudSpeech.md, "Each batch transcription or synthesis settles once, and a refusal keeps its retry time"
package ai.eliza.voice;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CloudSpeechTimings {
  public static final int LIMIT = 100;
  public static final long MAX_MS = 3_600_000;
  public static final String FORMAT = "eliza-cloud-speech-timing-v1";
  private static final List<String> STAGES = List.of("queued", "worker-start", "decode-start", "decode-end", "upload-start", "upload-end", "headers", "body-end", "prepared", "playback-start", "playback-end");
  private static final Set<String> SERVER_FIELDS = Set.of("auth", "admission", "synthesis", "moderation");
  private static final Set<String> OUTCOMES = Set.of("completed", "failed", "cancelled");
  private static final Pattern DURATION = Pattern.compile("(?:^|;)\\s*dur\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(?=;|$)", Pattern.CASE_INSENSITIVE);
  private static final Pattern PROVIDER = Pattern.compile("[a-z0-9-]{1,32}");

  public enum Route { STT("stt"), TTS("tts"); final String wire; Route(String wire) { this.wire = wire; } }

  public interface Clock { long nanos(); }

  public static final class Record {
    private final long id, start;
    private final Route route;
    private final LinkedHashMap<String, Long> marks = new LinkedHashMap<>();
    private final LinkedHashMap<String, Double> server = new LinkedHashMap<>();
    private String outcome = "active", provider = "unknown", moderation = "unknown";
    private int status, lastStage;
    private long ended = -1;
    private boolean bounded;

    private Record(long id, Route route, long start) {
      this.id = id;
      this.route = route;
      this.start = start;
      marks.put("queued", 0L);
    }
  }

  private final Clock clock;
  private final ArrayDeque<Record> records = new ArrayDeque<>();
  private long sequence;

  public CloudSpeechTimings() { this(System::nanoTime); }

  public CloudSpeechTimings(Clock clock) { this.clock = clock; }

  public synchronized Record begin(Route route) {
    Record record = new Record(++sequence, route, clock.nanos());
    records.addLast(record);
    while (records.size() > LIMIT) records.removeFirst();
    return record;
  }

  public synchronized void mark(Record record, String stage) {
    if (!"active".equals(record.outcome)) return;
    int index = STAGES.indexOf(stage);
    if (index <= record.lastStage || record.marks.containsKey(stage)) return;
    long at = elapsed(record);
    if (at < record.marks.get(STAGES.get(record.lastStage))) return;
    record.marks.put(stage, at);
    record.lastStage = index;
  }

  public synchronized void response(Record record, int status, String provider, String serverTiming, String moderation) {
    if (!"active".equals(record.outcome)) return;
    if (status >= 100 && status <= 599) record.status = status;
    record.provider = provider != null && PROVIDER.matcher(provider).matches() ? provider : "unknown";
    record.moderation = "reviewed".equals(moderation) || "approved-hit".equals(moderation) ? moderation : "unknown";
    if (serverTiming == null || serverTiming.length() > 4096) return;
    for (String metric : serverTiming.split(",", 64)) {
      int semicolon = metric.indexOf(';');
      if (semicolon < 0) continue;
      String name = metric.substring(0, semicolon).trim();
      if (!SERVER_FIELDS.contains(name) || record.server.containsKey(name)) continue;
      Matcher duration = DURATION.matcher(metric.substring(semicolon));
      if (!duration.find()) continue;
      double value = Double.parseDouble(duration.group(1));
      if (Double.isFinite(value) && value >= 0 && value < MAX_MS) record.server.put(name, value);
    }
  }

  public synchronized void finish(Record record, String outcome) {
    if (!"active".equals(record.outcome) || !OUTCOMES.contains(outcome)) return;
    record.ended = Math.max(elapsed(record), record.marks.get(STAGES.get(record.lastStage)));
    record.outcome = outcome;
  }

  private long elapsed(Record record) {
    long ms = Math.max(0, (clock.nanos() - record.start) / 1_000_000L);
    if (ms <= MAX_MS) return ms;
    record.bounded = true;
    return MAX_MS;
  }

  public synchronized Map<String, Object> snapshot() {
    List<Map<String, Object>> rows = new ArrayList<>();
    for (Record record : records) {
      LinkedHashMap<String, Object> row = new LinkedHashMap<>();
      row.put("id", record.id);
      row.put("route", record.route.wire);
      row.put("outcome", record.outcome);
      row.put("provider", record.provider);
      row.put("moderation", record.moderation);
      long total = record.ended >= 0 ? record.ended : Math.max(elapsed(record), record.marks.get(STAGES.get(record.lastStage)));
      row.put("elapsedMs", total);
      if (record.bounded) row.put("bounded", true);
      if (record.status != 0) row.put("status", record.status);
      row.put("marks", new LinkedHashMap<>(record.marks));
      LinkedHashMap<String, Long> phases = new LinkedHashMap<>();
      phase(record, phases, "queueMs", "queued", "worker-start");
      phase(record, phases, "decodeMs", "decode-start", "decode-end");
      phase(record, phases, "uploadMs", "upload-start", "upload-end");
      phase(record, phases, "responseWaitMs", "upload-end", "headers");
      phase(record, phases, "downloadMs", "headers", "body-end");
      phase(record, phases, "prepareMs", "body-end", "prepared");
      phase(record, phases, "playbackStartMs", "prepared", "playback-start");
      phase(record, phases, "playbackMs", "playback-start", "playback-end");
      phases.put("totalMs", total);
      row.put("phases", phases);
      row.put("server", new LinkedHashMap<>(record.server));
      rows.add(row);
    }
    LinkedHashMap<String, Object> result = new LinkedHashMap<>();
    result.put("format", FORMAT);
    result.put("clock", "monotonic-elapsed-ms");
    result.put("records", rows);
    return result;
  }

  private static void phase(Record record, Map<String, Long> phases, String name, String start, String end) {
    Long a = record.marks.get(start), b = record.marks.get(end);
    if (a != null && b != null) phases.put(name, b - a);
  }
}
