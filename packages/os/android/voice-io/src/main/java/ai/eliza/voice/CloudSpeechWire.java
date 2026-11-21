// spec/os/voice/cloudSpeech.md, "Only a mint answer naming the deployment's own relay opens the socket, and a refused key is reported once and never retried"; spec/os/voice/cloudSpeech.md, "The device accepts relay frames only in protocol order, and any other frame ends the session"
package ai.eliza.voice;

import ai.eliza.plugins.signin.CredentialJson;
import ai.eliza.voice.CloudSpeechPolicy.Frame;
import ai.eliza.voice.CloudSpeechPolicy.Refusal;
import ai.eliza.voice.CloudSpeechPolicy.RefusalCode;
import ai.eliza.voice.CloudSpeechPolicy.RefusalReason;
import ai.eliza.voice.CloudSpeechPolicy.RelayErrorCode;
import ai.eliza.voice.CloudSpeechPolicy.SttKind;
import ai.eliza.voice.CloudSpeechPolicy.Wait;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

public final class CloudSpeechWire {
  private CloudSpeechWire() {}

  public static final int RATE = 16_000, MAX_UPLINK = 3200, MAX_DOWNLINK = 65_536, MAX_CONTROL = 8192, MAX_TRANSCRIPT = 16_384;
  public static final int MAX_TEXT = 4096, MAX_PHRASE = 1024, MAX_SYNTHESIS_TEXT = 5000, MAX_HELLO_TOKEN = 6144;
  public static final long MAX_WINDOW_MS = 65_000;
  public static final String EXTEND_HEADER = "X-Eliza-Speech-Extend", EXTEND_OFFER = "1";
  public static final String BASE = "/api/v1/voice/speech/";
  private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

  public static final class Invalid extends IllegalArgumentException {
    Invalid(String what) { super("invalid speech wire: " + what); }
  }

  public record Audio(String id, byte[] pcm) {}

  public record Minted(String sessionId, String token, long expiresAt, String wsUrl, boolean extendOffered) {
    @Override public String toString() { return "Minted[sessionId=" + sessionId + ", expiresAt=" + expiresAt + ", extendOffered=" + extendOffered + "]"; }
  }

  public sealed interface Relay {
    record Control(Frame frame, String transcript, long expiresAt) implements Relay {}
    record Unknown() implements Relay {}
  }

  public static boolean id(String value) { return value != null && ID.matcher(value).matches(); }

  public static boolean origin(String apiOrigin) {
    try {
      URI uri = new URI(apiOrigin);
      return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getRawUserInfo() == null && uri.getRawQuery() == null
        && uri.getRawFragment() == null && (uri.getRawPath() == null || uri.getRawPath().isEmpty()) && (uri.getPort() == -1 || uri.getPort() == 443);
    } catch (Exception malformed) {
      return false;
    }
  }

  public static String consentNonce(String body, long now) {
    Map<String, Object> answer = CredentialJson.object(CredentialJson.parse(body), "consent");
    String nonce = CredentialJson.text(answer, "consentNonce");
    UUID.fromString(nonce);
    if (instant(CredentialJson.text(answer, "expiresAt")) <= now) throw new Invalid("expired consent");
    return nonce;
  }

  public static Minted minted(String body, String apiOrigin, String extendHeader, long now) {
    Map<String, Object> answer = CredentialJson.object(CredentialJson.parse(body), "session");
    if (CredentialJson.whole(answer, "version") != 1) throw new Invalid("version");
    String sessionId = CredentialJson.text(answer, "sessionId");
    UUID.fromString(sessionId);
    long expiresAt = instant(CredentialJson.text(answer, "expiresAt"));
    if (expiresAt <= now || expiresAt > now + MAX_WINDOW_MS) throw new Invalid("expiry");
    String wsUrl = CredentialJson.text(answer, "wsUrl");
    if (!wsUrl.equals(apiOrigin.replaceFirst("^https:", "wss:") + BASE + "ws?sessionId=" + sessionId)) throw new Invalid("destination");
    String token = CredentialJson.text(answer, "token");
    if (token.isEmpty() || token.length() > MAX_HELLO_TOKEN) throw new Invalid("token");
    return new Minted(sessionId, token, expiresAt, wsUrl, EXTEND_OFFER.equals(extendHeader));
  }

  public static String hello(String token, boolean extend) {
    return "{\"t\":\"hello\",\"token\":" + CredentialJson.quote(token) + ",\"errorReasons\":true" + (extend ? ",\"extend\":true" : "") + "}";
  }

  public static String utterance(String type, String id) { return "{\"t\":" + CredentialJson.quote(type) + ",\"id\":" + CredentialJson.quote(id) + "}"; }

  public static String tts(String id, String text) {
    return "{\"t\":\"tts\",\"id\":" + CredentialJson.quote(id) + ",\"text\":" + CredentialJson.quote(text) + ",\"flush\":true}";
  }

  public static Relay relay(String text) {
    if (text.getBytes(StandardCharsets.UTF_8).length > MAX_CONTROL) throw new Invalid("oversized control");
    Map<String, Object> row = CredentialJson.object(CredentialJson.parse(text), "frame");
    String type = CredentialJson.text(row, "t");
    return switch (type) {
      case "ready" -> {
        if (CredentialJson.whole(row, "version") != 1 || CredentialJson.whole(row, "sampleRate") != RATE || CredentialJson.whole(row, "channels") != 1) throw new Invalid("format");
        yield new Relay.Control(new Frame.Ready(), "", row.containsKey("expiresAt") ? instant(CredentialJson.text(row, "expiresAt")) : 0);
      }
      case "extended" -> new Relay.Control(new Frame.Extended(), "", instant(CredentialJson.text(row, "expiresAt")));
      case "stt" -> {
        Map<String, Object> event = CredentialJson.object(row.get("event"), "event");
        Object transcript = event.getOrDefault("transcript", "");
        if (!(transcript instanceof String heard) || heard.length() > MAX_TRANSCRIPT) throw new Invalid("transcript");
        yield new Relay.Control(new Frame.Stt(sttKind(CredentialJson.text(event, "type"))), heard, 0);
      }
      case "tts_prepared" -> new Relay.Control(new Frame.Prepared(utteranceId(row)), "", 0);
      case "flush_complete" -> new Relay.Control(new Frame.Flushed(utteranceId(row)), "", 0);
      case "complete" -> new Relay.Control(new Frame.Complete(utteranceId(row)), "", 0);
      case "error" -> new Relay.Control(new Frame.Error(relayCode(CredentialJson.text(row, "code")), row.containsKey("reason")), "", 0);
      default -> new Relay.Unknown();
    };
  }

  static SttKind sttKind(String type) {
    return switch (type) {
      case "connected" -> SttKind.CONNECTED;
      case "start-of-turn" -> SttKind.START_OF_TURN;
      case "turn-resumed" -> SttKind.TURN_RESUMED;
      case "end-of-turn" -> SttKind.END_OF_TURN;
      case "transcript-update" -> SttKind.TRANSCRIPT_UPDATE;
      case "eager-end-of-turn" -> SttKind.EAGER_END_OF_TURN;
      default -> throw new Invalid("recognition event");
    };
  }

  static RelayErrorCode relayCode(String code) {
    return switch (code) {
      case "unauthorized" -> RelayErrorCode.UNAUTHORIZED;
      case "protocol" -> RelayErrorCode.PROTOCOL;
      case "unavailable" -> RelayErrorCode.UNAVAILABLE;
      case "closed" -> RelayErrorCode.CLOSED;
      default -> throw new Invalid("relay error code");
    };
  }

  private static String utteranceId(Map<String, Object> row) {
    String id = CredentialJson.text(row, "id");
    if (!id(id)) throw new Invalid("utterance id");
    return id;
  }

  public static long renewal(long next, long current, long now) {
    if (next <= current || next > now + MAX_WINDOW_MS) throw new Invalid("renewal");
    return next;
  }

  public static Audio decode(byte[] frame) {
    if (frame == null || frame.length < 4 || frame[0] != 1) throw new Invalid("audio frame");
    int n = frame[1] & 255, offset = 2 + n, size = frame.length - offset;
    if (n < 1 || n > 64 || size < 2 || size % 2 != 0 || size > MAX_DOWNLINK) throw new Invalid("audio frame");
    String id = new String(frame, 2, n, StandardCharsets.US_ASCII);
    if (!id(id)) throw new Invalid("audio identity");
    return new Audio(id, Arrays.copyOfRange(frame, offset, frame.length));
  }

  public static float[] floats(byte[] pcm) {
    if (pcm == null || pcm.length == 0 || pcm.length % 2 != 0 || pcm.length > MAX_DOWNLINK) throw new Invalid("PCM");
    float[] out = new float[pcm.length / 2];
    for (int i = 0; i < out.length; i++) out[i] = (short) ((pcm[i * 2] & 255) | (pcm[i * 2 + 1] << 8)) / 32768f;
    return out;
  }

  public static long playedMs(long samples) { return samples * 1000 / RATE; }

  public static List<String> phrases(String text) {
    if (text == null || text.isBlank() || text.length() > MAX_TEXT) throw new Invalid("speech text");
    List<String> parts = new ArrayList<>();
    int start = 0;
    while (start < text.length()) {
      int end = Math.min(text.length(), start + MAX_PHRASE);
      if (end < text.length()) {
        int space = text.lastIndexOf(' ', end - 1);
        if (space < start) throw new Invalid("speech word is too long");
        end = space + 1;
      }
      String phrase = text.substring(start, end);
      if (!phrase.isBlank()) parts.add(phrase);
      start = end;
    }
    return parts;
  }

  public static double peak(byte[] pcm, int size) {
    double peak = 0;
    for (int i = 0; i + 1 < size; i += 2) peak = Math.max(peak, Math.abs((short) ((pcm[i] & 255) | (pcm[i + 1] << 8))) / 32768.0);
    return Math.min(1, peak);
  }

  public static Refusal refusal(int status, String body, String retryAfter, long now) {
    RefusalCode code = null;
    RefusalReason reason = RefusalReason.NO_REASON;
    Wait wait = CloudSpeechPolicy.NO_WAIT;
    try {
      Map<String, Object> answer = CredentialJson.object(CredentialJson.parse(body), "refusal");
      String error = CredentialJson.text(answer, "error");
      for (RefusalCode known : RefusalCode.values()) if (known.wire().equals(error) && known.status == status) code = known;
      if (answer.get("reason") instanceof String said) for (RefusalReason known : RefusalReason.values()) if (known.wire().equals(said)) reason = known;
      if (answer.get("retryAt") instanceof Long at) wait = new Wait.RetryAt(at);
      else if (answer.get("resetsAt") instanceof Long at) wait = new Wait.ResetsAt(at);
    } catch (IllegalArgumentException | NullPointerException unreadable) {
      code = null;
    }
    if (code == null) {
      code = statusCode(status);
      reason = RefusalReason.NO_REASON;
    }
    if (wait instanceof Wait.NoWait && status == 429 && retryAfter != null && retryAfter.matches("\\d{1,6}")) wait = new Wait.RetryAt(now + Long.parseLong(retryAfter) * 1000);
    return new Refusal(code, reason, wait);
  }

  static RefusalCode statusCode(int status) {
    return switch (status) {
      case 401 -> RefusalCode.AUTHENTICATION_REQUIRED;
      case 402 -> RefusalCode.INSUFFICIENT_CREDITS;
      case 403 -> RefusalCode.ACCESS_DENIED;
      case 404 -> RefusalCode.NOT_FOUND;
      case 413 -> RefusalCode.CONTENT_TOO_LARGE;
      case 429 -> RefusalCode.RATE_LIMITED;
      case 502 -> RefusalCode.PROVIDER_INVALID_RESPONSE;
      case 503 -> RefusalCode.SERVICE_UNAVAILABLE;
      default -> RefusalCode.INVALID_REQUEST;
    };
  }

  private static long instant(String value) {
    try {
      return Instant.parse(value).toEpochMilli();
    } catch (RuntimeException invalid) {
      throw new Invalid("time");
    }
  }
}
