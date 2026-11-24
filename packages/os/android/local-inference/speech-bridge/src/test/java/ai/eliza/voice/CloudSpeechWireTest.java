// spec/cloud/services/speechRelay.md, "The wire is version 1 with 16 kHz mono PCM16 and bounded frames"; spec/os/voice/cloudSpeech.md, "Only a mint answer naming the deployment's own relay opens the socket, and a refused key is reported once and never retried"; spec/os/voice/cloudSpeech.md, "The device accepts relay frames only in protocol order, and any other frame ends the session"
package ai.eliza.voice;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

/** JVM checks of the cloud speech relay wire: frames, phrases, renewals, refusals and the relay address. */
public final class CloudSpeechWireTest {
  static void require(boolean yes, String what) {
    if (!yes) throw new AssertionError(what);
  }

  static boolean refused(Runnable action) {
    try {
      action.run();
      return false;
    } catch (IllegalArgumentException expected) {
      return true;
    }
  }

  static byte[] audio(String id, int pcmBytes) {
    byte[] name = id.getBytes(StandardCharsets.US_ASCII);
    byte[] frame = new byte[2 + name.length + pcmBytes];
    frame[0] = 1;
    frame[1] = (byte) name.length;
    System.arraycopy(name, 0, frame, 2, name.length);
    return frame;
  }

  @Test public void audioFramesAreBoundedAndNamed() {
    CloudSpeechWire.Audio decoded = CloudSpeechWire.decode(audio("u1", 640));
    require(decoded.id.equals("u1") && decoded.pcm.length == 640, "id and PCM");
    require(refused(() -> CloudSpeechWire.decode(audio("u1", 641))), "odd PCM");
    require(refused(() -> CloudSpeechWire.decode(audio("u1", 65538))), "oversized PCM");
    require(refused(() -> CloudSpeechWire.decode(audio("bad id", 2))), "id pattern");
    byte[] wrongKind = audio("u1", 2);
    wrongKind[0] = 2;
    require(refused(() -> CloudSpeechWire.decode(wrongKind)), "kind byte");
    require(CloudSpeechWire.floats(new byte[] {0, (byte) 0x80})[0] == -1f, "PCM16 little endian");
    require(CloudSpeechWire.millis(32000) == 1000 && CloudSpeechWire.millis(31) == 0, "milliseconds of PCM");
  }

  @Test public void phrasesSplitAtSpacesWithinTheTextLimit() {
    StringBuilder text = new StringBuilder();
    while (text.length() < 3000) text.append("word ");
    List<String> parts = CloudSpeechWire.phrases(text.toString());
    require(parts.size() == 3 && String.join("", parts).equals(text.toString()), "whole text kept");
    for (String part : parts) require(part.length() <= CloudSpeechWire.MAX_PHRASE && !part.trim().isEmpty(), "bounded, not blank");
    require(refused(() -> CloudSpeechWire.phrases(" ")), "blank text");
    require(refused(() -> CloudSpeechWire.phrases("a".repeat(4097))), "text limit");
    require(refused(() -> CloudSpeechWire.phrases("a".repeat(2000))), "a word longer than a phrase");
  }

  @Test public void paceIsAPercentFromFiftyToTwoHundred() {
    require(CloudSpeechWire.pace(1.0) == 100 && CloudSpeechWire.pace(0.5) == 50 && CloudSpeechWire.pace(2.0) == 200, "in range");
    require(CloudSpeechWire.pace(0.49) == -1 && CloudSpeechWire.pace(2.5) == -1 && CloudSpeechWire.pace(null) == -1 && CloudSpeechWire.pace(Double.NaN) == -1, "out of range");
  }

  @Test public void renewalsMoveForwardWithinOneWindow() {
    long now = 1_800_000_000_000L;
    require(CloudSpeechWire.renewal(java.time.Instant.ofEpochMilli(now + 60_000).toString(), now + 30_000, now) == now + 60_000, "later, within a window");
    require(refused(() -> CloudSpeechWire.renewal(java.time.Instant.ofEpochMilli(now + 20_000).toString(), now + 30_000, now)), "earlier");
    require(refused(() -> CloudSpeechWire.renewal(java.time.Instant.ofEpochMilli(now + 70_000).toString(), now + 30_000, now)), "beyond a window");
    require(refused(() -> CloudSpeechWire.renewal("soon", now, now)), "not an instant");
  }

  @Test public void onlyTheDeploymentsOwnRelayIsAccepted() {
    require(CloudSpeechWire.origin("https://cloud.example"), "https origin");
    require(!CloudSpeechWire.origin("http://cloud.example") && !CloudSpeechWire.origin("https://cloud.example/path")
        && !CloudSpeechWire.origin("https://user@cloud.example") && !CloudSpeechWire.origin("https://cloud.example:8443"), "anything else");
    String id = "123e4567-e89b-12d3-a456-426614174000";
    require(CloudSpeechWire.relayUrl("https://cloud.example", id).equals("wss://cloud.example/api/v1/voice/speech/ws?sessionId=" + id), "relay address");
    require(CloudSpeechWire.uuid(id) && !CloudSpeechWire.uuid("1-1-1-1-1"), "canonical session ids only");
    require(CloudSpeechWire.bearer("token") && !CloudSpeechWire.bearer("a\nb") && !CloudSpeechWire.bearer(""), "bearer token");
  }

  @Test public void controlFramesFollowTheV1Wire() {
    require(CloudSpeechWire.control("{\"t\":\"ready\",\"version\":1,\"sampleRate\":16000,\"channels\":1,\"expiresAt\":\"2026-01-01T00:00:00Z\"}").frame instanceof CloudSpeechPolicy.Frame.Ready, "ready");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"ready\",\"version\":2,\"sampleRate\":16000,\"channels\":1}")), "another version");
    CloudSpeechWire.Control end = CloudSpeechWire.control("{\"t\":\"stt\",\"event\":{\"type\":\"end-of-turn\",\"transcript\":\"hello\"}}");
    require(end.frame.equals(new CloudSpeechPolicy.Frame.Stt(CloudSpeechPolicy.SttKind.END_OF_TURN)) && end.transcript.equals("hello"), "turn end with its text");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"stt\",\"event\":{\"type\":\"speech\"}}")), "unknown recognition event");
    require(CloudSpeechWire.control("{\"t\":\"complete\",\"id\":\"u1\"}").frame.equals(new CloudSpeechPolicy.Frame.Complete("u1")), "complete");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"complete\",\"id\":\"u 1\"}")), "complete names a valid id");
    CloudSpeechWire.Control funding = CloudSpeechWire.control("{\"t\":\"error\",\"code\":\"unavailable\",\"reason\":\"allowance_exhausted\"}");
    require(funding.frame.equals(new CloudSpeechPolicy.Frame.Error(CloudSpeechPolicy.RelayErrorCode.UNAVAILABLE, true)) && funding.error.equals("allowance_exhausted"), "funding reason");
    require(CloudSpeechWire.control("{\"t\":\"error\",\"code\":\"closed\"}").error.equals("closed"), "session over");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"error\",\"code\":\"closed\",\"reason\":\"insufficient_credits\"}")), "only funding carries a reason");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"error\",\"code\":\"unavailable\",\"detail\":\"x\"}")), "no other key");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"tts_prepared\",\"id\":\"" + "a".repeat(9000) + "\"}")), "control size");
    require(refused(() -> CloudSpeechWire.control("{\"t\":\"timings\"}")), "unknown frame");
  }

  @Test public void refusalsKeepTheirCodeReasonAndWait() {
    long now = 1_000_000;
    CloudSpeechPolicy.Answer limited = CloudSpeechWire.refused(429, "", "5", now);
    require(limited.equals(new CloudSpeechPolicy.Answer.Refused(new CloudSpeechPolicy.Refusal(CloudSpeechPolicy.RefusalCode.RATE_LIMITED,
        CloudSpeechPolicy.RefusalReason.NO_REASON, new CloudSpeechPolicy.Wait.RetryAt(now + 5000)))), "rate limit retries after its header");
    CloudSpeechPolicy.Answer expired = CloudSpeechWire.refused(401, "{\"error\":\"authentication_required\",\"reason\":\"credential_expired\"}", null, now);
    require(expired.equals(new CloudSpeechPolicy.Answer.Refused(new CloudSpeechPolicy.Refusal(CloudSpeechPolicy.RefusalCode.AUTHENTICATION_REQUIRED,
        CloudSpeechPolicy.RefusalReason.CREDENTIAL_EXPIRED, CloudSpeechPolicy.NO_WAIT))), "credential reason kept");
    CloudSpeechPolicy.Answer spent = CloudSpeechWire.refused(402, "{\"error\":\"allowance_exhausted\",\"resetsAt\":9000000}", null, now);
    require(spent.equals(new CloudSpeechPolicy.Answer.Refused(new CloudSpeechPolicy.Refusal(CloudSpeechPolicy.RefusalCode.ALLOWANCE_EXHAUSTED,
        CloudSpeechPolicy.RefusalReason.NO_REASON, new CloudSpeechPolicy.Wait.ResetsAt(9000000)))), "allowance resets");
    CloudSpeechPolicy.Answer denied = CloudSpeechWire.refused(403, "{\"error\":\"access_denied\",\"retryAt\":5000}", null, now);
    require(((CloudSpeechPolicy.Answer.Refused) denied).refusal().waitTime().equals(CloudSpeechPolicy.NO_WAIT), "a refusal that is not retryable carries no retry time");
    require(CloudSpeechWire.refused(500, "<html>", null, now).equals(new CloudSpeechPolicy.Answer.Refused(new CloudSpeechPolicy.Refusal(
        CloudSpeechPolicy.RefusalCode.SERVICE_UNAVAILABLE, CloudSpeechPolicy.RefusalReason.NO_REASON, CloudSpeechPolicy.NO_WAIT))), "an unreadable outage");
    require(CloudSpeechWire.refused(302, null, null, now) == CloudSpeechPolicy.MISDIRECTED, "a redirect is misdirected");
    require(CloudSpeechWire.httpCode(404).equals("cloud-http-404") && CloudSpeechWire.httpCode(429).equals("voice-http-429"), "renderer codes");
  }

  @Test public void helloAsksForRenewalOnlyWhenOffered() {
    String plain = CloudSpeechWire.hello("token", false);
    require(plain.contains("\"errorReasons\":true") && plain.contains("\"token\":\"token\"") && !plain.contains("extend"), "no extend");
    require(CloudSpeechWire.hello("token", true).contains("\"extend\":true"), "extend when offered");
    require(refused(() -> CloudSpeechWire.hello("a".repeat(6145), false)), "token limit");
  }

  @Test public void onlyADroppedConnectionSendsConsentAgain() {
    require(CloudSpeechWire.droppedConnection(new java.net.SocketException("Connection reset")), "reset");
    require(CloudSpeechWire.droppedConnection(new java.net.SocketException("Connection reset by peer")), "reset by peer");
    require(CloudSpeechWire.droppedConnection(new java.io.IOException("unexpected end of stream on https://cloud.example/...")), "dropped pooled connection");
    require(!CloudSpeechWire.droppedConnection(new java.net.ConnectException("Connection reset")), "unconnected");
    require(!CloudSpeechWire.droppedConnection(new java.net.SocketTimeoutException("timeout")), "timeout");
    require(!CloudSpeechWire.droppedConnection(new java.io.IOException("Connection reset")), "other failure");
    require(!CloudSpeechWire.droppedConnection(new java.io.IOException("Oversized speech response")), "oversized answer");
    require(!CloudSpeechWire.droppedConnection(new java.io.IOException()), "no message");
  }

  @Test public void onlyAShortServiceUnavailableThatFitsTheDeadlineSendsConsentAgain() {
    long now = 1_800_000_000_000L, room = 10_000;
    require(CloudSpeechWire.consentRetryMs(503, "1", now, room) == 1000, "cold limiter, one second");
    require(CloudSpeechWire.consentRetryMs(503, "2", now, room) == 2000, "two seconds is the most");
    require(CloudSpeechWire.consentRetryMs(503, "0", now, room) == 0, "at once");
    require(CloudSpeechWire.consentRetryMs(503, "3", now, room) == -1, "a longer wait falls back as before");
    require(CloudSpeechWire.consentRetryMs(503, null, now, room) == -1, "no Retry-After");
    require(CloudSpeechWire.consentRetryMs(503, "soon", now, room) == -1, "an unreadable Retry-After");
    String date = java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME.format(java.time.Instant.ofEpochMilli(now + 1000).atZone(java.time.ZoneOffset.UTC));
    require(CloudSpeechWire.consentRetryMs(503, date, now, room) == 1000, "an HTTP date");
    for (int status : new int[] {429, 500, 502, 504, 401}) require(CloudSpeechWire.consentRetryMs(status, "1", now, room) == -1, "only 503, not " + status);
    require(CloudSpeechWire.consentRetryMs(503, "1", now, 3000) == 1000, "the wait and one request fit exactly");
    require(CloudSpeechWire.consentRetryMs(503, "1", now, 2999) == -1, "past the startup deadline");
    require(CloudSpeechWire.consentRetryMs(503, "0", now, -1) == -1, "deadline already passed");
  }

  @Test public void theConnectionIsWarmedAtMostOnceAMinuteForEachOrigin() {
    CloudSpeechWire.Warmups warmups = new CloudSpeechWire.Warmups();
    long now = 5_000_000;
    require(warmups.admit("https://cloud.example", now), "first warm-up");
    require(!warmups.admit("https://cloud.example", now + 59_999), "again within a minute");
    require(warmups.admit("https://staging.cloud.example", now + 1), "another origin");
    require(warmups.admit("https://cloud.example", now + 60_000), "a minute later");
    require(!warmups.admit("https://cloud.example", now + 60_001), "counted from the last warm-up");
  }
}
