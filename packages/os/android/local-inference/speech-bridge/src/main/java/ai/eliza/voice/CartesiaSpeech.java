// spec/os/voice/cloudSpeech.md, "Story: Transcribe a recording or hear a reply with one cloud request"
package ai.eliza.voice;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.UUID;
import org.json.JSONObject;

/**
 * The fixed direct Cartesia transport a product uses inside its own capture and playback lifecycle.
 * No key persistence, retry, provider fallback, logging, microphone or playback ownership.
 */
public final class CartesiaSpeech {
  private CartesiaSpeech() {}

  public static final String VERSION = "2026-03-01", VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

  private static final int RECORDING_LIMIT = 8 * 1024 * 1024, TRANSCRIPT_BODY_LIMIT = 256 * 1024, AUDIO_LIMIT = 8 * 1024 * 1024;
  private static final int TEXT_LIMIT = 5000, TRANSCRIPT_LIMIT = 16000, CHUNK = 8192;

  /** The caller's lifecycle check, run before and during each step of a request. */
  public interface Guard {
    void check() throws Exception;
    void opened(HttpURLConnection connection) throws Exception;
  }

  public interface Connections { HttpURLConnection open(URL url) throws Exception; }

  public static final Connections HTTPS = url -> (HttpURLConnection) url.openConnection();

  /** A non-2xx Cartesia answer, by status only. */
  public static final class HttpFailure extends IOException {
    public final int status;

    HttpFailure(int status) {
      super("Cartesia request failed");
      this.status = status;
    }
  }

  private static HttpURLConnection connect(String path, String key, Guard guard, Connections connections) throws Exception {
    if (key == null || !key.matches("[!-~]{8,1024}")) throw new IllegalArgumentException("Invalid Cartesia credential");
    guard.check();
    HttpURLConnection connection = connections.open(new URL("https://api.cartesia.ai" + path));
    try {
      guard.opened(connection);
      guard.check();
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(20000);
      connection.setReadTimeout(120000);
      connection.setUseCaches(false);
      connection.setRequestMethod("POST");
      connection.setDoOutput(true);
      connection.setRequestProperty("Authorization", "Bearer " + key);
      connection.setRequestProperty("Cartesia-Version", VERSION);
      return connection;
    } catch (Exception failure) {
      connection.disconnect();
      throw failure;
    }
  }

  private static byte[] response(HttpURLConnection connection, int limit, Guard guard) throws Exception {
    guard.check();
    int status = connection.getResponseCode();
    if (status < 200 || status >= 300) throw new HttpFailure(status);
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    try (InputStream input = connection.getInputStream()) {
      byte[] chunk = new byte[CHUNK];
      int n;
      while ((n = input.read(chunk)) != -1) {
        guard.check();
        if (output.size() + n > limit) throw new IOException("Cartesia response too large");
        output.write(chunk, 0, n);
      }
    }
    guard.check();
    return output.toByteArray();
  }

  public static String transcribe(String key, byte[] wav, Guard guard, Connections connections) throws Exception {
    if (wav == null || wav.length < 44 || wav.length > RECORDING_LIMIT) throw new IllegalArgumentException("Invalid recording");
    String boundary = "Eliza" + UUID.randomUUID().toString().replace("-", "");
    byte[] prefix = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nink-whisper\r\n--" + boundary
        + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
    byte[] suffix = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII);
    HttpURLConnection connection = connect("/stt", key, guard, connections);
    try {
      connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
      connection.setFixedLengthStreamingMode(prefix.length + wav.length + suffix.length);
      try (OutputStream output = connection.getOutputStream()) {
        guard.check();
        output.write(prefix);
        for (int offset = 0; offset < wav.length; offset += CHUNK) {
          guard.check();
          output.write(wav, offset, Math.min(CHUNK, wav.length - offset));
        }
        output.write(suffix);
      }
      byte[] bytes = response(connection, TRANSCRIPT_BODY_LIMIT, guard);
      Object text = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).opt("text");
      if (!(text instanceof String) || ((String) text).length() > TRANSCRIPT_LIMIT) throw new IOException("Invalid Cartesia transcript");
      return (String) text;
    } finally {
      connection.disconnect();
    }
  }

  public static byte[] synthesize(String key, String text, Guard guard, Connections connections) throws Exception {
    if (text == null || text.trim().isEmpty() || text.length() > TEXT_LIMIT) throw new IllegalArgumentException("Invalid speech text");
    byte[] body = new JSONObject()
        .put("model_id", "sonic-3.5")
        .put("transcript", text)
        .put("voice", new JSONObject().put("mode", "id").put("id", VOICE))
        .put("output_format", new JSONObject().put("container", "wav").put("encoding", "pcm_s16le").put("sample_rate", 24000))
        .toString().getBytes(StandardCharsets.UTF_8);
    HttpURLConnection connection = connect("/tts/bytes", key, guard, connections);
    try {
      connection.setRequestProperty("Content-Type", "application/json");
      connection.setFixedLengthStreamingMode(body.length);
      try (OutputStream output = connection.getOutputStream()) {
        guard.check();
        output.write(body);
      }
      byte[] bytes = response(connection, AUDIO_LIMIT, guard);
      if (bytes.length < 44 || bytes[0] != 'R' || bytes[1] != 'I' || bytes[2] != 'F' || bytes[3] != 'F'
          || bytes[8] != 'W' || bytes[9] != 'A' || bytes[10] != 'V' || bytes[11] != 'E') throw new IOException("Invalid Cartesia audio");
      return bytes;
    } finally {
      connection.disconnect();
      Arrays.fill(body, (byte) 0);
    }
  }
}
