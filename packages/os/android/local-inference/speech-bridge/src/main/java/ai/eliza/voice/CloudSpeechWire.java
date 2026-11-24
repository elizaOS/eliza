// spec/cloud/services/speechRelay.md, "The wire is version 1 with 16 kHz mono PCM16 and bounded frames"; spec/os/voice/cloudSpeech.md, "Only a mint answer naming the deployment's own relay opens the socket, and a refused key is reported once and never retried"; spec/os/voice/cloudSpeech.md, "The device accepts relay frames only in protocol order, and any other frame ends the session"
package ai.eliza.voice;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/** The bounded speech-only v1 wire of the cloud speech relay. No URL, account or arbitrary control payload. */
final class CloudSpeechWire {
  static final int RATE = 16000, MAX_UPLINK = 3200, MAX_DOWNLINK = 65536, MAX_CONTROL = 8192;
  static final int MAX_TRANSCRIPT = 16384, MAX_TEXT = 4096, MAX_PHRASE = 1024, MAX_TOKEN = 6144, MAX_BEARER = 16384;
  static final long MAX_WINDOW_MS = 65000, MAX_CONSENT_RETRY_AFTER_MS = 2000, CONSENT_RETRY_REQUEST_MS = 2000, WARMUP_INTERVAL_MS = 60_000;
  static final String BASE = "/api/v1/voice/speech/", HEALTH = "/api/health";
  static final String EXTEND_HEADER = "X-Eliza-Speech-Extend", EXTEND_OFFER = "1";
  static final String INSUFFICIENT_CREDITS = "insufficient_credits", ALLOWANCE_EXHAUSTED = "allowance_exhausted";
  static final CloudSpeechPolicy.Frame PROTOCOL_ERROR = new CloudSpeechPolicy.Frame.Error(CloudSpeechPolicy.RelayErrorCode.PROTOCOL, false);

  private static final Set<String> ERROR_CODES = Set.of("unauthorized", "protocol", "unavailable", "closed");

  private CloudSpeechWire() {}

  static boolean id(String value) {
    return value != null && value.matches("[A-Za-z0-9_-]{1,64}");
  }

  static boolean uuid(String value) {
    if (value == null || value.length() != 36) return false;
    try {
      return UUID.fromString(value).toString().equalsIgnoreCase(value);
    } catch (IllegalArgumentException invalid) {
      return false;
    }
  }

  static boolean bearer(String token) {
    return token != null && !token.isEmpty() && token.length() <= MAX_BEARER && token.indexOf('\r') < 0 && token.indexOf('\n') < 0;
  }

  /** A reviewed cloud origin: https, a host, the default port, and nothing else. */
  static boolean origin(String value) {
    try {
      URI origin = new URI(value);
      return "https".equals(origin.getScheme()) && origin.getHost() != null && origin.getRawUserInfo() == null
          && origin.getRawQuery() == null && origin.getRawFragment() == null
          && (origin.getRawPath() == null || origin.getRawPath().isEmpty())
          && (origin.getPort() == -1 || origin.getPort() == 443);
    } catch (Exception invalid) {
      return false;
    }
  }

  /** The only relay address a mint answer may name for {@code sessionId}. */
  static String relayUrl(String origin, String sessionId) {
    return origin.replaceFirst("^https:", "wss:") + BASE + "ws?sessionId=" + sessionId;
  }

  /** Epoch milliseconds of an ISO instant, or -1. */
  static long instant(String value) {
    try {
      return Instant.parse(value).toEpochMilli();
    } catch (RuntimeException invalid) {
      return -1;
    }
  }

  /** A pace from 0.5 to 2 in percent (50 to 200), or -1. */
  static int pace(Double pace) {
    if (pace == null || !(pace >= 0.5 && pace <= 2)) return -1;
    return (int) Math.max(CloudSpeechPolicy.MIN_PACE, Math.min(CloudSpeechPolicy.MAX_PACE, Math.round(pace * 100)));
  }

  static final class Audio {
    final String id;
    final byte[] pcm;

    Audio(String id, byte[] pcm) {
      this.id = id;
      this.pcm = pcm;
    }
  }

  static Audio decode(byte[] frame) {
    if (frame == null || frame.length < 4 || frame[0] != 1) throw new IllegalArgumentException("Invalid audio frame");
    int n = frame[1] & 255, offset = 2 + n, size = frame.length - offset;
    if (n < 1 || n > 64 || size < 2 || size % 2 != 0 || size > MAX_DOWNLINK) throw new IllegalArgumentException("Invalid audio frame");
    String id = new String(frame, 2, n, StandardCharsets.US_ASCII);
    if (!id(id)) throw new IllegalArgumentException("Invalid audio identity");
    return new Audio(id, Arrays.copyOfRange(frame, offset, frame.length));
  }

  static float[] floats(byte[] pcm) {
    if (pcm == null || pcm.length == 0 || pcm.length % 2 != 0 || pcm.length > MAX_DOWNLINK) throw new IllegalArgumentException("Invalid PCM");
    float[] out = new float[pcm.length / 2];
    for (int i = 0; i < out.length; i++) out[i] = (short) ((pcm[i * 2] & 255) | (pcm[i * 2 + 1] << 8)) / 32768f;
    return out;
  }

  /** The reply's text in phrases of at most 1024 characters, split at spaces. */
  static List<String> phrases(String text) {
    if (text == null || text.trim().isEmpty() || text.length() > MAX_TEXT) throw new IllegalArgumentException("Invalid speech text");
    ArrayList<String> parts = new ArrayList<>();
    int start = 0;
    while (start < text.length()) {
      int end = Math.min(text.length(), start + MAX_PHRASE);
      if (end < text.length()) {
        int space = text.lastIndexOf(' ', end - 1);
        if (space < start) throw new IllegalArgumentException("Speech word is too long");
        end = space + 1;
      }
      String part = text.substring(start, end);
      if (!part.trim().isEmpty()) parts.add(part);
      start = end;
    }
    return parts;
  }

  /** An {@code extended} frame's new end: later than the current one and within one window of now. */
  static long renewal(String expiresAt, long current, long now) {
    long next = instant(expiresAt);
    if (next < 0 || next <= current || next > now + MAX_WINDOW_MS) throw new IllegalArgumentException("Invalid renewal");
    return next;
  }

  static boolean droppedConnection(Exception failure) {
    String message = failure.getMessage();
    if (message == null) return false;
    if (failure instanceof java.net.SocketException) return !(failure instanceof java.net.ConnectException) && message.startsWith("Connection reset");
    return failure instanceof java.io.IOException && message.startsWith("unexpected end of stream");
  }

  static long consentRetryMs(int status, String retryAfter, long now, long remainingMs) {
    long at = status == 503 ? retryAfter(retryAfter, now) : 0;
    if (at <= 0) return -1;
    long wait = Math.max(0, at - now);
    return wait <= MAX_CONSENT_RETRY_AFTER_MS && wait + CONSENT_RETRY_REQUEST_MS <= remainingMs ? wait : -1;
  }

  static final class Warmups {
    private final Map<String, Long> last = new HashMap<>();

    synchronized boolean admit(String origin, long nowMs) {
      Long at = last.get(origin);
      if (at != null && nowMs - at < WARMUP_INTERVAL_MS) return false;
      last.put(origin, nowMs);
      return true;
    }
  }

  /**
   * Timing rows in the order they were marked. A session's startup marks, through {@code ready}, are held apart from
   * its later rows, and the first session's startup (the cold one) is held apart from later sessions' startups, so
   * neither a long session's utterances nor later warm starts evict how a session started. A session that never
   * reaches {@code ready} keeps all its rows with its startup, and a row from a session older than the last few is a
   * later row.
   */
  static final class TimingRows<T> {
    static final String STARTED = "ready";
    private static final int TRACKED_SESSIONS = 8;

    private record Row<T>(long sequence, T row) {}

    private final int startupLimit, laterLimit;
    private final ArrayDeque<Row<T>> cold = new ArrayDeque<>(), startup = new ArrayDeque<>(), later = new ArrayDeque<>();
    private final Map<Long, Boolean> started = new LinkedHashMap<>() {
      @Override protected boolean removeEldestEntry(Map.Entry<Long, Boolean> eldest) {
        return size() > TRACKED_SESSIONS;
      }
    };
    private long sequence, newestSession;
    private Long coldSession;

    TimingRows(int startupLimit, int laterLimit) {
      if (startupLimit < 1 || laterLimit < 1) throw new IllegalArgumentException("Invalid timing bounds");
      this.startupLimit = startupLimit;
      this.laterLimit = laterLimit;
    }

    /** Sessions are numbered in the order they begin, from 1. */
    synchronized void add(long session, String stage, T row) {
      if (session < 1) throw new IllegalArgumentException("Invalid timing session");
      if (session > newestSession) {
        newestSession = session;
        started.put(session, false);
        if (coldSession == null) coldSession = session;
      }
      boolean startupMark = Boolean.FALSE.equals(started.get(session));
      if (startupMark && STARTED.equals(stage)) started.put(session, true);
      ArrayDeque<Row<T>> rows = !startupMark ? later : coldSession == session ? cold : startup;
      rows.addLast(new Row<>(++sequence, row));
      while (rows.size() > (startupMark ? startupLimit : laterLimit)) rows.removeFirst();
    }

    synchronized List<T> rows() {
      List<Row<T>> merged = new ArrayList<>(cold.size() + startup.size() + later.size());
      merged.addAll(cold);
      merged.addAll(startup);
      merged.addAll(later);
      merged.sort((a, b) -> Long.compare(a.sequence(), b.sequence()));
      List<T> rows = new ArrayList<>(merged.size());
      for (Row<T> row : merged) rows.add(row.row());
      return rows;
    }
  }

  static long millis(long pcmBytes) {
    return pcmBytes / 2 * 1000 / RATE;
  }

  static double peak(byte[] pcm, int size) {
    double peak = 0;
    for (int i = 0; i + 1 < size; i += 2) {
      int sample = (short) ((pcm[i] & 255) | (pcm[i + 1] << 8));
      peak = Math.max(peak, Math.abs(sample) / 32768.0);
    }
    return Math.min(1, peak);
  }

  static String hello(String token, boolean extend) {
    if (token == null || token.isEmpty() || token.length() > MAX_TOKEN) throw new IllegalArgumentException("Invalid speech token");
    try {
      JSONObject hello = new JSONObject().put("t", "hello").put("token", token).put("errorReasons", true);
      if (extend) hello.put("extend", true);
      return hello.toString();
    } catch (JSONException invalid) {
      throw new IllegalArgumentException("Invalid speech token");
    }
  }

  static String tts(String id, String phrase) {
    try {
      return new JSONObject().put("t", "tts").put("id", id).put("text", phrase).put("flush", true).toString();
    } catch (JSONException invalid) {
      throw new IllegalArgumentException("Invalid speech text");
    }
  }

  static String finish(String id) {
    return control("finish", id);
  }

  static String cancel(String id) {
    return control("cancel", id);
  }

  private static String control(String type, String id) {
    try {
      return new JSONObject().put("t", type).put("id", id).toString();
    } catch (JSONException invalid) {
      throw new IllegalArgumentException("Invalid speech identity");
    }
  }

  static CloudSpeechPolicy.SttKind sttKind(String type) {
    if (type == null) return null;
    switch (type) {
      case "connected": return CloudSpeechPolicy.SttKind.CONNECTED;
      case "start-of-turn": return CloudSpeechPolicy.SttKind.START_OF_TURN;
      case "turn-resumed": return CloudSpeechPolicy.SttKind.TURN_RESUMED;
      case "end-of-turn": return CloudSpeechPolicy.SttKind.END_OF_TURN;
      case "transcript-update": return CloudSpeechPolicy.SttKind.TRANSCRIPT_UPDATE;
      case "eager-end-of-turn": return CloudSpeechPolicy.SttKind.EAGER_END_OF_TURN;
      default: return null;
    }
  }

  /** One relay control frame: its protocol frame, and the transcript, renewal or error code it carries. */
  static final class Control {
    final CloudSpeechPolicy.Frame frame;
    final String transcript, expiresAt, error;

    Control(CloudSpeechPolicy.Frame frame, String transcript, String expiresAt, String error) {
      this.frame = frame;
      this.transcript = transcript;
      this.expiresAt = expiresAt;
      this.error = error;
    }
  }

  /** Reads one relay control frame; throws for anything outside the v1 wire. */
  static Control control(String text) {
    if (text == null || text.getBytes(StandardCharsets.UTF_8).length > MAX_CONTROL) throw new IllegalArgumentException("Oversized speech control");
    try {
      JSONObject row = new JSONObject(text);
      String type = row.getString("t");
      switch (type) {
        case "ready":
          if (row.getInt("version") != 1 || row.getInt("sampleRate") != RATE || row.getInt("channels") != 1) throw new IllegalArgumentException("Invalid speech format");
          return new Control(new CloudSpeechPolicy.Frame.Ready(), null, null, null);
        case "extended":
          return new Control(new CloudSpeechPolicy.Frame.Extended(), null, row.getString("expiresAt"), null);
        case "stt": {
          JSONObject event = row.getJSONObject("event");
          CloudSpeechPolicy.SttKind kind = sttKind(event.getString("type"));
          String transcript = event.optString("transcript", "");
          if (kind == null || transcript.length() > MAX_TRANSCRIPT) throw new IllegalArgumentException("Invalid recognition event");
          return new Control(new CloudSpeechPolicy.Frame.Stt(kind), transcript, null, null);
        }
        case "tts_prepared":
          return new Control(new CloudSpeechPolicy.Frame.Prepared(identity(row)), null, null, null);
        case "flush_complete":
          return new Control(new CloudSpeechPolicy.Frame.Flushed(identity(row)), null, null, null);
        case "complete":
          return new Control(new CloudSpeechPolicy.Frame.Complete(identity(row)), null, null, null);
        case "error":
          return relayError(row);
        default:
          throw new IllegalArgumentException("Invalid speech event");
      }
    } catch (JSONException invalid) {
      throw new IllegalArgumentException("Invalid speech control");
    }
  }

  private static String identity(JSONObject row) throws JSONException {
    String id = row.getString("id");
    if (!id(id)) throw new IllegalArgumentException("Invalid speech identity");
    return id;
  }

  private static Control relayError(JSONObject row) {
    Object code = row.opt("code"), reason = row.opt("reason");
    boolean hasReason = row.has("reason");
    if (!(code instanceof String) || !ERROR_CODES.contains(code) || row.length() != (hasReason ? 3 : 2)) throw new IllegalArgumentException("Invalid speech error");
    if (hasReason && (!"unavailable".equals(code) || !(INSUFFICIENT_CREDITS.equals(reason) || ALLOWANCE_EXHAUSTED.equals(reason)))) throw new IllegalArgumentException("Invalid speech error");
    CloudSpeechPolicy.RelayErrorCode relay = CloudSpeechPolicy.RelayErrorCode.valueOf(((String) code).toUpperCase(java.util.Locale.ROOT));
    return new Control(new CloudSpeechPolicy.Frame.Error(relay, hasReason), null, null, hasReason ? (String) reason : (String) code);
  }

  /** The refusal code a status stands for when the body names none. */
  static CloudSpeechPolicy.RefusalCode defaultCode(int status) {
    if (status == 401) return CloudSpeechPolicy.RefusalCode.AUTHENTICATION_REQUIRED;
    if (status == 402) return CloudSpeechPolicy.RefusalCode.INSUFFICIENT_CREDITS;
    if (status == 403) return CloudSpeechPolicy.RefusalCode.ACCESS_DENIED;
    if (status == 404) return CloudSpeechPolicy.RefusalCode.NOT_FOUND;
    if (status == 429) return CloudSpeechPolicy.RefusalCode.RATE_LIMITED;
    if (status == 502) return CloudSpeechPolicy.RefusalCode.PROVIDER_INVALID_RESPONSE;
    if (status >= 500) return CloudSpeechPolicy.RefusalCode.SERVICE_UNAVAILABLE;
    return CloudSpeechPolicy.RefusalCode.INVALID_REQUEST;
  }

  static CloudSpeechPolicy.RefusalCode code(String wire) {
    for (CloudSpeechPolicy.RefusalCode code : CloudSpeechPolicy.RefusalCode.values()) if (code.wire().equals(wire)) return code;
    return null;
  }

  static CloudSpeechPolicy.RefusalReason reason(String wire) {
    for (CloudSpeechPolicy.RefusalReason reason : CloudSpeechPolicy.RefusalReason.values()) if (reason.wire().equals(wire)) return reason;
    return CloudSpeechPolicy.RefusalReason.NO_REASON;
  }

  /** Epoch milliseconds a {@code Retry-After} header names (seconds or an HTTP date), or 0. */
  static long retryAfter(String header, long now) {
    if (header == null) return 0;
    String value = header.trim();
    if (value.matches("\\d{1,9}")) return now + Long.parseLong(value) * 1000;
    try {
      return ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli();
    } catch (RuntimeException invalid) {
      return 0;
    }
  }

  private static long time(Object value) {
    return value instanceof Integer || value instanceof Long ? Math.max(0, ((Number) value).longValue()) : 0;
  }

  /** The cloud answer of a non-2xx HTTP response: a refusal with its code, reason and wait, or a misdirection. */
  static CloudSpeechPolicy.Answer refused(int status, String body, String retryAfter, long now) {
    if (status < 400) return CloudSpeechPolicy.MISDIRECTED;
    CloudSpeechPolicy.RefusalCode code = null;
    CloudSpeechPolicy.RefusalReason reason = CloudSpeechPolicy.RefusalReason.NO_REASON;
    long retryAt = 0, resetsAt = 0;
    if (body != null && !body.isEmpty()) {
      try {
        JSONObject row = new JSONObject(body);
        code = code(row.optString("error", ""));
        if (code != null) {
          reason = reason(row.optString("reason", ""));
          retryAt = time(row.opt("retryAt"));
          resetsAt = time(row.opt("resetsAt"));
        }
      } catch (JSONException unreadable) {
        code = null;
      }
    }
    if (code == null) code = defaultCode(status);
    if (retryAt <= 0) retryAt = retryAfter(retryAfter, now);
    CloudSpeechPolicy.Wait wait = CloudSpeechPolicy.NO_WAIT;
    if (code == CloudSpeechPolicy.RefusalCode.ALLOWANCE_EXHAUSTED && resetsAt > 0) wait = new CloudSpeechPolicy.Wait.ResetsAt(resetsAt);
    else if (retryAt > 0 && (code.status == 429 || code.status == 503)) wait = new CloudSpeechPolicy.Wait.RetryAt(retryAt);
    return new CloudSpeechPolicy.Answer.Refused(new CloudSpeechPolicy.Refusal(code, reason, wait));
  }

  /** The renderer's code for an HTTP refusal: {@code voice-http-<status>}, except 404, its one batch fallback signal. */
  static String httpCode(int status) {
    return (status == 404 ? "cloud-http-" : "voice-http-") + status;
  }
}
