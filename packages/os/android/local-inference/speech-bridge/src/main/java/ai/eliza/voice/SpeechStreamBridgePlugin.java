// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/speechOutput.md, "Audio focus is held while a reply speaks or a listener holds it, and abandoned exactly when neither does"; spec/os/voice/speechOutput.md, "A listener holds focus while its microphone is open, and a transient loss pauses it until focus returns"; spec/os/voice/cloudSpeech.md, "A transient focus loss pauses listening and speaking until focus returns"; spec/os/voice/speechOutput.md, "A focus loss stops the reply and drops its unplayed audio, and a ducking loss only lowers it"; spec/os/voice/microphone.md, "One user holds the slot, and every other reservation is refused while it does"
package ai.eliza.voice;

import ai.eliza.voice.CloudSpeechPolicy.Answer;
import ai.eliza.voice.CloudSpeechPolicy.DeviceCause;
import ai.eliza.voice.CloudSpeechPolicy.Ending;
import ai.eliza.voice.CloudSpeechPolicy.Event;
import ai.eliza.voice.CloudSpeechPolicy.Frame;
import ai.eliza.voice.CloudSpeechPolicy.Notice;
import ai.eliza.voice.CloudSpeechPolicy.OutputNotice;
import ai.eliza.voice.CloudSpeechPolicy.Phase;
import ai.eliza.voice.CloudSpeechPolicy.SlotAnswer;
import ai.eliza.voice.CloudSpeechPolicy.State;
import ai.eliza.voice.CloudSpeechPolicy.Step;
import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * The renderer's native cloud speech relay session. A product supplies the credential authority and
 * the reviewed origin. Each session drives one {@link CloudSpeechPolicy.Machine} with what the shell
 * observes and acts only on the notices it returns; credentials, PCM and the socket never reach JavaScript.
 */
public abstract class SpeechStreamBridgePlugin extends Plugin {

  /** Products expose only a fixed cloud origin, never a renderer-supplied destination. */
  protected abstract String cloudOrigin(String environment) throws Exception;

  /** Reads one selected credential under the product authority lock; it never reaches JavaScript. */
  protected abstract Credential readCredential(String environment, String expectedId, long epoch) throws Exception;

  /** The product's credential authority epoch; a change ends a session admitted under another. */
  protected abstract long authorityEpoch();

  /** One credential read for one session. */
  protected static final class Credential {
    public final String token;
    public final long expiresAt;

    public Credential(String token, long expiresAt) {
      this.token = token;
      this.expiresAt = expiresAt;
    }
  }

  /** Runs an activity-bound action (a permission prompt), rejecting the call when no activity can host it. */
  protected boolean launch(PluginCall call, Runnable action) {
    try {
      action.run();
      return true;
    } catch (IllegalStateException unavailable) {
      call.reject("Activity unavailable");
      return false;
    }
  }

  /** The format name of {@code cloudStreamTiming} records. */
  protected String diagnosticFormat() {
    return "eliza-cloud-stream-timing-v1";
  }

  /** A product that reads cloud plan limits returns the sanitized retry facts of an HTTP 429; the body never reaches JavaScript. */
  protected JSObject limitData(int status, String retryAfter, String body) {
    return null;
  }

  /** True while a surface that must never be overheard (a password entry) is shown. */
  protected boolean sensitiveSurfaceActive() {
    return false;
  }

  /** Told once when the cloud refused the session's credential itself, so the product can mark it rejected. */
  protected void credentialRefused(String environment, String credentialId, String reason) {}

  /** Host-native retirement of the speech authority: a pending start is cancelled and the open session ends under the old key. */
  protected final void retireSpeechAuthority() {
    final PluginCall waiting;
    final Session own;
    synchronized (this) {
      waiting = pendingStart;
      pendingStart = null;
      own = session;
    }
    if (waiting != null) waiting.reject("Cloud streaming speech stopped", "cancelled");
    if (own != null) revoked(own, 0);
  }

  private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
  private static final int RATE = CloudSpeechWire.RATE;
  private static final long HTTP_STARTUP_MS = 12_000, RELAY_STARTUP_MS = 8_000, PROGRESS_MS = 100, JOIN_MS = 1500, SILENCE_MS = 32, WARMUP_MS = 5_000;
  private static final long LEVEL_NS = 50_000_000L, FEED_BYTES = 8 * 1024 * 1024;
  private static final int FEED_TASKS = 1024, MAX_BODY = 32768, MAX_REFUSAL = 16384, MIC_FRAME = 1024, SILENCE_FRAMES = 30;
  private static final int MAX_QUEUE = 64000, TIMINGS = 100, STARTUP_TIMINGS = 64, PLAYBACK_CAPACITY = RATE * 5, CHUNK = 1600;
  private static final float AUDIBLE = 0.005f;
  private static final String AUDIO_FOCUS_LOST = "audio-focus-lost";

  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService control = Executors.newSingleThreadExecutor();
  private final ExecutorService media = Executors.newSingleThreadExecutor();
  private final OkHttpClient http = new OkHttpClient.Builder()
      .protocols(Collections.singletonList(Protocol.HTTP_1_1))
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(10, TimeUnit.SECONDS)
      .writeTimeout(5, TimeUnit.SECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build();
  private final SpeechOutputGate gate = new SpeechOutputGate();
  private final CloudSpeechWire.TimingRows<JSObject> timings = new CloudSpeechWire.TimingRows<>(STARTUP_TIMINGS, TIMINGS);
  private final CloudSpeechWire.Warmups warmups = new CloudSpeechWire.Warmups();
  private SpeechAudioFocus focus;
  private Utterance focusHolder;
  private Session listener;
  private volatile Session session;
  private volatile PluginCall pendingStart;
  private volatile boolean foreground = true, destroyed;
  private long timingSequence;

  /** What a step's shell observation carries for the notices it produces: the renderer's code, limit data, a transcript, a completion. */
  private static final class Why {
    final String code, text;
    final JSObject data;
    final Runnable done;

    Why(String code, JSObject data, String text, Runnable done) {
      this.code = code;
      this.data = data;
      this.text = text;
      this.done = done;
    }

    static Why code(String code) {
      return new Why(code, null, null, null);
    }
  }

  @Override
  public void load() {
    focus = new SpeechAudioFocus(getContext(), main, gate, this::outputNotices);
    focus.watchCalls(main::post);
  }

  @Override
  @PluginMethod
  public void requestPermissions(PluginCall call) {
    launch(call, () -> super.requestPermissions(call));
  }

  @PluginMethod
  public synchronized void cloudStreamTiming(PluginCall call) {
    JSArray rows = new JSArray();
    for (JSObject row : timings.rows()) rows.put(row);
    call.resolve(new JSObject().put("format", diagnosticFormat()).put("records", rows));
  }

  @PluginMethod
  public void prewarmCloudSpeech(PluginCall call) {
    String environment = call.getString("environment");
    call.resolve();
    if (environment != null && !destroyed) submit(control, () -> prewarm(environment), () -> {});
  }

  private void prewarm(String environment) {
    try {
      if (destroyed || !foreground || session != null || sensitiveSurfaceActive()) return;
      String origin = cloudOrigin(environment);
      if (!CloudSpeechWire.origin(origin) || !warmups.admit(origin, SystemClock.elapsedRealtime())) return;
      Call warm = http.newCall(new Request.Builder().url(origin + CloudSpeechWire.HEALTH).build());
      warm.timeout().timeout(WARMUP_MS, TimeUnit.MILLISECONDS);
      warm.enqueue(new Callback() {
        @Override public void onFailure(Call call, IOException failure) {}

        @Override public void onResponse(Call call, Response response) {
          try (response; InputStream in = response.body().byteStream()) {
            byte[] chunk = new byte[4096];
            int read = 0, n;
            while (read <= MAX_BODY && (n = in.read(chunk)) != -1) read += n;
          } catch (IOException unread) {
          }
        }
      });
    } catch (Exception unavailable) {
    }
  }

  @PluginMethod
  public void startCloudSpeech(PluginCall call) {
    if (destroyed || !foreground || sensitiveSurfaceActive()) {
      call.reject("Voice is not in the foreground");
      return;
    }
    boolean permission = !Boolean.TRUE.equals(call.getBoolean("muted", false)) && getPermissionState("microphone") != PermissionState.GRANTED;
    synchronized (this) {
      if (session != null || pendingStart != null || destroyed || !foreground) {
        call.reject("Voice is already active or unavailable");
        return;
      }
      pendingStart = call;
    }
    if (permission) {
      if (!launch(call, () -> requestPermissionForAlias("microphone", call, "microphoneReady"))) {
        synchronized (this) {
          if (pendingStart == call) pendingStart = null;
        }
      }
      return;
    }
    start(call);
  }

  @PermissionCallback
  private void microphoneReady(PluginCall call) {
    synchronized (this) {
      if (pendingStart != call) return;
      if (getPermissionState("microphone") != PermissionState.GRANTED) {
        pendingStart = null;
        call.reject("Microphone permission denied", "permission-denied");
        return;
      }
    }
    main.post(() -> {
      synchronized (this) {
        if (pendingStart != call) return;
        if (destroyed || !foreground) {
          pendingStart = null;
          call.reject("Voice is not in the foreground");
          return;
        }
      }
      start(call);
    });
  }

  private void start(PluginCall call) {
    String id = call.getString("sessionId"), environment = call.getString("environment"), credential = call.getString("credentialId");
    if (!CloudSpeechWire.uuid(id) || credential == null || credential.length() > 128 || environment == null) {
      synchronized (this) {
        if (pendingStart != call) return;
        pendingStart = null;
      }
      call.reject("Invalid speech session");
      return;
    }
    long admitted;
    try {
      admitted = authorityEpoch();
    } catch (RuntimeException unavailable) {
      synchronized (this) {
        if (pendingStart != call) return;
        pendingStart = null;
      }
      call.reject("Cloud account unavailable");
      return;
    }
    Session own;
    synchronized (this) {
      if (pendingStart != call) return;
      pendingStart = null;
      if (session != null || destroyed || !foreground) {
        call.reject("Voice is already active or unavailable");
        return;
      }
      own = new Session(id, environment, credential, admitted, call, ++timingSequence);
      own.muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
      session = own;
    }
    mark(own, "start");
    own.scheduleStartupDeadline();
    if (!own.muted) submit(media, () -> prepareMicrophone(own), () -> {});
    submit(control, () -> open(own), () -> refuse(own, "closed", null));
  }

  private void open(Session own) {
    try {
      if (!valid(own)) {
        invalidate(own);
        return;
      }
      if (focus.callActive()) {
        refuse(own, SpeechAudioFocusPolicy.CALL_ACTIVE, null);
        return;
      }
      own.origin = cloudOrigin(own.environment);
      if (!CloudSpeechWire.origin(own.origin)) throw new SecurityException("Invalid Cloud origin");
      Credential binding = readCredential(own.environment, own.credential, own.epoch);
      own.token = binding == null ? null : binding.token;
      if (binding == null || binding.expiresAt <= System.currentTimeMillis() || !CloudSpeechWire.bearer(own.token)) throw new SecurityException("Cloud account unavailable");
      if (!valid(own)) {
        invalidate(own);
        return;
      }
      begin(own);
    } catch (Exception unavailable) {
      refuse(own, "connect", null);
    }
  }

  private void begin(Session own) {
    synchronized (own) {
      if (own.finished) return;
      own.begun = true;
      apply(own, new Event.CredentialChanged(1), null);
      apply(own, new Event.Begin(), null);
    }
  }

  private void consent(Session own) {
    if (!valid(own)) {
      invalidate(own);
      return;
    }
    if (own.askedAt == 0) own.askedAt = SystemClock.elapsedRealtime();
    JSONObject answer;
    try {
      answer = consentAnswer(own);
    } catch (Exception failure) {
      if (failure instanceof Changed) {
        invalidate(own);
        return;
      }
      if (!clock(own)) return;
      apply(own, new Event.ConsentGiven(), null);
      answered(own, failure);
      return;
    }
    mark(own, "consent");
    if (!clock(own)) return;
    String nonce = answer.optString("consentNonce", "");
    long expires = CloudSpeechWire.instant(answer.optString("expiresAt", ""));
    if (!CloudSpeechWire.uuid(nonce) || expires < 0) {
      apply(own, new Event.ConsentGiven(), null);
      apply(own, new Event.Minted(CloudSpeechPolicy.MISDIRECTED), Why.code("connect"));
      return;
    }
    if (expires <= System.currentTimeMillis()) {
      apply(own, new Event.ConsentDismissed(), Why.code("consent-expired"));
      return;
    }
    if (apply(own, new Event.ConsentGiven(), null) == null) return;
    mint(own, nonce);
  }

  /** Reports the time waited for consent since the last report; false once the consent lapsed and the session ended. */
  private boolean clock(Session own) {
    long waited = SystemClock.elapsedRealtime() - own.askedAt - own.consentReported;
    if (waited > 0) {
      own.consentReported += waited;
      Step step = apply(own, new Event.ConsentClock(waited), Why.code("startup-timeout"));
      if (step != null && CloudSpeechPolicy.ended(step.state())) return false;
    }
    return !own.closed.get();
  }

  private void mint(Session own, String nonce) {
    JSONObject minted;
    try {
      minted = post(own, "session", new JSONObject().put("consentNonce", nonce));
      mark(own, "mint");
      String id = minted.optString("sessionId", "");
      if (CloudSpeechWire.uuid(id)) own.serverId = id;
      long expires = CloudSpeechWire.instant(minted.optString("expiresAt", "")), now = System.currentTimeMillis();
      String token = minted.optString("token", ""), address = minted.optString("wsUrl", "");
      if (own.serverId == null || minted.optInt("version", 0) != 1 || expires <= now || expires > now + CloudSpeechWire.MAX_WINDOW_MS
          || !address.equals(CloudSpeechWire.relayUrl(own.origin, own.serverId)) || token.isEmpty() || token.length() > CloudSpeechWire.MAX_TOKEN) {
        apply(own, new Event.Minted(CloudSpeechPolicy.MISDIRECTED), Why.code("connect"));
        return;
      }
      own.expiresAt = expires;
      own.wireToken = token;
      own.address = address;
    } catch (Exception failure) {
      if (failure instanceof Changed) invalidate(own);
      else answered(own, failure);
      return;
    }
    Step step = apply(own, new Event.Minted(CloudSpeechPolicy.ANSWERED), null);
    if (step == null || !(step.state().phase() instanceof Phase.Connecting)) {
      own.wireToken = null;
      return;
    }
    if (!own.armRelayStartup()) {
      apply(own, new Event.RelayLost(), Why.code("startup-timeout"));
      return;
    }
    mark(own, "relay-start");
    WebSocket socket = http.newWebSocket(new Request.Builder().url(own.address).build(), new Relay(own));
    own.socket = socket;
    if (own.closed.get()) socket.cancel();
  }

  /** The consent and mint exchange answered with a refusal or not at all. */
  private void answered(Session own, Exception failure) {
    if (failure instanceof Refused refused) {
      apply(own, new Event.Minted(refused.answer), new Why(CloudSpeechWire.httpCode(refused.status), refused.data, null, null));
      return;
    }
    String code = failure instanceof java.net.UnknownHostException ? "dns"
        : failure instanceof java.net.SocketTimeoutException ? "timeout"
        : failure instanceof javax.net.ssl.SSLException ? "tls"
        : "connect";
    apply(own, new Event.Minted(CloudSpeechPolicy.UNREACHABLE), Why.code(code));
  }

  /** The session no longer holds the authority or the foreground. */
  private static final class Changed extends IOException {
    Changed() {
      super("Speech session changed");
    }
  }

  /** A non-2xx consent or mint answer. */
  private static final class Refused extends IOException {
    final int status;
    final String retryAfter;
    final JSObject data;
    final Answer answer;

    Refused(int status, String retryAfter, JSObject data, Answer answer) {
      super("Cloud speech HTTP refused");
      this.status = status;
      this.retryAfter = retryAfter;
      this.data = data;
      this.answer = answer;
    }
  }

  private Refused refused(Response response) {
    int status = response.code();
    String body = null;
    try (InputStream in = response.body().byteStream()) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] chunk = new byte[4096];
      int n;
      while ((n = in.read(chunk)) != -1) {
        if (out.size() + n > MAX_REFUSAL) throw new IOException("Oversized refusal");
        out.write(chunk, 0, n);
      }
      body = out.toString(StandardCharsets.UTF_8.name());
    } catch (Exception unreadable) {
      body = null;
    }
    String retryAfter = response.header("Retry-After");
    JSObject data = null;
    if (status == 429) {
      try {
        data = limitData(status, retryAfter, body);
      } catch (RuntimeException unreadable) {
        data = null;
      }
    }
    return new Refused(status, retryAfter, data, CloudSpeechWire.refused(status, body, retryAfter, System.currentTimeMillis()));
  }

  private JSONObject consentAnswer(Session own) throws Exception {
    try {
      return post(own, "consent", new JSONObject());
    } catch (IOException failure) {
      long wait = failure instanceof Refused refused
          ? CloudSpeechWire.consentRetryMs(refused.status, refused.retryAfter, System.currentTimeMillis(), own.startupEndsMs - SystemClock.elapsedRealtime())
          : CloudSpeechWire.droppedConnection(failure) ? 0 : -1;
      if (wait < 0) throw failure;
      mark(own, "consent-retry");
      own.ended.await(wait, TimeUnit.MILLISECONDS);
      return post(own, "consent", new JSONObject());
    }
  }

  private JSONObject post(Session own, String path, JSONObject body) throws Exception {
    if (!valid(own)) throw new Changed();
    mark(own, path + "-start");
    Request request = new Request.Builder()
        .url(own.origin + CloudSpeechWire.BASE + path)
        .header("Authorization", "Bearer " + own.token)
        .post(RequestBody.create(body.toString(), JSON))
        .build();
    Call pending = http.newCall(request);
    own.pending = pending;
    try {
      if (!valid(own)) throw new Changed();
      try (Response response = pending.execute()) {
        if (!valid(own)) throw new Changed();
        own.httpStatus = response.code();
        mark(own, path + "-headers");
        if (!response.isSuccessful()) throw refused(response);
        if ("session".equals(path)) own.extendOffered = CloudSpeechWire.EXTEND_OFFER.equals(response.header(CloudSpeechWire.EXTEND_HEADER));
        ResponseBody bytes = response.body();
        if (bytes.contentLength() > MAX_BODY) throw new IOException("Invalid speech response");
        try (InputStream in = bytes.byteStream()) {
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          byte[] chunk = new byte[4096];
          int n;
          while ((n = in.read(chunk)) != -1) {
            if (out.size() + n > MAX_BODY) throw new IOException("Oversized speech response");
            out.write(chunk, 0, n);
          }
          mark(own, path + "-body");
          return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
        } catch (org.json.JSONException unreadable) {
          return new JSONObject();
        }
      }
    } catch (Exception failure) {
      mark(own, path + "-failed");
      throw failure;
    } finally {
      own.pending = null;
    }
  }

  @PluginMethod
  public void stopCloudSpeech(PluginCall call) {
    final PluginCall waiting;
    final Session own;
    synchronized (this) {
      PluginCall pending = pendingStart;
      waiting = pending != null && String.valueOf(call.getString("sessionId")).equals(pending.getString("sessionId")) ? pending : null;
      if (waiting != null) pendingStart = null;
      own = owned(call);
    }
    if (waiting != null) waiting.reject("Cloud streaming speech stopped", "cancelled");
    if (own == null) {
      call.resolve();
      return;
    }
    stop(own, null, call::resolve);
  }

  @PluginMethod
  public void setCloudSpeechOutputMuted(PluginCall call) {
    Session own = owned(call);
    Boolean muted = call.getBoolean("muted");
    if (own == null || muted == null) {
      call.reject("Speech session changed or mute was missing");
      return;
    }
    if (!valid(own)) {
      invalidate(own);
      call.reject("Speaker could not change state");
      return;
    }
    own.outputMuted = muted;
    Utterance spoken = own.spoken;
    if (spoken != null) {
      synchronized (spoken) {
        if (spoken.playback != null) spoken.playback.setOutputMuted(muted);
      }
    }
    call.resolve();
  }

  @PluginMethod
  public void setCloudSpeechMuted(PluginCall call) {
    Session own = owned(call);
    if (own == null) {
      call.reject("Speech session changed");
      return;
    }
    boolean muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
    if (!muted && getPermissionState("microphone") != PermissionState.GRANTED) {
      call.reject("Microphone permission required", "permission-required");
      return;
    }
    main.post(() -> {
      if (!valid(own)) {
        invalidate(own);
        call.reject("Microphone could not change state");
        return;
      }
      if (muted) mute(own, call);
      else {
        own.muted = false;
        unmute(own, call);
      }
    });
  }

  /** Main thread. A repeated mute sends another silence tail without reopening the microphone. */
  private void mute(Session own, PluginCall call) {
    own.muted = true;
    if (apply(own, new Event.Mute(), null) == null) {
      if (own.captured && !own.closed.get()) silence(own, own.muteGeneration.incrementAndGet(), SILENCE_FRAMES);
      closeLater(own);
    }
    releaseListening(own);
    if (call != null) submit(media, call::resolve, () -> call.reject("Voice is closed"));
  }

  /** Main thread. Before the session is live the unmute takes effect once the provider connects. */
  private void unmute(Session own, PluginCall call) {
    State s = own.machine.state();
    if (!CloudSpeechPolicy.live(s) || s.capture() == CloudSpeechPolicy.Capture.LISTENING) {
      if (call != null) call.resolve();
      return;
    }
    if (call != null) own.unmuteCalls.add(call);
    if (s.capture() == CloudSpeechPolicy.Capture.RESERVING) return;
    if (s.focusPaused()) {
      settleUnmutes(own, true);
      return;
    }
    boolean granted = microphoneGranted();
    String refused = granted ? focus.openListening() : null;
    if (refused != null) {
      own.muted = true;
      refuseUnmutes(own, refused);
      if (call == null) deviceEnded(own, DeviceCause.FOCUS_UNAVAILABLE, refused);
      return;
    }
    if (granted) listener = own;
    if (apply(own, new Event.Unmute(granted), null) != null) return;
    releaseListening(own);
    own.muted = true;
    settleUnmutes(own, false);
    if (call == null) settleStart(own, false);
  }

  /** Main thread. Only the session that holds focus for its microphone gives it up, so an ended session never releases a newer one's. */
  private void releaseListening(Session own) {
    if (listener != own) return;
    listener = null;
    focus.closeListening();
  }

  private void refuseUnmutes(Session own, String code) {
    List<PluginCall> calls;
    synchronized (own.unmuteCalls) {
      calls = new ArrayList<>(own.unmuteCalls);
      own.unmuteCalls.clear();
    }
    for (PluginCall call : calls) call.reject("Microphone could not change state", code);
  }

  private boolean microphoneGranted() {
    return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
  }

  private void settleUnmutes(Session own, boolean listening) {
    List<PluginCall> calls;
    synchronized (own.unmuteCalls) {
      calls = new ArrayList<>(own.unmuteCalls);
      own.unmuteCalls.clear();
    }
    for (PluginCall call : calls) {
      if (listening) call.resolve();
      else call.reject("Microphone could not change state");
    }
  }

  @PluginMethod
  public void speakCloudSpeech(PluginCall call) {
    Session own = owned(call);
    String id = call.getString("utteranceId"), text = call.getString("text");
    Double pace = call.getDouble("pace", 1.0);
    int percent = CloudSpeechWire.pace(pace);
    List<String> phrases;
    try {
      phrases = CloudSpeechWire.phrases(text);
    } catch (IllegalArgumentException invalid) {
      phrases = null;
    }
    if (own == null || own.speakerDraining || !CloudSpeechWire.id(id) || phrases == null || percent < 0) {
      call.reject("Invalid speech request");
      return;
    }
    List<String> parts = phrases;
    main.post(() -> speak(own, call, id, parts, percent, pace.floatValue()));
  }

  /** Main thread: the reply is admitted by the machine, then by the audio focus, then sent. */
  private void speak(Session own, PluginCall call, String id, List<String> phrases, int percent, float pace) {
    if (!valid(own)) {
      invalidate(own);
      call.reject("Speech could not start");
      return;
    }
    if (own.machine.state().focusPaused()) {
      call.reject("Speech is paused while another app holds audio focus", SpeechAudioFocusPolicy.FOCUS_PAUSED);
      return;
    }
    if (own.speakerDraining) {
      call.reject("Invalid speech request");
      return;
    }
    Utterance u = new Utterance(id, pace);
    synchronized (own) {
      if (apply(own, new Event.Speak(id, percent), null) == null) {
        call.reject("Speech could not start");
        return;
      }
      own.spoken = u;
    }
    String refused = focus.startSpeech();
    if (refused != null) {
      apply(own, new Event.Output(SpeechAudioFocusPolicy.CALL_ACTIVE.equals(refused) ? OutputNotice.REFUSED_CALL_ACTIVE
          : SpeechAudioFocusPolicy.FOCUS_PAUSED.equals(refused) ? OutputNotice.REFUSED_FOCUS_PAUSED : OutputNotice.REFUSED_FOCUS_DENIED), null);
      call.reject("Speech could not start", refused);
      return;
    }
    if (own.spoken != u) {
      focus.endSpeech();
      call.reject("Speech could not start");
      return;
    }
    focusHolder = u;
    mark(own, "tts-request");
    try {
      for (String phrase : phrases) own.send(CloudSpeechWire.tts(id, phrase));
      own.send(CloudSpeechWire.finish(id));
    } catch (IOException | RuntimeException unsent) {
      apply(own, new Event.CancelReply(), null);
      call.reject("Speech could not start");
      return;
    }
    u.announced = true;
    call.resolve();
  }

  @PluginMethod
  public void cancelCloudSpeech(PluginCall call) {
    main.post(() -> {
      Session own = owned(call);
      Utterance u = own == null ? null : own.spoken;
      String id = call.getString("utteranceId");
      if (u == null || id != null && !u.id.equals(id)) {
        call.resolve();
        return;
      }
      u.cancelCall = call;
      if (apply(own, new Event.CancelReply(), null) == null && u.cancelCall == call) {
        u.cancelCall = null;
        call.resolve();
      }
    });
  }

  private Session owned(PluginCall call) {
    Session own = session;
    return own != null && own.id.equals(call.getString("sessionId")) ? own : null;
  }

  /** Applies one observation to the session's machine and acts on the notices it returns, under the session's lock. */
  private Step apply(Session own, Event event, Why why) {
    synchronized (own) {
      if (own.finished) return null;
      State before = own.machine.state();
      Step step = own.machine.apply(event);
      if (step == null) return null;
      boolean ending = CloudSpeechPolicy.ended(step.state());
      for (Notice notice : step.out()) perform(own, notice, why, ending);
      observe(own, before, step.state());
      if (ending) finish(own, step, why);
      return step;
    }
  }

  private void perform(Session own, Notice notice, Why why, boolean ending) {
    switch (notice) {
      case Notice.AskConsent ask -> submit(control, () -> consent(own), () -> {});
      case Notice.ReserveLiveCapture reserve -> submit(media, () -> openMicrophone(own), () -> apply(own, new Event.CaptureAnswered(SlotAnswer.SLOT_BUSY), Why.code("capture")));
      case Notice.ReleaseLiveCapture release -> releaseMicrophone(own, ending);
      case Notice.RevokeSession revoke -> own.revokeOwed = true;
      case Notice.CancelUtterance cancel -> own.sendQuietly(CloudSpeechWire.cancel(cancel.utteranceId()));
      case Notice.ReportRefusedKey key -> {
        String environment = own.environment, credential = own.credential, reason = key.reason().wire();
        submit(control, () -> {
          try {
            credentialRefused(environment, credential, reason);
          } catch (RuntimeException ignored) {
          }
        }, () -> {});
      }
      case Notice.SessionFailed failed -> report(own, codeOf(failed.failure(), why), why == null ? null : why.data, failed.beforeAudio());
      case Notice.Heard heard -> {
        String text = why == null || why.text == null ? "" : why.text;
        if (heard.last()) {
          mark(own, "asr-final");
          emit(own, "speech-end", new JSObject().put("text", text).put("final", true));
        } else emit(own, "transcript", new JSObject().put("text", text).put("final", false));
      }
      case Notice.ReplySettled settled -> settled(own, settled, ending);
      case Notice.BatchSettled batch -> {}
    }
  }

  private static String codeOf(CloudSpeechPolicy.Failure failure, Why why) {
    if (why != null && why.code != null) return why.code;
    return switch (failure) {
      case REMOTE_UNREACHABLE -> "connection-lost";
      case ACCOUNT_INELIGIBLE -> "authority-changed";
      case CAPABILITY_UNAVAILABLE -> "capture";
      default -> "protocol";
    };
  }

  /** Shell actions that follow the machine's state rather than a notice. */
  private void observe(Session own, State before, State after) {
    if (before.phase() instanceof Phase.Connecting && after.phase() instanceof Phase.Ready) {
      mark(own, "ready");
      arm(own);
    }
    if (before.phase() instanceof Phase.Ready && CloudSpeechPolicy.live(after)) {
      mark(own, "stt-connected");
      main.post(() -> connected(own));
    }
    if (before.turn() == CloudSpeechPolicy.NO_TURN && CloudSpeechPolicy.ownedTurn(after)) {
      mark(own, "speech-start");
      emit(own, "speech-start", new JSObject());
    }
  }

  /** Every end of a session closes everything once: the error it owes, the socket, the microphone, the speaker and the minted session. */
  private void finish(Session own, Step step, Why why) {
    own.finished = true;
    boolean failed = step.out().stream().anyMatch(notice -> notice instanceof Notice.SessionFailed);
    if (!failed && step.state().phase() instanceof Phase.Closed closed && closed.ending() instanceof Ending.NotConsented)
      report(own, why == null || why.code == null ? "consent-expired" : why.code, null, true);
    detach(own);
    queueCleanup(own, why == null ? null : why.done);
  }

  /** A start refused before its session began: nothing was opened, so nothing else is owed. False once it began. */
  private boolean refuse(Session own, String code, Runnable done) {
    synchronized (own) {
      if (own.finished || own.begun) return false;
      own.finished = true;
      if (code != null) report(own, code, null, true);
      detach(own);
      queueCleanup(own, done);
      return true;
    }
  }

  /** Ends the session as the person's stop; a start refused before it began is told {@code code}. */
  private void stop(Session own, String code, Runnable done) {
    if (refuse(own, code, done)) return;
    if (apply(own, new Event.Stop(), new Why(code, null, null, done)) == null && done != null) done.run();
  }

  /** The device can no longer hold the session: before it began the start is refused, after it the session fails with {@code cause}; {@code code} is the renderer's. */
  private void deviceEnded(Session own, DeviceCause cause, String code) {
    if (refuse(own, code, null)) return;
    apply(own, new Event.DeviceEnded(cause), Why.code(code));
  }

  /** The key this session ran under is gone: {@code version} 0 when it was withdrawn, 2 when the authority moved on. */
  private void revoked(Session own, int version) {
    if (!refuse(own, "authority-changed", null)) apply(own, new Event.CredentialChanged(version), Why.code("authority-changed"));
  }

  private boolean valid(Session own) {
    if (own.closed.get() || session != own || destroyed || !foreground) return false;
    try {
      return own.epoch == authorityEpoch() && !sensitiveSurfaceActive();
    } catch (RuntimeException unavailable) {
      return false;
    }
  }

  private void invalidate(Session own) {
    if (own.closed.get()) return;
    boolean moved;
    try {
      moved = own.epoch != authorityEpoch();
    } catch (RuntimeException unavailable) {
      moved = true;
    }
    if (moved) revoked(own, 2);
    else if (sensitiveSurfaceActive()) revoked(own, 0);
    else if (destroyed) deviceEnded(own, DeviceCause.DEVICE_PAUSED, "cancelled");
    else deviceEnded(own, DeviceCause.DEVICE_PAUSED, "paused");
  }

  private void report(Session own, String code, JSObject data, boolean beforeAudio) {
    retireMicrophone(own);
    mark(own, "error");
    JSObject event = new JSObject().put("code", code).put("status", own.httpStatus).put("beforeAudio", beforeAudio);
    if (data != null) event.put("data", data);
    emit(own, "error", event);
    if (own.startSettled.compareAndSet(false, true)) own.startCall.reject("Cloud streaming speech is unavailable", code, data);
  }

  private void detach(Session own) {
    if (!own.closed.compareAndSet(false, true)) return;
    own.ended.countDown();
    mark(own, "stop");
    synchronized (this) {
      if (session == own) session = null;
    }
    main.removeCallbacks(own.deadline);
    main.removeCallbacks(own.expiry);
    Call pending = own.pending;
    if (pending != null) pending.cancel();
    WebSocket socket = own.socket;
    if (socket != null) socket.cancel();
    if (own.startSettled.compareAndSet(false, true)) own.startCall.reject("Cloud streaming speech stopped", "cancelled");
    settleUnmutes(own, false);
    Utterance u = own.spoken;
    own.spoken = null;
    if (u != null) {
      synchronized (u) {
        u.cancelled = true;
      }
      if (u.playback != null) u.playback.stop();
      main.post(() -> releaseFocus(u, false));
    }
    main.post(() -> releaseListening(own));
    own.feeder.shutdown();
  }

  private void queueCleanup(Session own, Runnable done) {
    Runnable work = () -> {
      cleanup(own);
      if (done != null) done.run();
    };
    submit(media, work, () -> {
      Thread thread = new Thread(work, "eliza-cloud-speech-retire");
      thread.setDaemon(true);
      thread.start();
    });
  }

  /** After the local microphone and speaker are released, the minted session is revoked once, best effort; no retry can replay audio. */
  private void cleanup(Session own) {
    closeMicrophone(own);
    StreamingSpeechPlayback last = own.lastPlayback;
    if (last != null) {
      try {
        last.join(JOIN_MS);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      }
    }
    String token = own.token, origin = own.origin, id = own.serverId;
    own.token = null;
    own.wireToken = null;
    if (!own.revokeOwed || id == null || origin == null || token == null) return;
    try {
      Request request = new Request.Builder()
          .url(origin + CloudSpeechWire.BASE + "session/" + id + "/revoke")
          .header("Authorization", "Bearer " + token)
          .post(RequestBody.create("{}", JSON))
          .build();
      http.newCall(request).enqueue(new Callback() {
        @Override public void onFailure(Call call, IOException failure) {}
        @Override public void onResponse(Call call, Response response) { response.close(); }
      });
    } catch (RuntimeException unsent) {
    }
  }

  /** Main thread: the provider connected. A muted start settles now; otherwise the microphone is asked for. */
  private void connected(Session own) {
    if (own.closed.get()) return;
    if (own.muted || !microphoneGranted()) {
      own.muted = true;
      settleStart(own, false);
    } else unmute(own, null);
    if (own.machine.state().capture() == CloudSpeechPolicy.Capture.MUTED) closeLater(own);
  }

  private void settleStart(Session own, boolean echoCancelled) {
    if (own.closed.get()) return;
    emit(own, "ready", new JSObject().put("sampleRate", RATE).put("echoCancelled", echoCancelled).put("muted", own.muted));
    if (own.startSettled.compareAndSet(false, true)) {
      main.removeCallbacks(own.deadline);
      own.startCall.resolve(new JSObject().put("sessionId", own.id).put("sampleRate", RATE).put("echoCancelled", echoCancelled).put("muted", own.muted));
    }
  }

  /** Media thread: listens on the microphone the start opened, or reserves the slot as live capture and opens it, and reports the answer. */
  private void openMicrophone(Session own) {
    if (own.closed.get() || own.machine.state().capture() != CloudSpeechPolicy.Capture.RESERVING) {
      settleUnmutes(own, settledAway(own));
      return;
    }
    Microphone microphone;
    SlotAnswer refusal = SlotAnswer.SLOT_BUSY;
    synchronized (own.warming) {
      microphone = own.microphone;
      if (!own.retired && (microphone == null || !microphone.ready())) {
        closeMicrophone(own);
        try {
          microphone = openDevice(own);
          own.microphone = microphone;
        } catch (LocalMicrophoneLease.Refused refused) {
          microphone = null;
          if (refused.refusal == LocalMicrophoneLease.Refusal.FENCED_REOPEN) refusal = SlotAnswer.FENCED_REOPEN;
        } catch (Exception | Error unavailable) {
          microphone = null;
        }
      }
    }
    if (microphone == null) {
      apply(own, new Event.CaptureAnswered(refusal), Why.code("capture"));
      return;
    }
    Step step = apply(own, new Event.CaptureAnswered(SlotAnswer.NO_REFUSAL), null);
    if (step == null || CloudSpeechPolicy.ended(step.state())) {
      if (own.microphone == microphone) own.microphone = null;
      microphone.close();
      settleUnmutes(own, settledAway(own));
      return;
    }
    own.captured = true;
    if (!microphone.listen(step.state().generation())) {
      deviceEnded(own, DeviceCause.MICROPHONE_LOST, "capture");
      return;
    }
    settleStart(own, microphone.echoEnabled);
    settleUnmutes(own, true);
  }

  private void prepareMicrophone(Session own) {
    synchronized (own.warming) {
      if (own.retired || own.muted || !valid(own) || !microphoneGranted() || focus.callActive()) return;
      try {
        own.microphone = openDevice(own);
      } catch (Exception | Error unavailable) {
      }
    }
  }

  private Microphone openDevice(Session own) throws Exception {
    LocalMicrophoneLease lease = LocalMicrophoneLease.PROCESS.reserve(LocalMicrophoneLease.User.LIVE_CAPTURE, false, () -> main.post(() -> draftRequested(own)));
    Microphone microphone = new Microphone(own, lease);
    try {
      microphone.open();
    } catch (Exception | Error unavailable) {
      microphone.close();
      throw unavailable;
    }
    return microphone;
  }

  private void retireMicrophone(Session own) {
    synchronized (own.warming) {
      own.retired = true;
      Microphone microphone = own.microphone;
      if (microphone == null || microphone.listened()) return;
      own.microphone = null;
      microphone.close();
    }
  }

  /** An unmute overtaken by a mute or a focus pause still succeeds: the mute won, or the regain opens the microphone. */
  private boolean settledAway(Session own) {
    return (own.muted || own.machine.state().focusPaused()) && !own.closed.get();
  }

  /** Main thread: a draft recording asked for the microphone, so live capture mutes and hands it over once released. */
  private void draftRequested(Session own) {
    if (own.closed.get()) return;
    mute(own, null);
  }

  private void releaseMicrophone(Session own, boolean ending) {
    long generation = own.muteGeneration.incrementAndGet();
    if (!ending && own.captured) main.post(() -> silence(own, generation, SILENCE_FRAMES));
    closeLater(own);
  }

  private void closeLater(Session own) {
    submit(media, () -> closeMicrophone(own), () -> {
      Thread thread = new Thread(() -> closeMicrophone(own), "eliza-cloud-speech-microphone-release");
      thread.setDaemon(true);
      thread.start();
    });
  }

  private void closeMicrophone(Session own) {
    Microphone microphone = own.microphone;
    own.microphone = null;
    if (microphone != null) microphone.close();
  }

  /** Each mute or focus pause after the microphone first opened sends a bounded silence tail that closes the provider's current turn. */
  private void silence(Session own, long generation, int remaining) {
    if (remaining <= 0 || !own.muted && !own.machine.state().focusPaused() || own.muteGeneration.get() != generation || own.closed.get()) return;
    if (own.machine.state().capture() == CloudSpeechPolicy.Capture.LISTENING) return;
    if (!own.sendPcm(new byte[MIC_FRAME], MIC_FRAME)) return;
    main.postDelayed(() -> silence(own, generation, remaining - 1), SILENCE_MS);
  }

  /** One live capture holding the process microphone slot. */
  private final class Microphone {
    static final int UNHEARD = 0, FAILED = -1;
    final Session own;
    final LocalMicrophoneLease lease;
    final AtomicInteger generation = new AtomicInteger(UNHEARD);
    AudioRecord recorder;
    AcousticEchoCanceler echo;
    Thread reader;
    boolean echoEnabled, closed;
    volatile boolean stopping;

    Microphone(Session own, LocalMicrophoneLease lease) {
      this.own = own;
      this.lease = lease;
    }

    synchronized void open() throws Exception {
      if (!microphoneGranted()) throw new SecurityException("Microphone permission denied");
      int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
      if (minimum <= 0) throw new IOException("Capture unavailable");
      boolean cancel = AcousticEchoCanceler.isAvailable();
      recorder = new AudioRecord.Builder()
          .setAudioSource(LiveCaptureSource.select(true, cancel, MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.VOICE_COMMUNICATION))
          .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
          .setBufferSizeInBytes(Math.max(minimum, 6400))
          .build();
      if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Capture unavailable");
      if (cancel) {
        echo = AcousticEchoCanceler.create(recorder.getAudioSessionId());
        if (echo != null) echo.setEnabled(true);
      }
      echoEnabled = echo != null && echo.getEnabled();
      recorder.startRecording();
      if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Capture unavailable");
      if (!lease.opened()) throw new IOException("Microphone slot was reclaimed");
      AudioRecord source = recorder;
      reader = new Thread(() -> read(source), "eliza-cloud-speech-microphone");
      reader.setDaemon(true);
      reader.start();
      mark(own, "capture-open");
    }

    synchronized boolean ready() {
      return generation.get() == UNHEARD && !closed && reader != null && reader.isAlive();
    }

    boolean listened() {
      return generation.get() > UNHEARD;
    }

    boolean listen(int generation) {
      return this.generation.compareAndSet(UNHEARD, generation);
    }

    /** Streams PCM only while the machine says capture {@code generation} listens; levels always once it listens, and nothing before. */
    private void read(AudioRecord source) {
      byte[] frame = new byte[MIC_FRAME];
      long levelAt = 0;
      boolean sent = false;
      try {
        while (!stopping && !own.closed.get()) {
          int count = source.read(frame, 0, frame.length, AudioRecord.READ_BLOCKING);
          if (stopping) break;
          if (count <= 0 || count % 2 != 0) throw new IOException("Microphone stopped");
          if (!valid(own)) {
            main.post(() -> invalidate(own));
            break;
          }
          int listened = generation.get();
          if (listened == UNHEARD) {
            Arrays.fill(frame, (byte) 0);
            continue;
          }
          State s = own.machine.state();
          boolean listening = s.capture() == CloudSpeechPolicy.Capture.LISTENING && s.generation() == listened;
          long now = System.nanoTime();
          if (now - levelAt > LEVEL_NS) {
            levelAt = now;
            emit(own, "level", new JSObject().put("peak", listening ? CloudSpeechWire.peak(frame, count) : 0));
          }
          if (!listening) continue;
          if (!own.sendPcm(frame, count)) throw new IOException("Speech upload stalled");
          if (!sent) {
            sent = true;
            mark(own, "first-frame-sent");
          }
        }
      } catch (Exception failure) {
        if (!stopping && !own.closed.get() && !generation.compareAndSet(UNHEARD, FAILED)) main.post(() -> deviceEnded(own, DeviceCause.MICROPHONE_LOST, "capture"));
      } finally {
        Arrays.fill(frame, (byte) 0);
      }
    }

    /** Stops the source and frees the slot with its release receipt, or holds it unconfirmed when the release cannot be confirmed. */
    synchronized void close() {
      if (closed) return;
      closed = true;
      stopping = true;
      lease.cancel();
      boolean confirmed = true;
      AudioRecord source = recorder;
      if (source != null) {
        try {
          source.stop();
        } catch (RuntimeException stopped) {
        }
      }
      Thread active = reader;
      if (active != null && active != Thread.currentThread()) {
        try {
          active.join(JOIN_MS);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
        }
        confirmed = !active.isAlive();
      }
      if (echo != null) {
        try {
          echo.release();
        } catch (RuntimeException released) {
        }
        echo = null;
      }
      if (source != null) {
        try {
          source.release();
        } catch (RuntimeException failed) {
          confirmed = false;
        }
      }
      if (!confirmed || !lease.release()) lease.releaseUnconfirmed();
    }
  }

  /** The relay socket's frames, in arrival order on OkHttp's reader thread. */
  private final class Relay extends WebSocketListener {
    final Session own;

    Relay(Session own) {
      this.own = own;
    }

    @Override
    public void onOpen(WebSocket socket, Response response) {
      own.socket = socket;
      if (!valid(own)) {
        invalidate(own);
        return;
      }
      mark(own, "ws-open");
      try {
        own.send(CloudSpeechWire.hello(own.wireToken, own.extendOffered));
      } catch (IOException | RuntimeException unsent) {
        apply(own, new Event.RelayLost(), Why.code("connect"));
      } finally {
        own.wireToken = null;
      }
    }

    @Override
    public void onMessage(WebSocket socket, String text) {
      controlFrame(own, text);
    }

    @Override
    public void onMessage(WebSocket socket, ByteString bytes) {
      audioFrame(own, bytes.toByteArray());
    }

    @Override
    public void onClosing(WebSocket socket, int code, String reason) {
      apply(own, new Event.FrameArrived(new Frame.Close(code)), Why.code("connection-lost"));
    }

    @Override
    public void onClosed(WebSocket socket, int code, String reason) {
      apply(own, new Event.FrameArrived(new Frame.Close(code)), Why.code("connection-lost"));
    }

    @Override
    public void onFailure(WebSocket socket, Throwable error, Response response) {
      apply(own, new Event.RelayLost(), Why.code("connection-lost"));
    }
  }

  private void controlFrame(Session own, String text) {
    if (!valid(own)) {
      invalidate(own);
      return;
    }
    CloudSpeechWire.Control row;
    try {
      row = CloudSpeechWire.control(text);
    } catch (RuntimeException invalid) {
      apply(own, new Event.FrameArrived(CloudSpeechWire.PROTOCOL_ERROR), Why.code("protocol"));
      return;
    }
    switch (row.frame) {
      case Frame.Extended extended -> {
        long next;
        try {
          if (!own.extendOffered) throw new IllegalArgumentException("Unrequested renewal");
          next = CloudSpeechWire.renewal(row.expiresAt, own.expiresAt, System.currentTimeMillis());
        } catch (IllegalArgumentException invalid) {
          apply(own, new Event.FrameArrived(CloudSpeechWire.PROTOCOL_ERROR), Why.code("protocol"));
          return;
        }
        Step step = apply(own, new Event.FrameArrived(extended), Why.code("protocol"));
        if (step == null || CloudSpeechPolicy.ended(step.state())) return;
        own.expiresAt = next;
        mark(own, "extended");
        arm(own);
      }
      case Frame.Error error -> {
        boolean beforeReady = own.machine.state().phase() instanceof Phase.Connecting;
        apply(own, new Event.FrameArrived(error), Why.code(error.funding() || beforeReady ? row.error : "unavailable"));
      }
      case Frame.Complete complete -> complete(own, complete);
      default -> apply(own, new Event.FrameArrived(row.frame), new Why("protocol", null, row.transcript, null));
    }
  }

  private void complete(Session own, Frame.Complete frame) {
    Utterance u = own.spoken;
    Step step = apply(own, new Event.FrameArrived(frame), Why.code("protocol"));
    if (step == null || CloudSpeechPolicy.ended(step.state())) return;
    if (u == null || !u.id.equals(frame.id()) || u.cancelled || u.streamComplete || u.playback == null) return;
    u.streamComplete = true;
    feed(own, u, null);
  }

  private void audioFrame(Session own, byte[] bytes) {
    if (!valid(own)) {
      invalidate(own);
      return;
    }
    CloudSpeechWire.Audio frame;
    try {
      frame = CloudSpeechWire.decode(bytes);
    } catch (IllegalArgumentException invalid) {
      apply(own, new Event.FrameArrived(CloudSpeechWire.PROTOCOL_ERROR), Why.code("playback"));
      return;
    }
    Step step = apply(own, new Event.FrameArrived(new Frame.Audio(frame.id)), Why.code("protocol"));
    if (step == null || CloudSpeechPolicy.ended(step.state())) return;
    own.receivedFrames++;
    own.receivedBytes += frame.pcm.length;
    Utterance u = own.spoken;
    if (u == null || u.cancelled || !u.id.equals(frame.id)) {
      Arrays.fill(frame.pcm, (byte) 0);
      return;
    }
    if (u.receivedBytes + frame.pcm.length > FEED_BYTES) {
      deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
      return;
    }
    long before = CloudSpeechWire.millis(u.receivedBytes);
    u.receivedBytes += frame.pcm.length;
    long ms = CloudSpeechWire.millis(u.receivedBytes) - before;
    if (ms > 0 || u.streamComplete) {
      synchronized (own) {
        Step arrived = apply(own, new Event.AudioArrived(frame.id, Math.max(1, ms)), Why.code("playback"));
        if (arrived == null || CloudSpeechPolicy.ended(arrived.state())) return;
        u.receivedMs += ms;
      }
    }
    if (!startPlayback(own, u)) {
      Arrays.fill(frame.pcm, (byte) 0);
      return;
    }
    feed(own, u, frame.pcm);
  }

  private boolean startPlayback(Session own, Utterance u) {
    synchronized (u) {
      if (u.cancelled || own.spoken != u) return false;
      if (u.playback != null) return true;
      u.playback = new StreamingSpeechPlayback(PLAYBACK_CAPACITY, RATE, AUDIBLE,
          () -> new FirstWriteSpeechOutput(AudioTrackSpeechOutput.open(RATE, u.pace), () -> firstAudio(own, u)),
          new StreamingSpeechPlayback.Listener() {
            @Override public void firstFrame(long nanos) {}

            @Override public void audible(long nanos, String clock) {
              u.audible = nanos;
              markAt(own, "first-audible", nanos, clock, u.started);
            }

            @Override public void ended(boolean silent) {
              played(own, u, true);
            }

            @Override public void failed(String reason) {
              if (own.spoken == u && !u.cancelled) deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
            }
          },
          System::nanoTime);
      own.lastPlayback = u.playback;
      u.playback.setOutputMuted(own.outputMuted);
      u.playback.start();
      if (gate.ducked()) u.playback.duck(true);
      return true;
    }
  }

  /** Writer thread, as the first sample is handed to the output. */
  private void firstAudio(Session own, Utterance u) {
    long nanos = System.nanoTime();
    markAt(own, "first-pcm", nanos, null, u.started);
    if (own.spoken != u || u.cancelled) return;
    apply(own, new Event.Output(OutputNotice.FIRST_AUDIO), null);
    emit(own, "audio-start", new JSObject().put("utteranceId", u.id).put("elapsedMs", (nanos - u.started) / 1_000_000));
    main.post(() -> progress(own, u));
  }

  /**
   * Hands PCM (or, with null, the utterance's completion) to the session's feeder in arrival order, so a
   * full playback queue never parks OkHttp's reader thread. Held PCM is bounded by bytes.
   */
  private void feed(Session own, Utterance u, byte[] pcm) {
    long size = pcm == null ? 0 : pcm.length;
    Runnable release = () -> {
      if (pcm != null) Arrays.fill(pcm, (byte) 0);
      own.feeding.addAndGet(-size);
    };
    if (own.feeding.addAndGet(size) > FEED_BYTES) {
      release.run();
      deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
      return;
    }
    submit(own.feeder, () -> {
      float[] samples = null;
      try {
        if (own.closed.get() || u.cancelled) return;
        boolean offered;
        if (pcm == null) offered = u.playback.offer(null, true);
        else {
          samples = CloudSpeechWire.floats(pcm);
          offered = true;
          for (int start = 0; offered && start < samples.length; start += CHUNK) {
            float[] chunk = Arrays.copyOfRange(samples, start, Math.min(samples.length, start + CHUNK));
            offered = u.playback.offer(chunk, false);
            if (offered) u.offeredSamples += chunk.length;
          }
        }
        if (!offered && !u.cancelled && own.spoken == u) deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      } catch (RuntimeException failure) {
        if (!u.cancelled && own.spoken == u) deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
      } finally {
        if (samples != null) Arrays.fill(samples, 0f);
        release.run();
      }
    }, () -> {
      release.run();
      if (!own.closed.get() && !u.cancelled && own.spoken == u) deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
    });
  }

  private void progress(Session own, Utterance u) {
    if (own.spoken != u || u.cancelled || own.closed.get()) return;
    played(own, u, false);
    main.postDelayed(() -> progress(own, u), PROGRESS_MS);
  }

  /** Reports the reply audio played since the last report; at the playback's end, all that was received. */
  private void played(Session own, Utterance u, boolean ended) {
    long target, receivedMs;
    synchronized (own) {
      if (own.spoken != u) return;
      receivedMs = u.receivedMs;
      target = ended ? receivedMs : Math.min(receivedMs, u.playedEstimateMs());
      if (target <= u.playedMs) return;
      if (apply(own, new Event.Played(target - u.playedMs), Why.code("playback")) == null) return;
      u.playedMs = target;
    }
    if (!ended) emit(own, "progress", new JSObject().put("utteranceId", u.id).put("playedMs", target).put("receivedMs", receivedMs));
  }

  /** The reply settled once: completed audio ends its focus; a cancelled one stops playing and drops its unplayed audio. */
  private void settled(Session own, Notice.ReplySettled settled, boolean ending) {
    Utterance u = own.spoken;
    if (u == null || !u.id.equals(settled.utteranceId())) return;
    own.spoken = null;
    StreamingSpeechPlayback playback;
    synchronized (u) {
      if (!settled.completed()) u.cancelled = true;
      playback = u.playback;
    }
    if (!settled.completed() && playback != null) {
      own.speakerDraining = true;
      playback.stop();
    }
    mark(own, "audio-end");
    if (!ending && u.announced && (settled.completed() || u.interrupted != null)) {
      JSObject event = new JSObject().put("utteranceId", u.id).put("silent", u.audible == 0).put("playedMs", settled.completed() ? u.receivedMs : u.playedMs);
      if (u.interrupted != null) event.put("interrupted", u.interrupted);
      emit(own, "audio-end", event);
    }
    if (!settled.completed() && !ending) drain(own, u, playback);
    main.post(() -> releaseFocus(u, settled.completed()));
  }

  /** Waits off the main thread for a stopped playback, then answers its cancel; an unconfirmed stop ends the session. */
  private void drain(Session own, Utterance u, StreamingSpeechPlayback playback) {
    PluginCall call = u.cancelCall;
    u.cancelCall = null;
    if (playback == null) {
      if (call != null) call.resolve(new JSObject().put("playedMs", u.playedMs));
      return;
    }
    submit(media, () -> {
      boolean joined;
      try {
        joined = playback.join(JOIN_MS);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
        joined = false;
      }
      if (joined) {
        own.speakerDraining = false;
        if (call != null) call.resolve(new JSObject().put("playedMs", u.playedMs));
        return;
      }
      if (call != null) call.reject("Speech cleanup was not confirmed", "speech-cleanup-unconfirmed");
      deviceEnded(own, DeviceCause.PLAYBACK_STUCK, "playback");
    }, () -> {
      if (call != null) call.reject("Speech cleanup was not confirmed", "speech-cleanup-unconfirmed");
    });
  }

  /** Main thread. Only the reply that holds the focus releases it, so a settled reply never abandons a newer one's focus. */
  private void releaseFocus(Utterance u, boolean completed) {
    if (focusHolder != u) return;
    focusHolder = null;
    if (completed) focus.endSpeech();
    else focus.cancelSpeech();
  }

  private void outputNotices(List<SpeechOutputGate.Notice> notices) {
    if (Looper.myLooper() == Looper.getMainLooper()) outputChanged(notices);
    else main.post(() -> outputChanged(notices));
  }

  /** Main thread: what the speech output reports. A transient focus loss stops the reply and pauses listening until focus returns; a permanent loss or a call ends the session. */
  private void outputChanged(List<SpeechOutputGate.Notice> notices) {
    Session own = session;
    Utterance holder = focusHolder;
    boolean call = notices.contains(SpeechOutputGate.Notice.STOP_CAPTURE);
    if (notices.contains(SpeechOutputGate.Notice.STOP_PLAYBACK) && holder != null) {
      focusHolder = null;
      if (own != null && own.spoken == holder) {
        holder.interrupted = call ? SpeechAudioFocusPolicy.CALL_ACTIVE : AUDIO_FOCUS_LOST;
        apply(own, new Event.Output(OutputNotice.STOP_PLAYBACK), null);
        if (!call) apply(own, new Event.CancelReply(), null);
      } else if (holder.playback != null) holder.playback.stop();
    }
    boolean duck = notices.contains(SpeechOutputGate.Notice.DUCK_VOLUME), restore = notices.contains(SpeechOutputGate.Notice.RESTORE_VOLUME);
    if ((duck || restore) && holder != null) {
      StreamingSpeechPlayback playback = holder.playback;
      if (playback != null) playback.duck(duck);
      if (own != null) apply(own, new Event.Output(duck ? OutputNotice.DUCK_VOLUME : OutputNotice.RESTORE_VOLUME), null);
    }
    if (own != null && notices.contains(SpeechOutputGate.Notice.PAUSE_LISTENING) && !own.machine.state().focusPaused()) {
      if (own.machine.state().reply() != null) apply(own, new Event.CancelReply(), null);
      Step paused = apply(own, new Event.Output(OutputNotice.PAUSE_LISTENING), null);
      if (paused != null && paused.state().focusPaused()) emit(own, "focus-paused", new JSObject());
    }
    if (own != null && notices.contains(SpeechOutputGate.Notice.RESUME_LISTENING) && own.machine.state().focusPaused()) {
      Step resumed = apply(own, new Event.Output(OutputNotice.RESUME_LISTENING), null);
      if (resumed != null && !resumed.state().focusPaused()) emit(own, "focus-resumed", new JSObject());
    }
    if (notices.contains(SpeechOutputGate.Notice.PERMANENT_LOSS)) {
      listener = null;
      if (own != null && !call) deviceEnded(own, DeviceCause.FOCUS_UNAVAILABLE, AUDIO_FOCUS_LOST);
    }
    if (call && own != null) {
      listener = null;
      if (CloudSpeechPolicy.live(own.machine.state())) apply(own, new Event.Output(OutputNotice.STOP_CAPTURE), Why.code(SpeechAudioFocusPolicy.CALL_ACTIVE));
      else deviceEnded(own, DeviceCause.CALL_BEFORE_LIVE, SpeechAudioFocusPolicy.CALL_ACTIVE);
    }
  }

  /** One cancellable deadline per session: an accepted renewal moves it, and detach removes it. */
  private void arm(Session own) {
    main.removeCallbacks(own.expiry);
    if (!own.closed.get()) main.postDelayed(own.expiry, Math.max(1, own.expiresAt - System.currentTimeMillis()));
  }

  /** Main thread: startup did not finish in time, so the step the session is waiting on fails as unreachable. */
  private void timeout(Session own) {
    if (refuse(own, "startup-timeout", null)) return;
    Why why = Why.code("startup-timeout");
    Phase phase = own.machine.state().phase();
    if (phase instanceof Phase.AwaitingConsent) {
      if (!clock(own)) return;
      apply(own, new Event.ConsentGiven(), null);
      apply(own, new Event.Minted(CloudSpeechPolicy.UNREACHABLE), why);
    } else if (phase instanceof Phase.Minting) apply(own, new Event.Minted(CloudSpeechPolicy.UNREACHABLE), why);
    else apply(own, new Event.RelayLost(), why);
  }

  private void emit(Session own, String type, JSObject detail) {
    if (own.closed.get() || session != own) return;
    detail.put("sessionId", own.id);
    detail.put("type", type);
    notifyListeners("cloudSpeechEvent", detail);
  }

  private void mark(Session own, String stage) {
    markAt(own, stage, System.nanoTime(), null, 0);
  }

  private synchronized void markAt(Session own, String stage, long nanos, String clock, long utteranceStarted) {
    JSObject row = new JSObject();
    row.put("session", own.diagnosticId);
    row.put("stage", stage);
    row.put("elapsedMs", Math.max(0, (nanos - own.started) / 1_000_000));
    if (utteranceStarted > 0) row.put("utteranceElapsedMs", Math.max(0, (nanos - utteranceStarted) / 1_000_000));
    row.put("clock", StreamingSpeechPlayback.TIMESTAMP_CLOCK.equals(clock) || StreamingSpeechPlayback.HEAD_CLOCK.equals(clock) ? clock : "monotonic-observed");
    row.put("sentFrames", own.sentFrames);
    row.put("sentBytes", own.sentBytes);
    row.put("receivedFrames", own.receivedFrames);
    row.put("receivedBytes", own.receivedBytes);
    if (own.httpStatus != 0) row.put("httpStatus", own.httpStatus);
    timings.add(own.diagnosticId, stage, row);
  }

  private static void submit(Executor executor, Runnable action, Runnable rejected) {
    try {
      executor.execute(action);
    } catch (RejectedExecutionException stopped) {
      rejected.run();
    }
  }

  private final class Session {
    final String id, environment, credential;
    final long epoch, started = System.nanoTime(), diagnosticId;
    final PluginCall startCall;
    final CloudSpeechPolicy.Machine machine = new CloudSpeechPolicy.Machine();
    final AtomicBoolean closed = new AtomicBoolean(), startSettled = new AtomicBoolean();
    final AtomicLong muteGeneration = new AtomicLong(), feeding = new AtomicLong();
    final List<PluginCall> unmuteCalls = Collections.synchronizedList(new ArrayList<>());
    final ExecutorService feeder = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(FEED_TASKS), work -> {
      Thread thread = new Thread(work, "eliza-cloud-speech-feeder");
      thread.setDaemon(true);
      return thread;
    }, new ThreadPoolExecutor.AbortPolicy());
    final long startupStartedMs = SystemClock.elapsedRealtime();
    final Runnable deadline = this::expireStartup;
    final Runnable expiry = () -> apply(this, new Event.RelayLost(), Why.code("expired"));
    boolean begun, finished;
    volatile String origin, token, wireToken, serverId, address;
    volatile long expiresAt, sentFrames, sentBytes, receivedFrames, receivedBytes, askedAt, consentReported;
    volatile long startupEndsMs = startupStartedMs + HTTP_STARTUP_MS;
    volatile int httpStatus;
    volatile boolean muted, outputMuted, captured, extendOffered, revokeOwed, speakerDraining;
    volatile Call pending;
    volatile WebSocket socket;
    volatile Microphone microphone;
    final Object warming = new Object();
    boolean retired;
    final CountDownLatch ended = new CountDownLatch(1);
    volatile Utterance spoken;
    volatile StreamingSpeechPlayback lastPlayback;

    Session(String id, String environment, String credential, long epoch, PluginCall call, long diagnosticId) {
      this.id = id;
      this.environment = environment;
      this.credential = credential;
      this.epoch = epoch;
      this.startCall = call;
      this.diagnosticId = diagnosticId;
    }

    void scheduleStartupDeadline() {
      main.removeCallbacks(deadline);
      if (!closed.get()) main.postDelayed(deadline, Math.max(0, startupEndsMs - SystemClock.elapsedRealtime()));
      if (closed.get()) main.removeCallbacks(deadline);
    }

    /** The mint must finish on time; relay startup is then bounded by both its phase and the session's expiry. */
    synchronized boolean armRelayStartup() {
      long now = SystemClock.elapsedRealtime(), leaseMs = expiresAt - System.currentTimeMillis();
      if (now >= startupEndsMs || leaseMs <= 0) return false;
      startupEndsMs = Math.min(startupStartedMs + HTTP_STARTUP_MS + RELAY_STARTUP_MS, now + Math.min(RELAY_STARTUP_MS, leaseMs));
      scheduleStartupDeadline();
      return true;
    }

    void expireStartup() {
      if (closed.get() || startSettled.get()) return;
      if (SystemClock.elapsedRealtime() < startupEndsMs) scheduleStartupDeadline();
      else timeout(this);
    }

    void send(String value) throws IOException {
      WebSocket peer = socket;
      if (closed.get() || peer == null || peer.queueSize() > MAX_QUEUE || !peer.send(value)) throw new IOException("Speech transport unavailable");
    }

    void sendQuietly(String value) {
      try {
        send(value);
      } catch (IOException | RuntimeException unsent) {
      }
    }

    boolean sendPcm(byte[] pcm, int size) {
      WebSocket peer = socket;
      if (closed.get() || peer == null || peer.queueSize() > MAX_QUEUE || !peer.send(ByteString.of(pcm, 0, size))) return false;
      sentFrames++;
      sentBytes += size;
      return true;
    }
  }

  private static final class Utterance {
    final String id;
    final float pace;
    final long started = System.nanoTime();
    volatile boolean cancelled, streamComplete, announced;
    volatile long audible, receivedBytes, receivedMs, playedMs, offeredSamples;
    volatile String interrupted;
    volatile PluginCall cancelCall;
    volatile StreamingSpeechPlayback playback;

    Utterance(String id, float pace) {
      this.id = id;
      this.pace = pace;
    }

    long playedEstimateMs() {
      StreamingSpeechPlayback active = playback;
      if (active == null) return 0;
      long frames = Math.max(0, offeredSamples - active.pendingFrames());
      return frames * 1000 / RATE;
    }
  }

  @Override
  protected void handleOnResume() {
    foreground = true;
    super.handleOnResume();
  }

  /** A pending microphone request survives its own dialog's pause; a live session tells the renderer why it ended. */
  @Override
  protected void handleOnPause() {
    foreground = false;
    Session own = session;
    if (own != null) deviceEnded(own, DeviceCause.DEVICE_PAUSED, "paused");
    super.handleOnPause();
  }

  @Override
  protected void handleOnDestroy() {
    final PluginCall pending;
    final Session own;
    synchronized (this) {
      destroyed = true;
      pending = pendingStart;
      pendingStart = null;
      own = session;
    }
    if (pending != null) pending.reject("Voice stopped");
    if (own != null) deviceEnded(own, DeviceCause.DEVICE_PAUSED, "cancelled");
    control.shutdown();
    media.shutdown();
    http.dispatcher().executorService().shutdown();
    http.connectionPool().evictAll();
    main.post(() -> focus.close());
    super.handleOnDestroy();
  }
}
