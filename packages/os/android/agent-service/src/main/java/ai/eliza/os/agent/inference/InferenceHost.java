// spec/os/agentService/inference.md, "Only the app's own process is served, for an operation the host offers, within its frame limit and its model storage"; spec/os/agentService/inference.md, "One pass runs at a time on its own context, nothing is freed under it, and a failed pass drops the context it used"; spec/os/agentService/inference.md, "An embedding is answered only by the verified model assigned to embeddings, as a finite vector of its dimensions"; spec/os/agentService/inference.md, "Speech readiness and the end-of-turn score say only what the host answered"
package ai.eliza.os.agent.inference;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Serves the resident agent's on-device inference engine from the app process over an abstract local
 * socket: one length-prefixed UTF-8 JSON frame in, one out. Speech and the end-of-turn score share one
 * resident native context and embeddings have their own session; one pass runs at a time, and logs carry
 * sizes only, never text, transcripts or vectors.
 */
public final class InferenceHost {
  private static final String TAG = "ElizaInferenceHost";
  private static final long IDLE_TICK_MS = 30_000L;

  private enum Pass { NONE, SPEECH, EMBEDDING, END_OF_TURN }

  private static final class Refusal extends Exception {
    final String code;
    Refusal(String code, String message) { super(message); this.code = code; }
  }

  private final String socketName;
  private final String speechBundle;
  private final File modelRoot;
  private final InferenceNative engine;
  private final long idleUnloadMs;
  private final int ownUid;
  private final AtomicBoolean running = new AtomicBoolean(false);
  private final Object passLock = new Object();
  private final Object cancelLock = new Object();
  private volatile LocalServerSocket server;
  private volatile ScheduledExecutorService idle;
  private volatile long lastPassAt = android.os.SystemClock.elapsedRealtime();

  private long resident;
  private String residentBundle;
  private long embedding;
  private String embeddingFile;
  private String verifiedFile;
  private String verifiedDigest;
  private long verifiedLength;
  private long verifiedModified;
  private volatile Pass pass = Pass.NONE;
  private volatile boolean cancelAsked;

  /**
   * A host on the consumer's socket name, speech bundle and model storage. {@code idleUnloadMs} of 0 keeps
   * the contexts until {@link #release} or {@link #stop}.
   */
  public InferenceHost(String socketName, String speechBundle, File modelRoot, InferenceNative engine, long idleUnloadMs) {
    this.socketName = socketName;
    this.speechBundle = speechBundle;
    this.modelRoot = modelRoot;
    this.engine = engine;
    this.idleUnloadMs = idleUnloadMs;
    this.ownUid = android.os.Process.myUid();
  }

  /** Loads the native library and binds the socket; throws when either fails, so nothing is advertised. Idempotent. */
  public synchronized void start() {
    if (running.get()) return;
    if (!engine.available()) throw new IllegalStateException("the native inference library is not available");
    try {
      server = new LocalServerSocket(socketName);
    } catch (IOException e) {
      throw new IllegalStateException("cannot bind the inference socket", e);
    }
    running.set(true);
    Thread accept = new Thread(this::acceptLoop, "eliza-inference-accept");
    accept.setDaemon(true);
    accept.start();
    if (idleUnloadMs > 0) {
      ScheduledExecutorService ticks = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "eliza-inference-idle");
        t.setDaemon(true);
        return t;
      });
      ticks.scheduleWithFixedDelay(this::idleTick, IDLE_TICK_MS, IDLE_TICK_MS, TimeUnit.MILLISECONDS);
      idle = ticks;
    }
  }

  /** Stops accepting, cancels a running speech pass and frees both contexts once it ends. */
  public synchronized void stop() {
    running.set(false);
    signalCancel();
    ScheduledExecutorService ticks = idle;
    idle = null;
    if (ticks != null) ticks.shutdownNow();
    LocalServerSocket bound = server;
    server = null;
    if (bound != null) {
      try {
        Os.shutdown(bound.getFileDescriptor(), OsConstants.SHUT_RDWR);
      } catch (ErrnoException alreadyClosed) {
        Log.i(TAG, "inference socket already shut down");
      }
      try {
        bound.close();
      } catch (IOException ignored) {
        Log.i(TAG, "inference socket closed with an error");
      }
    }
    release("stopped");
  }

  /** Frees both contexts after any running pass, as an idle or memory-pressure release does. */
  public void release(String reason) {
    synchronized (passLock) {
      unloadLocked();
    }
    Log.i(TAG, "released the inference contexts: " + reason);
  }

  private void idleTick() {
    if (android.os.SystemClock.elapsedRealtime() - lastPassAt < idleUnloadMs) return;
    synchronized (passLock) {
      if ((resident != 0L || embedding != 0L) && android.os.SystemClock.elapsedRealtime() - lastPassAt >= idleUnloadMs) unloadLocked();
    }
  }

  private void acceptLoop() {
    while (running.get()) {
      LocalServerSocket bound = server;
      if (bound == null) break;
      final LocalSocket client;
      try {
        client = bound.accept();
      } catch (IOException e) {
        if (running.get()) Log.w(TAG, "accept failed", e);
        continue;
      }
      Thread worker = new Thread(() -> serve(client), "eliza-inference-conn");
      worker.setDaemon(true);
      worker.start();
    }
  }

  private void serve(LocalSocket client) {
    try (LocalSocket socket = client;
         DataInputStream in = new DataInputStream(socket.getInputStream());
         DataOutputStream out = new DataOutputStream(socket.getOutputStream())) {
      if (socket.getPeerCredentials().getUid() != ownUid) {
        Log.w(TAG, "refused a connection from another user");
        return;
      }
      while (running.get()) {
        final int length;
        try {
          length = in.readInt();
        } catch (IOException closed) {
          return;
        }
        if (length <= 0) return;
        if (length > InferencePolicy.AUDIO_FRAME_BYTES) {
          write(out, tooLarge(InferencePolicy.AUDIO_FRAME_BYTES));
          return;
        }
        byte[] frame = new byte[length];
        in.readFully(frame);
        JSONObject request;
        try {
          request = new JSONObject(new String(frame, StandardCharsets.UTF_8));
        } catch (JSONException malformed) {
          write(out, refusal("OP_REFUSED", "the request is not a JSON object"));
          continue;
        }
        InferencePolicy.Op op = InferencePolicy.Op.named(request.optString("op", ""));
        InferencePolicy.Verdict verdict = InferencePolicy.requestVerdict(true, op, length, InferencePolicy.confined(modelRoot, pathsOf(request)));
        if (verdict != InferencePolicy.Verdict.SERVED) {
          write(out, verdict == InferencePolicy.Verdict.FRAME_TOO_LARGE ? tooLarge(InferencePolicy.frameLimit(op)) : refusal(verdict.name(), "the request is refused"));
          continue;
        }
        if (op == InferencePolicy.Op.SYNTHESIZE || op == InferencePolicy.Op.TRANSCRIBE) {
          Thread watch = hangUpWatch(in);
          write(out, answer(op, request));
          watch.interrupt();
          return;
        }
        write(out, answer(op, request));
      }
    } catch (IOException e) {
      Log.w(TAG, "connection error", e);
    } catch (RuntimeException e) {
      Log.e(TAG, "unexpected host failure", e);
    }
  }

  private Thread hangUpWatch(InputStream in) {
    Thread watch = new Thread(() -> {
      try {
        if (in.read() < 0 && pass == Pass.SPEECH) signalCancel();
      } catch (IOException closed) {
        if (pass == Pass.SPEECH) signalCancel();
      }
    }, "eliza-inference-hangup");
    watch.setDaemon(true);
    watch.start();
    return watch;
  }

  private static List<String> pathsOf(JSONObject request) {
    List<String> paths = new ArrayList<>();
    if (request.has("bundleDir")) paths.add(request.optString("bundleDir", ""));
    if (request.has("file")) paths.add(request.optString("file", ""));
    JSONArray files = request.optJSONArray("files");
    if (files != null) for (int i = 0; i < files.length(); i++) paths.add(files.optString(i, ""));
    return paths;
  }

  private String answer(InferencePolicy.Op op, JSONObject request) {
    try {
      switch (op) {
        case CAPABILITIES: return ok().put("synthesis", engine.synthesisReady(speechBundle)).put("transcription", engine.transcriptionReady(speechBundle)).toString();
        case LOAD: return load(request.getString("bundleDir"));
        case UNLOAD: return unload();
        case WARM_EMBEDDING: return warm(request);
        case EMBED: return embed(request);
        case SYNTHESIZE: return synthesize(request.optString("text", ""));
        case TRANSCRIBE: return transcribe(request.optString("pcmBase64", ""), request.optInt("sampleRate", 0));
        case CANCEL_SPEECH: return ok().put("signalled", signalCancel()).toString();
        case END_OF_TURN: return endOfTurn(request.optString("transcript", ""));
        default: return refusal("OP_REFUSED", "the operation is not offered");
      }
    } catch (Refusal refused) {
      return refusal(refused.code, refused.getMessage());
    } catch (JSONException malformed) {
      return refusal("FAILED", "the request is missing a field");
    }
  }

  private String load(String bundleDir) throws JSONException, Refusal {
    synchronized (passLock) {
      if (resident != 0L && bundleDir.equals(residentBundle)) return ok().toString();
      closeResidentLocked();
      long opened = engine.openContext(bundleDir);
      if (opened == 0L) throw new Refusal("FAILED", "the model could not be loaded");
      resident = opened;
      residentBundle = bundleDir;
      lastPassAt = android.os.SystemClock.elapsedRealtime();
      return ok().toString();
    }
  }

  private String unload() throws JSONException {
    synchronized (passLock) {
      unloadLocked();
    }
    return ok().toString();
  }

  private String warm(JSONObject request) throws JSONException, Refusal {
    synchronized (passLock) {
      openEmbeddingLocked(request.getString("file"), request.optString("sha256", ""));
      return ok().toString();
    }
  }

  private String embed(JSONObject request) throws JSONException, Refusal {
    String file = request.getString("file");
    int dimensions = request.getInt("dimensions");
    int pooling = request.optInt("pooling", 0);
    byte[] utf8 = wellFormed(request.getString("text"));
    if (pooling < 1 || pooling > 3) throw new Refusal("FAILED", "the pooling is not one the library knows");
    synchronized (passLock) {
      openEmbeddingLocked(file, request.optString("sha256", ""));
      beginLocked(Pass.EMBEDDING);
      try {
        float[] vector = engine.embed(embedding, utf8, pooling);
        InferencePolicy.EmbeddingVerdict verdict = InferencePolicy.embeddingVerdict(true, dimensions, vector);
        if (verdict != InferencePolicy.EmbeddingVerdict.VECTOR_SERVED) throw new Refusal("FAILED", "the model returned no valid vector of its dimensions");
        JSONArray values = new JSONArray();
        for (double value : InferencePolicy.unit(vector)) values.put(value);
        Log.i(TAG, "embedded " + utf8.length + " bytes into " + vector.length + " dimensions");
        return ok().put("embedding", values).toString();
      } catch (IllegalArgumentException rejected) {
        throw new Refusal("FAILED", "the model rejected the text");
      } catch (RuntimeException | LinkageError failure) {
        failLocked(Pass.EMBEDDING);
        throw new Refusal("UNAVAILABLE", "the embedding engine failed");
      } finally {
        endLocked();
      }
    }
  }

  private String synthesize(String text) throws JSONException, Refusal {
    byte[] utf8 = wellFormed(text);
    if (text.trim().isEmpty()) throw new Refusal("FAILED", "there is no text to speak");
    synchronized (passLock) {
      if (!engine.synthesisReady(speechBundle)) throw new Refusal("UNAVAILABLE", "on-device speech synthesis is not ready");
      ensureResidentLocked();
      beginLocked(Pass.SPEECH);
      try {
        float[] pcm = engine.synthesize(resident, utf8);
        int rate = engine.sampleRate(resident);
        if (pcm == null || pcm.length == 0) throw new Refusal("FAILED", "the text has nothing to speak");
        if (rate <= 0) throw new IllegalStateException("no synthesis sample rate");
        ByteBuffer bytes = ByteBuffer.allocate(pcm.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float sample : pcm) bytes.putFloat(sample);
        Log.i(TAG, "synthesized " + utf8.length + " bytes into " + pcm.length + " samples at " + rate + " Hz");
        return ok().put("sampleRate", rate).put("pcmBase64", Base64.getEncoder().encodeToString(bytes.array())).toString();
      } catch (CancellationException cancelled) {
        throw new Refusal("CANCELLED", "synthesis was cancelled");
      } catch (IllegalArgumentException rejected) {
        throw new Refusal("FAILED", "the speech engine rejected the text");
      } catch (RuntimeException | LinkageError failure) {
        failLocked(Pass.SPEECH);
        throw new Refusal("FAILED", "the speech engine failed");
      } finally {
        endLocked();
      }
    }
  }

  private String transcribe(String pcmBase64, int sampleRate) throws JSONException, Refusal {
    if (sampleRate <= 0) throw new Refusal("FAILED", "the audio has no sample rate");
    final byte[] raw;
    try {
      raw = Base64.getDecoder().decode(pcmBase64);
    } catch (IllegalArgumentException malformed) {
      throw new Refusal("FAILED", "the audio is not base64");
    }
    if (raw.length < 4 || raw.length % 4 != 0) throw new Refusal("FAILED", "the audio is not float PCM");
    float[] pcm = new float[raw.length / 4];
    ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(pcm);
    synchronized (passLock) {
      if (!engine.transcriptionReady(speechBundle)) throw new Refusal("UNAVAILABLE", "on-device transcription is not ready");
      ensureResidentLocked();
      beginLocked(Pass.SPEECH);
      try {
        String text = engine.transcribe(resident, pcm, sampleRate);
        Log.i(TAG, "transcribed " + pcm.length + " samples at " + sampleRate + " Hz into " + (text == null ? 0 : text.length()) + " characters");
        return ok().put("text", text == null ? "" : text).toString();
      } catch (CancellationException cancelled) {
        throw new Refusal("CANCELLED", "transcription was cancelled");
      } catch (IllegalArgumentException rejected) {
        throw new Refusal("FAILED", "the speech engine rejected the audio");
      } catch (RuntimeException | LinkageError failure) {
        failLocked(Pass.SPEECH);
        throw new Refusal("FAILED", "the speech engine failed");
      } finally {
        endLocked();
      }
    }
  }

  private String endOfTurn(String transcript) throws JSONException, Refusal {
    byte[] utf8 = wellFormed(transcript);
    synchronized (passLock) {
      if (resident == 0L) return ok().put("available", false).put("reason", "no model is loaded").toString();
      if (!engine.endOfTurnReady(resident)) return ok().put("available", false).put("reason", "the loaded model cannot score the end of a turn").toString();
      beginLocked(Pass.END_OF_TURN);
      try {
        int milli = InferencePolicy.endOfTurnMilli(engine.endOfTurn(resident, utf8));
        if (milli < 0) return ok().put("available", false).put("reason", "the model returned no probability").toString();
        return ok().put("available", true).put("milli", milli).toString();
      } catch (IllegalArgumentException rejected) {
        return ok().put("available", false).put("reason", "the model rejected the transcript").toString();
      } catch (RuntimeException | LinkageError failure) {
        failLocked(Pass.END_OF_TURN);
        return ok().put("available", false).put("reason", "the model failed to score").toString();
      } finally {
        endLocked();
      }
    }
  }

  private void openEmbeddingLocked(String file, String sha256) throws Refusal {
    if (!sha256.matches("[0-9a-f]{64}")) throw new Refusal("UNAVAILABLE", "the embedding model has no pinned digest");
    if (!digestMatches(file, sha256)) throw new Refusal("UNAVAILABLE", "the embedding model is not the pinned artifact");
    if (embedding != 0L && file.equals(embeddingFile)) return;
    closeEmbeddingLocked();
    long opened;
    try {
      opened = engine.openEmbedding(file);
    } catch (RuntimeException | LinkageError failure) {
      opened = 0L;
    }
    if (opened == 0L) throw new Refusal("UNAVAILABLE", "the embedding model could not be opened");
    embedding = opened;
    embeddingFile = file;
  }

  private boolean digestMatches(String file, String sha256) {
    File model = new File(file);
    if (!model.isFile()) return false;
    if (file.equals(verifiedFile) && model.length() == verifiedLength && model.lastModified() == verifiedModified) return sha256.equals(verifiedDigest);
    try (FileInputStream input = new FileInputStream(model)) {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] block = new byte[65536];
      for (int count; (count = input.read(block)) != -1;) digest.update(block, 0, count);
      StringBuilder hex = new StringBuilder();
      for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
      verifiedFile = file;
      verifiedDigest = hex.toString();
      verifiedLength = model.length();
      verifiedModified = model.lastModified();
      return sha256.equals(verifiedDigest);
    } catch (IOException | NoSuchAlgorithmException unreadable) {
      return false;
    }
  }

  private void ensureResidentLocked() throws Refusal {
    if (resident != 0L) return;
    long opened = engine.openContext(speechBundle);
    if (opened == 0L) throw new Refusal("UNAVAILABLE", "the speech bundle could not be opened");
    resident = opened;
    residentBundle = speechBundle;
  }

  private void beginLocked(Pass kind) {
    synchronized (cancelLock) {
      pass = kind;
      cancelAsked = false;
    }
  }

  private void endLocked() {
    synchronized (cancelLock) {
      pass = Pass.NONE;
      cancelAsked = false;
    }
    lastPassAt = android.os.SystemClock.elapsedRealtime();
  }

  private void failLocked(Pass kind) {
    if (kind == Pass.EMBEDDING) closeEmbeddingLocked();
    else closeResidentLocked();
  }

  private boolean signalCancel() {
    synchronized (cancelLock) {
      if (pass != Pass.SPEECH || cancelAsked || resident == 0L) return false;
      cancelAsked = true;
      engine.cancelSpeech(resident);
      return true;
    }
  }

  private void unloadLocked() {
    closeResidentLocked();
    closeEmbeddingLocked();
  }

  private void closeResidentLocked() {
    synchronized (cancelLock) {
      if (resident != 0L) engine.closeContext(resident);
      resident = 0L;
      residentBundle = null;
    }
  }

  private void closeEmbeddingLocked() {
    if (embedding != 0L) engine.closeEmbedding(embedding);
    embedding = 0L;
    embeddingFile = null;
  }

  private static byte[] wellFormed(String text) throws Refusal {
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (Character.isHighSurrogate(c) ? ++i >= text.length() || !Character.isLowSurrogate(text.charAt(i)) : Character.isLowSurrogate(c)) {
        throw new Refusal("FAILED", "the text is not well-formed Unicode");
      }
    }
    return text.getBytes(StandardCharsets.UTF_8);
  }

  private static JSONObject ok() throws JSONException {
    return new JSONObject().put("ok", true);
  }

  private static String refusal(String code, String message) {
    try {
      return new JSONObject().put("ok", false).put("code", code).put("error", message).toString();
    } catch (JSONException e) {
      return "{\"ok\":false,\"code\":\"FAILED\"}";
    }
  }

  private static String tooLarge(int limit) {
    try {
      return new JSONObject().put("ok", false).put("code", "FRAME_TOO_LARGE").put("limitBytes", limit).put("error", "the request frame is over its limit").toString();
    } catch (JSONException e) {
      return "{\"ok\":false,\"code\":\"FRAME_TOO_LARGE\"}";
    }
  }

  private static void write(DataOutputStream out, String json) throws IOException {
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    out.writeInt(bytes.length);
    out.write(bytes);
    out.flush();
  }
}
