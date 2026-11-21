// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/cloudSpeech.md, "Story: Transcribe a recording or hear a reply with one cloud request"
package ai.eliza.voice;

import ai.eliza.plugins.signin.CredentialJson;
import ai.eliza.plugins.signin.CredentialReader;
import ai.eliza.plugins.signin.DeviceCustody;
import ai.eliza.plugins.signin.SignInRegistration;
import ai.eliza.voice.CloudSpeechPolicy.Answer;
import ai.eliza.voice.CloudSpeechPolicy.Direction;
import ai.eliza.voice.CloudSpeechPolicy.Ending;
import ai.eliza.voice.CloudSpeechPolicy.Event;
import ai.eliza.voice.CloudSpeechPolicy.Failure;
import ai.eliza.voice.CloudSpeechPolicy.Frame;
import ai.eliza.voice.CloudSpeechPolicy.Notice;
import ai.eliza.voice.CloudSpeechPolicy.OutputNotice;
import ai.eliza.voice.CloudSpeechPolicy.Phase;
import ai.eliza.voice.CloudSpeechPolicy.SlotAnswer;
import ai.eliza.voice.CloudSpeechPolicy.SttKind;
import ai.eliza.voice.CloudSpeechPolicy.Verdict;
import ai.eliza.voice.CloudSpeechPolicy.Wait;
import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
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

@CapacitorPlugin(name = "ElizaCloudSpeech", permissions = @Permission(alias = "microphone", strings = Manifest.permission.RECORD_AUDIO))
public class CloudSpeechPlugin extends Plugin {
  public static final String NOT_CONFIGURED = "not-configured", UNKNOWN_ENVIRONMENT = "unknown-environment", INVALID_REQUEST = "invalid-request",
    SIGNED_OUT = "signed-out", ACCOUNT_CHANGED = "account-changed", BUSY = "voice-busy", NOT_CONSENTED = "not-consented", CANCELLED = "cancelled",
    PERMISSION_DENIED = "permission-denied", CLEANUP_UNCONFIRMED = "speech-cleanup-unconfirmed", PAUSED = "paused";

  private static final String TAG = "ElizaCloudSpeech";
  private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
  private static final long HTTP_STARTUP_MS = 12_000, RELAY_STARTUP_MS = 8_000, JOIN_MS = 1500;
  private static final int CAPTURE_FRAME = 1024, SILENCE_FRAMES = 30, MAX_REPLY_BYTES = 256 * 1024, MAX_AUDIO_BYTES = 8 * 1024 * 1024, FEED_TASKS = 1024;

  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService control = Executors.newSingleThreadExecutor();
  private final ExecutorService media = Executors.newSingleThreadExecutor();
  private final ExecutorService batches = Executors.newFixedThreadPool(2);
  private final OkHttpClient http = new OkHttpClient.Builder().protocols(List.of(Protocol.HTTP_1_1)).connectTimeout(8, TimeUnit.SECONDS)
    .readTimeout(120, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
  private final CloudSpeechTimings timings = new CloudSpeechTimings();
  private final Map<String, Binding> bindings = new HashMap<>();
  private final Map<Integer, Batch> waiting = new HashMap<>();
  private final Map<String, Integer> named = new HashMap<>();
  private SignInRegistration registration;
  private SpeechAudioFocus focus;
  private Session session;
  private boolean destroyed;
  private int requests;

  private final class Binding {
    final String environment, origin;
    final CredentialReader reader;
    final CloudSpeechPolicy.Machine machine = new CloudSpeechPolicy.Machine();
    final Runnable expiry = () -> sync(this);
    CredentialReader.Subscription subscription;

    Binding(String environment, String origin, CredentialReader reader) {
      this.environment = environment;
      this.origin = origin;
      this.reader = reader;
    }
  }

  private static final class Utterance {
    final String id;
    StreamingSpeechPlayback playback;
    long samples, sentMs;

    Utterance(String id) { this.id = id; }
  }

  private final class Session {
    final String id;
    final Binding binding;
    final PluginCall start;
    final ThreadPoolExecutor feeder = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(FEED_TASKS));
    final Runnable consentDeadline = this::consentExpired;
    final Runnable startupDeadline = this::startupExpired;
    final Runnable windowEnd = this::windowEnded;
    boolean resolved, extendOffered, outputMuted;
    volatile boolean revoked;
    String key, heard = "";
    CloudSpeechWire.Minted minted;
    volatile Call pending;
    volatile WebSocket socket;
    AlertDialog dialog;
    PluginCall unmuting;
    LiveCaptureResource capture;
    LiveCaptureResource.Source source;
    volatile AudioRecord recorder;
    AcousticEchoCanceler echo;
    Thread reader;
    Utterance spoken;
    int muteGeneration;

    Session(String id, Binding binding, PluginCall start) {
      this.id = id;
      this.binding = binding;
      this.start = start;
    }

    void consentExpired() {
      if (session == this) dispatch(binding, new Event.ConsentClock(CloudSpeechPolicy.CONSENT_DEADLINE_MS - waited(binding)));
    }

    void windowEnded() {
      if (session == this) dispatch(binding, new Event.RelayLost());
    }

    void startupExpired() {
      if (session != this) return;
      Phase p = binding.machine.state().phase();
      if (p instanceof Phase.Minting) {
        Call call = pending;
        if (call != null) call.cancel();
      } else if (!(p instanceof Phase.Live)) dispatch(binding, new Event.RelayLost());
    }

    void send(String text) throws IOException {
      WebSocket peer = socket;
      if (peer == null || peer.queueSize() > 64_000 || !peer.send(text)) throw new IOException("speech transport unavailable");
    }
  }

  private record Batch(String name, PluginCall call, Direction direction, CloudSpeechTimings.Record timing, Call[] connection, JSObject[] result) {}

  protected String signInPluginName() { return "ElizaSignIn"; }

  protected CredentialReader reader(Context context, String apiOrigin) { return DeviceCustody.reader(context, apiOrigin); }

  @Override public void load() {
    try {
      JSONObject signIn = getBridge().getConfig().getPluginConfiguration(signInPluginName()).getConfigJSON();
      registration = SignInRegistration.parse(CredentialJson.object(CredentialJson.parse(signIn.toString()), signInPluginName()));
    } catch (IllegalArgumentException refused) {
      Log.e(TAG, "The sign-in registration was refused, so cloud speech stays off", refused);
    }
    focus = new SpeechAudioFocus(getContext(), main, new SpeechOutputGate(), notices -> { for (SpeechOutputGate.Notice notice : notices) output(notice); });
    focus.watchCalls(main::post);
  }

  private Binding binding(String environment) {
    Binding known = bindings.get(environment);
    if (known != null) return known;
    SignInRegistration.Environment named = registration == null || environment == null ? null : registration.environment(environment);
    if (named == null || !CloudSpeechWire.origin(named.apiOrigin)) return null;
    Binding created = new Binding(environment, named.apiOrigin, reader(getContext(), named.apiOrigin));
    created.subscription = created.reader.listen(notice -> main.post(() -> sync(created)));
    bindings.put(environment, created);
    sync(created);
    return created;
  }

  private void sync(Binding b) {
    CredentialReader.Credential current = b.reader.current();
    main.removeCallbacks(b.expiry);
    if (current != null) main.postDelayed(b.expiry, Math.max(1, current.keyExpiresAt() - System.currentTimeMillis()));
    int version = current == null ? 0 : current.version();
    if (version != b.machine.state().credential()) dispatch(b, new Event.CredentialChanged(version));
  }

  private static long waited(Binding b) {
    return b.machine.state().phase() instanceof Phase.AwaitingConsent a ? a.waitedMs() : 0;
  }

  private CloudSpeechPolicy.Step dispatch(Binding b, Event event) {
    CloudSpeechPolicy.State before = b.machine.state();
    CloudSpeechPolicy.Step step = b.machine.apply(event);
    if (step == null) return null;
    for (Notice notice : step.out()) perform(b, notice);
    observe(b, before, step.state());
    return step;
  }

  private void perform(Binding b, Notice notice) {
    Session own = session != null && session.binding == b ? session : null;
    switch (notice) {
      case Notice.AskConsent x -> { if (own != null) askConsent(own); }
      case Notice.ReserveLiveCapture x -> { if (own != null) reserveCapture(own); }
      case Notice.ReleaseLiveCapture x -> { if (own != null) releaseCapture(own); }
      case Notice.RevokeSession x -> { if (own != null) revoke(own); }
      case Notice.CancelUtterance c -> { if (own != null) cancelUtterance(own, c.utteranceId()); }
      case Notice.ReportRefusedKey k -> b.reader.report401(k.version(), k.reason().tag);
      case Notice.SessionFailed f -> { if (own != null) failed(own, f); }
      case Notice.Heard h -> { if (own != null) emit(own, h.last() ? "speech-end" : "transcript", new JSObject().put("text", own.heard).put("final", h.last())); }
      case Notice.ReplySettled r -> { if (own != null) replySettled(own, r); }
      case Notice.BatchSettled s -> batchSettled(s);
    }
  }

  private void observe(Binding b, CloudSpeechPolicy.State before, CloudSpeechPolicy.State after) {
    Session own = session;
    if (own == null || own.binding != b) return;
    if (before.turn() == CloudSpeechPolicy.NO_TURN && CloudSpeechPolicy.ownedTurn(after)) emit(own, "speech-start", new JSObject());
    if (after.phase() instanceof Phase.Live && !own.resolved) {
      own.resolved = true;
      main.removeCallbacks(own.startupDeadline);
      own.start.resolve(new JSObject().put("sessionId", own.id).put("sampleRate", CloudSpeechWire.RATE).put("echoCancelled", AcousticEchoCanceler.isAvailable()));
    }
    if (after.phase() instanceof Phase.Closed closed) detach(own, closed.ending());
  }

  private static String code(Failure failure) {
    return failure.tag.replaceAll("(?<=[a-z])(?=[A-Z])", "-").toLowerCase(Locale.ROOT);
  }

  private static JSObject waitData(Wait wait) {
    JSObject data = new JSObject();
    switch (wait) {
      case Wait.NoWait x -> {}
      case Wait.RetryAt r -> data.put("retryAt", r.retryAtMs());
      case Wait.ResetsAt r -> data.put("resetsAt", r.resetsAtMs());
    }
    return data;
  }

  private void failed(Session own, Notice.SessionFailed f) {
    JSObject data = waitData(f.waitTime()).put("beforeAudio", f.beforeAudio());
    emit(own, "error", new JSObject().put("code", code(f.failure())).put("data", data));
    if (!own.resolved) {
      own.resolved = true;
      own.start.reject("Cloud speech is unavailable", code(f.failure()), data);
    }
  }

  private void detach(Session own, Ending ending) {
    session = null;
    main.removeCallbacks(own.consentDeadline);
    main.removeCallbacks(own.startupDeadline);
    main.removeCallbacks(own.windowEnd);
    if (own.dialog != null) own.dialog.dismiss();
    WebSocket socket = own.socket;
    if (socket != null) socket.close(1000, null);
    if (own.unmuting != null) own.unmuting.reject("Cloud speech ended", CANCELLED);
    own.unmuting = null;
    Utterance spoken = own.spoken;
    own.spoken = null;
    if (spoken != null && spoken.playback != null) spoken.playback.stop();
    own.feeder.shutdown();
    focus.cancelSpeech();
    submit(media, () -> stopRecorder(own));
    if (own.minted == null && own.pending == null) own.key = null;
    if (!own.resolved) {
      own.resolved = true;
      own.start.reject("Cloud speech ended", ending instanceof Ending.NotConsented ? NOT_CONSENTED : CANCELLED);
    }
  }

  private void emit(Session own, String type, JSObject detail) {
    if (session != own) return;
    notifyListeners("cloudSpeechEvent", detail.put("sessionId", own.id).put("type", type));
  }

  private static boolean submit(ExecutorService executor, Runnable work) {
    try {
      executor.execute(work);
      return true;
    } catch (RejectedExecutionException closed) {
      return false;
    }
  }

  private Session owned(PluginCall call) {
    Session own = session;
    return own != null && own.id.equals(call.getString("sessionId")) ? own : null;
  }

  private CredentialReader.Credential credential(Binding b, PluginCall call) {
    sync(b);
    CredentialReader.Credential current = b.reader.current();
    if (current == null) { call.reject("Sign in to use cloud speech", SIGNED_OUT); return null; }
    if (!current.credentialId().equals(call.getString("credentialId"))) { call.reject("The signed-in account changed", ACCOUNT_CHANGED); return null; }
    return current;
  }

  @PluginMethod public void startCloudSpeech(PluginCall call) {
    main.post(() -> {
      String id = call.getString("sessionId");
      try { UUID.fromString(id); } catch (RuntimeException invalid) { call.reject("Invalid speech session", INVALID_REQUEST); return; }
      if (destroyed || session != null) { call.reject("Voice is already active", BUSY); return; }
      if (registration == null) { call.reject("Cloud speech is not configured", NOT_CONFIGURED); return; }
      Binding b = binding(call.getString("environment"));
      if (b == null) { call.reject("Unknown cloud environment", UNKNOWN_ENVIRONMENT); return; }
      if (credential(b, call) == null) return;
      Session own = new Session(id, b, call);
      session = own;
      if (dispatch(b, new Event.Begin()) == null) {
        session = null;
        call.reject("Cloud speech could not start", BUSY);
      }
    });
  }

  private void askConsent(Session own) {
    if (own.binding.machine.state().phase() instanceof Phase.AwaitingConsent a && a.asks() == 1) main.postDelayed(own.consentDeadline, CloudSpeechPolicy.CONSENT_DEADLINE_MS);
    Activity activity = getActivity();
    if (activity == null || activity.isFinishing()) {
      main.post(() -> { if (session == own) dispatch(own.binding, new Event.Stop()); });
      return;
    }
    boolean[] answered = {false};
    own.dialog = new AlertDialog.Builder(activity)
      .setTitle("Talk through the cloud?")
      .setMessage("While you talk, your voice is sent to the cloud speech service of your account, and you are charged for the speech it hears and speaks.")
      .setPositiveButton("Allow", (dialog, which) -> { answered[0] = true; consentAnswered(own, true); })
      .setNegativeButton("Not now", (dialog, which) -> { answered[0] = true; consentAnswered(own, false); })
      .setOnDismissListener(dialog -> { if (!answered[0]) consentAnswered(own, false); })
      .create();
    own.dialog.show();
  }

  private void consentAnswered(Session own, boolean given) {
    own.dialog = null;
    if (session != own) return;
    if (!given) { dispatch(own.binding, new Event.ConsentDismissed()); return; }
    main.removeCallbacks(own.consentDeadline);
    CredentialReader.Credential current = own.binding.reader.current();
    if (current == null || current.version() != own.binding.machine.state().bound()) { sync(own.binding); return; }
    own.key = current.value();
    if (dispatch(own.binding, new Event.ConsentGiven()) == null) return;
    main.postDelayed(own.startupDeadline, HTTP_STARTUP_MS);
    if (!submit(control, () -> mint(own))) dispatch(own.binding, new Event.Minted(CloudSpeechPolicy.UNREACHABLE));
  }

  private record Reply(int status, String body, String retryAfter, String extend) {}

  private Reply post(Session own, String path, String json) throws IOException {
    String key = own.key;
    if (key == null || key.isEmpty() || key.indexOf('\r') >= 0 || key.indexOf('\n') >= 0) throw new IOException("no key");
    Call call = http.newCall(new Request.Builder().url(own.binding.origin + CloudSpeechWire.BASE + path).header("Authorization", "Bearer " + key)
      .post(RequestBody.create(json, JSON)).build());
    own.pending = call;
    try (Response response = call.execute()) {
      return new Reply(response.code(), new String(bounded(response.body(), 32_768), StandardCharsets.UTF_8), response.header("Retry-After"), response.header(CloudSpeechWire.EXTEND_HEADER));
    } finally {
      own.pending = null;
    }
  }

  private static byte[] bounded(ResponseBody body, int limit) throws IOException {
    if (body == null) throw new IOException("no body");
    try (InputStream in = body.byteStream()) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      for (int n; (n = in.read(chunk)) != -1; ) {
        if (out.size() + n > limit) throw new IOException("oversized reply");
        out.write(chunk, 0, n);
      }
      return out.toByteArray();
    }
  }

  private static Answer refused(Reply reply) {
    return new Answer.Refused(CloudSpeechWire.refusal(reply.status(), reply.body(), reply.retryAfter(), System.currentTimeMillis()));
  }

  private void mint(Session own) {
    Answer answer;
    CloudSpeechWire.Minted minted = null;
    try {
      Reply consent = post(own, "consent", "{}");
      if (consent.status() / 100 != 2) answer = refused(consent);
      else {
        String nonce = CloudSpeechWire.consentNonce(consent.body(), System.currentTimeMillis());
        if (own.revoked) throw new IOException("ended while minting");
        Reply made = post(own, "session", "{\"consentNonce\":" + CredentialJson.quote(nonce) + "}");
        if (made.status() / 100 != 2) answer = refused(made);
        else {
          minted = CloudSpeechWire.minted(made.body(), own.binding.origin, made.extend(), System.currentTimeMillis());
          answer = CloudSpeechPolicy.ANSWERED;
        }
      }
    } catch (IllegalArgumentException misdirected) {
      answer = CloudSpeechPolicy.MISDIRECTED;
    } catch (IOException unreachable) {
      answer = CloudSpeechPolicy.UNREACHABLE;
    }
    Answer settled = answer;
    CloudSpeechWire.Minted made = minted;
    main.post(() -> {
      own.minted = made;
      if (session != own || own.revoked) {
        revoke(own);
        own.key = null;
        return;
      }
      if (dispatch(own.binding, new Event.Minted(settled)) == null || !(own.binding.machine.state().phase() instanceof Phase.Connecting)) return;
      own.extendOffered = made.extendOffered();
      main.removeCallbacks(own.startupDeadline);
      main.postDelayed(own.startupDeadline, Math.max(1, Math.min(RELAY_STARTUP_MS, made.expiresAt() - System.currentTimeMillis())));
      armWindow(own, made.expiresAt());
      own.socket = http.newWebSocket(new Request.Builder().url(made.wsUrl()).build(), new Relay(own, made.token()));
    });
  }

  private void armWindow(Session own, long expiresAt) {
    main.removeCallbacks(own.windowEnd);
    main.postDelayed(own.windowEnd, Math.max(1, expiresAt - System.currentTimeMillis()));
  }

  private void revoke(Session own) {
    own.revoked = true;
    CloudSpeechWire.Minted made = own.minted;
    String key = own.key;
    if (made == null || key == null) return;
    own.minted = null;
    own.key = null;
    Request request = new Request.Builder().url(own.binding.origin + CloudSpeechWire.BASE + "session/" + made.sessionId() + "/revoke")
      .header("Authorization", "Bearer " + key).post(RequestBody.create("{}", JSON)).build();
    http.newCall(request).enqueue(new okhttp3.Callback() {
      @Override public void onFailure(Call call, IOException failure) { Log.w(TAG, "A speech session revoke was not answered; the session lapses at its window end"); }
      @Override public void onResponse(Call call, Response response) { response.close(); }
    });
  }

  private final class Relay extends WebSocketListener {
    final Session own;
    String token;

    Relay(Session own, String token) {
      this.own = own;
      this.token = token;
    }

    private void on(Runnable work) { main.post(() -> { if (session == own) work.run(); }); }

    @Override public void onOpen(WebSocket socket, Response response) {
      String hello = CloudSpeechWire.hello(token, own.extendOffered);
      token = null;
      if (!socket.send(hello)) on(() -> dispatch(own.binding, new Event.RelayLost()));
    }

    @Override public void onMessage(WebSocket socket, String text) {
      on(() -> {
        CloudSpeechWire.Relay frame;
        try {
          frame = CloudSpeechWire.relay(text);
        } catch (IllegalArgumentException invalid) {
          dispatch(own.binding, new Event.ProtocolEnd());
          return;
        }
        switch (frame) {
          case CloudSpeechWire.Relay.Unknown u -> dispatch(own.binding, new Event.ProtocolEnd());
          case CloudSpeechWire.Relay.Control c -> control(c);
        }
      });
    }

    private void control(CloudSpeechWire.Relay.Control c) {
      long now = System.currentTimeMillis();
      if (c.frame() instanceof Frame.Extended) {
        try {
          if (!own.extendOffered || own.minted == null) throw new IllegalArgumentException("unrequested renewal");
          long next = CloudSpeechWire.renewal(c.expiresAt(), own.minted.expiresAt(), now);
          own.minted = new CloudSpeechWire.Minted(own.minted.sessionId(), "", next, own.minted.wsUrl(), true);
        } catch (IllegalArgumentException invalid) {
          dispatch(own.binding, new Event.ProtocolEnd());
          return;
        }
      }
      if (c.frame() instanceof Frame.Stt) own.heard = c.transcript();
      Utterance spoken = own.spoken;
      if (dispatch(own.binding, new Event.FrameArrived(c.frame())) == null || session != own) return;
      if (c.frame() instanceof Frame.Extended && own.minted != null) armWindow(own, own.minted.expiresAt());
      if (c.frame() instanceof Frame.Complete done && spoken != null && spoken.id.equals(done.id())) feed(own, spoken, null);
    }

    @Override public void onMessage(WebSocket socket, ByteString bytes) {
      byte[] frame = bytes.toByteArray();
      on(() -> {
        CloudSpeechWire.Audio audio;
        try {
          audio = CloudSpeechWire.decode(frame);
        } catch (IllegalArgumentException invalid) {
          dispatch(own.binding, new Event.ProtocolEnd());
          return;
        }
        audioArrived(own, audio);
      });
    }

    @Override public void onClosing(WebSocket socket, int code, String reason) { on(() -> dispatch(own.binding, new Event.FrameArrived(new Frame.Close(code)))); }

    @Override public void onFailure(WebSocket socket, Throwable error, Response response) { on(() -> dispatch(own.binding, new Event.RelayLost())); }
  }

  @PluginMethod public void stopCloudSpeech(PluginCall call) {
    main.post(() -> {
      Session own = owned(call);
      if (own != null) dispatch(own.binding, new Event.Stop());
      call.resolve();
    });
  }

  @PluginMethod public void setCloudSpeechMuted(PluginCall call) {
    Boolean muted = call.getBoolean("muted");
    main.post(() -> {
      Session own = owned(call);
      if (own == null || muted == null) { call.reject("Speech session changed", INVALID_REQUEST); return; }
      if (muted) {
        if (own.binding.machine.state().capture() != CloudSpeechPolicy.Capture.MUTED) dispatch(own.binding, new Event.Mute());
        call.resolve();
        return;
      }
      if (own.binding.machine.state().capture() == CloudSpeechPolicy.Capture.LISTENING) { call.resolve(); return; }
      if (getPermissionState("microphone") != PermissionState.GRANTED) { requestPermissionForAlias("microphone", call, "microphoneAnswered"); return; }
      unmute(own, call);
    });
  }

  @PermissionCallback private void microphoneAnswered(PluginCall call) {
    main.post(() -> {
      Session own = owned(call);
      if (own == null) { call.reject("Speech session changed", INVALID_REQUEST); return; }
      if (getPermissionState("microphone") != PermissionState.GRANTED) { call.reject("Microphone permission denied", PERMISSION_DENIED); return; }
      unmute(own, call);
    });
  }

  private void unmute(Session own, PluginCall call) {
    boolean recordAudio = getPermissionState("microphone") == PermissionState.GRANTED;
    if (own.unmuting != null) { call.reject("The microphone is already opening", BUSY); return; }
    own.unmuting = call;
    if (dispatch(own.binding, new Event.Unmute(recordAudio)) == null) {
      own.unmuting = null;
      call.reject("The microphone cannot open now", recordAudio ? INVALID_REQUEST : PERMISSION_DENIED);
    }
  }

  private void reserveCapture(Session own) {
    int generation = ++own.muteGeneration;
    if (!submit(media, () -> openRecorder(own, generation))) dispatch(own.binding, new Event.CaptureAnswered(SlotAnswer.SLOT_BUSY));
  }

  private void openRecorder(Session own, int generation) {
    LiveCaptureResource resource = new LiveCaptureResource();
    SlotAnswer answer = SlotAnswer.NO_REFUSAL;
    try {
      resource.reserveMicrophone(false);
      int minimum = AudioRecord.getMinBufferSize(CloudSpeechWire.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
      boolean cancel = AcousticEchoCanceler.isAvailable();
      AudioRecord next = new AudioRecord.Builder()
        .setAudioSource(cancel ? MediaRecorder.AudioSource.VOICE_COMMUNICATION : MediaRecorder.AudioSource.VOICE_RECOGNITION)
        .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(CloudSpeechWire.RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
        .setBufferSizeInBytes(Math.max(minimum, 6400)).build();
      if (minimum <= 0 || next.getState() != AudioRecord.STATE_INITIALIZED) {
        next.release();
        throw new IOException("capture unavailable");
      }
      if (cancel) {
        own.echo = AcousticEchoCanceler.create(next.getAudioSessionId());
        if (own.echo != null) own.echo.setEnabled(true);
      }
      next.startRecording();
      if (next.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
        next.release();
        throw new IOException("capture unavailable");
      }
      LiveCaptureResource.Source source = new LiveCaptureResource.Source() {
        @Override public void requestStop() { next.stop(); }
        @Override public void close() { next.release(); }
      };
      if (!resource.attach(source)) {
        next.release();
        throw new IOException("capture fenced");
      }
      own.capture = resource;
      own.source = source;
      own.recorder = next;
      own.reader = new Thread(() -> pump(own, next), "eliza-cloud-speech-microphone");
      own.reader.setDaemon(true);
      own.reader.start();
    } catch (LocalMicrophoneLease.Refused refused) {
      answer = refused.refusal == LocalMicrophoneLease.Refusal.FENCED_REOPEN ? SlotAnswer.FENCED_REOPEN : SlotAnswer.SLOT_BUSY;
    } catch (IOException | RuntimeException failed) {
      resource.openFailed(true);
      answer = SlotAnswer.SLOT_BUSY;
    }
    SlotAnswer settled = answer;
    main.post(() -> {
      PluginCall waiting = own.unmuting;
      own.unmuting = null;
      boolean current = session == own && generation == own.muteGeneration;
      if (current) dispatch(own.binding, new Event.CaptureAnswered(settled));
      if (!current || settled != SlotAnswer.NO_REFUSAL) submit(media, () -> stopRecorder(own));
      if (waiting == null) return;
      if (current && settled == SlotAnswer.NO_REFUSAL) waiting.resolve();
      else waiting.reject("The microphone is in use", BUSY);
    });
  }

  private void pump(Session own, AudioRecord recorder) {
    byte[] frame = new byte[CAPTURE_FRAME];
    long levelAt = 0;
    try {
      while (own.recorder == recorder) {
        int count = recorder.read(frame, 0, frame.length, AudioRecord.READ_BLOCKING);
        if (own.recorder != recorder) return;
        if (count <= 0 || count % 2 != 0) throw new IOException("microphone stopped");
        long now = System.nanoTime();
        if (now - levelAt > 50_000_000L) {
          levelAt = now;
          double peak = CloudSpeechWire.peak(frame, count);
          main.post(() -> emit(own, "level", new JSObject().put("peak", peak)));
        }
        WebSocket peer = own.socket;
        if (peer == null || peer.queueSize() > 64_000 || !peer.send(ByteString.of(frame, 0, count))) throw new IOException("speech upload stalled");
      }
    } catch (IOException | RuntimeException failure) {
      if (own.recorder == recorder) main.post(() -> { if (session == own) dispatch(own.binding, new Event.Output(OutputNotice.STOP_CAPTURE)); });
    } finally {
      Arrays.fill(frame, (byte) 0);
    }
  }

  private void releaseCapture(Session own) {
    own.muteGeneration++;
    submit(media, () -> stopRecorder(own));
    silence(own, own.muteGeneration, SILENCE_FRAMES);
  }

  private void silence(Session own, int generation, int remaining) {
    if (remaining <= 0 || session != own || own.muteGeneration != generation) return;
    WebSocket peer = own.socket;
    if (peer == null || peer.queueSize() > 64_000 || !peer.send(ByteString.of(new byte[CAPTURE_FRAME]))) return;
    main.postDelayed(() -> silence(own, generation, remaining - 1), 32);
  }

  private void stopRecorder(Session own) {
    AudioRecord recorder = own.recorder;
    own.recorder = null;
    Thread reader = own.reader;
    own.reader = null;
    LiveCaptureResource capture = own.capture;
    LiveCaptureResource.Source source = own.source;
    own.capture = null;
    own.source = null;
    if (capture != null) capture.requestStop();
    if (reader != null && reader != Thread.currentThread()) {
      try {
        reader.join(JOIN_MS);
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      }
    }
    if (own.echo != null) {
      own.echo.release();
      own.echo = null;
    }
    if (capture != null && source != null && !capture.release(source)) Log.w(TAG, "The microphone slot did not confirm its release");
  }

  @PluginMethod public void setCloudSpeechOutputMuted(PluginCall call) {
    Boolean muted = call.getBoolean("muted");
    main.post(() -> {
      Session own = owned(call);
      if (own == null || muted == null) { call.reject("Speech session changed", INVALID_REQUEST); return; }
      own.outputMuted = muted;
      Utterance spoken = own.spoken;
      if (spoken != null && spoken.playback != null) spoken.playback.setOutputMuted(muted);
      call.resolve();
    });
  }

  @PluginMethod public void speakCloudSpeech(PluginCall call) {
    String id = call.getString("utteranceId"), text = call.getString("text");
    int pace = call.getInt("pace", 100);
    main.post(() -> {
      Session own = owned(call);
      List<String> phrases;
      try {
        phrases = CloudSpeechWire.phrases(text);
      } catch (IllegalArgumentException invalid) {
        call.reject("Invalid speech request", INVALID_REQUEST);
        return;
      }
      if (own == null || !CloudSpeechWire.id(id) || dispatch(own.binding, new Event.Speak(id, pace)) == null) { call.reject("Invalid speech request", INVALID_REQUEST); return; }
      String refused = focus.startSpeech();
      if (refused != null) {
        dispatch(own.binding, new Event.Output(SpeechAudioFocusPolicy.CALL_ACTIVE.equals(refused) ? OutputNotice.REFUSED_CALL_ACTIVE : OutputNotice.REFUSED_FOCUS_DENIED));
        call.reject("Speech could not start", refused);
        return;
      }
      own.spoken = new Utterance(id);
      try {
        for (String phrase : phrases) own.send(CloudSpeechWire.tts(id, phrase));
        own.send(CloudSpeechWire.utterance("finish", id));
        call.resolve();
      } catch (IOException unavailable) {
        call.reject("Speech could not start", INVALID_REQUEST);
        dispatch(own.binding, new Event.RelayLost());
      }
    });
  }

  private void audioArrived(Session own, CloudSpeechWire.Audio audio) {
    Utterance u = own.spoken;
    long ms = 0;
    if (u != null && u.id.equals(audio.id())) {
      long total = CloudSpeechWire.playedMs(u.samples + audio.pcm().length / 2);
      ms = total - CloudSpeechWire.playedMs(u.samples);
    }
    if (ms > 0 && dispatch(own.binding, new Event.AudioArrived(audio.id(), ms)) == null) return;
    if (u == null || own.spoken != u || !u.id.equals(audio.id())) return;
    u.samples += audio.pcm().length / 2;
    if (u.playback == null) {
      u.playback = new StreamingSpeechPlayback(CloudSpeechWire.RATE * 5, CloudSpeechWire.RATE, 0.005f, () -> AudioTrackSpeechOutput.open(CloudSpeechWire.RATE),
        new StreamingSpeechPlayback.Listener() {
          @Override public void firstFrame(long nanos) { main.post(() -> emit(own, "audio-start", new JSObject().put("utteranceId", u.id))); }
          @Override public void audible(long nanos, String clock) {}
          @Override public void ended(boolean silent) {}
          @Override public void failed(String reason) { main.post(() -> { if (session == own && own.spoken == u) dispatch(own.binding, new Event.Output(OutputNotice.STOP_CAPTURE)); }); }
        }, System::nanoTime);
      u.playback.setOutputMuted(own.outputMuted);
      u.playback.start();
    }
    long chunkMs = ms;
    feed(own, u, audio.pcm());
    if (chunkMs > 0) u.playback.mark((nanos, buffered) -> main.post(() -> {
      if (session == own && own.spoken == u) dispatch(own.binding, new Event.Played(chunkMs));
    }));
  }

  private void feed(Session own, Utterance u, byte[] pcm) {
    try {
      own.feeder.execute(() -> {
        float[] samples = pcm == null ? null : CloudSpeechWire.floats(pcm);
        try {
          if (u.playback == null || u.playback.stopped()) return;
          if (!u.playback.offer(samples, pcm == null) && !u.playback.stopped()) main.post(() -> { if (session == own && own.spoken == u) dispatch(own.binding, new Event.Output(OutputNotice.STOP_CAPTURE)); });
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
        } finally {
          if (pcm != null) Arrays.fill(pcm, (byte) 0);
        }
      });
    } catch (RejectedExecutionException full) {
      if (session == own) dispatch(own.binding, new Event.Output(OutputNotice.STOP_CAPTURE));
    }
  }

  private void output(SpeechOutputGate.Notice notice) {
    Session own = session;
    if (own == null) return;
    Utterance spoken = own.spoken;
    switch (notice) {
      case DUCK_VOLUME, RESTORE_VOLUME -> { if (spoken != null && spoken.playback != null) spoken.playback.duck(notice == SpeechOutputGate.Notice.DUCK_VOLUME); }
      case STOP_PLAYBACK -> { if (spoken != null) dispatch(own.binding, new Event.CancelReply()); }
      case STOP_CAPTURE -> dispatch(own.binding, new Event.Output(OutputNotice.STOP_CAPTURE));
      case REFUSED_CALL_ACTIVE -> dispatch(own.binding, new Event.Output(OutputNotice.REFUSED_CALL_ACTIVE));
      case REFUSED_FOCUS_DENIED -> dispatch(own.binding, new Event.Output(OutputNotice.REFUSED_FOCUS_DENIED));
      case ABANDON_FOCUS -> {}
    }
  }

  private void cancelUtterance(Session own, String id) {
    Utterance u = own.spoken;
    if (u == null || !u.id.equals(id)) return;
    if (u.playback != null) u.playback.stop();
    try {
      own.send(CloudSpeechWire.utterance("cancel", id));
    } catch (IOException closed) {
      Log.w(TAG, "The relay was gone when a reply was cancelled");
    }
  }

  private void replySettled(Session own, Notice.ReplySettled settled) {
    Utterance u = own.spoken;
    if (u != null && u.id.equals(settled.utteranceId())) own.spoken = null;
    if (settled.completed()) focus.endSpeech();
    else focus.cancelSpeech();
    emit(own, "audio-end", new JSObject().put("utteranceId", settled.utteranceId()).put("completed", settled.completed()));
  }

  @PluginMethod public void cancelCloudSpeech(PluginCall call) {
    main.post(() -> {
      Session own = owned(call);
      Utterance u = own == null ? null : own.spoken;
      if (u == null || !u.id.equals(call.getString("utteranceId"))) { call.resolve(); return; }
      dispatch(own.binding, new Event.CancelReply());
      StreamingSpeechPlayback playback = u.playback;
      if (playback == null) { call.resolve(); return; }
      if (!submit(media, () -> {
        try {
          if (playback.join(JOIN_MS)) call.resolve();
          else call.reject("Speech cleanup was not confirmed", CLEANUP_UNCONFIRMED);
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          call.reject("Speech cleanup was not confirmed", CLEANUP_UNCONFIRMED);
        }
      })) call.reject("Speech cleanup was not confirmed", CLEANUP_UNCONFIRMED);
    });
  }

  @PluginMethod public void transcribe(PluginCall call) {
    String audio = call.getString("audio"), mime = call.getString("mimeType", "audio/wav");
    byte[] bytes;
    try {
      bytes = Base64.getDecoder().decode(audio == null ? "" : audio);
    } catch (IllegalArgumentException invalid) {
      bytes = new byte[0];
    }
    if (bytes.length == 0 || bytes.length > MAX_AUDIO_BYTES || mime == null || !mime.matches("audio/[a-z0-9.+-]{1,32}")) { call.reject("Invalid recording", INVALID_REQUEST); return; }
    byte[] recording = bytes;
    batch(call, Direction.TRANSCRIBE, () -> new MultipartBody.Builder().setType(MultipartBody.FORM)
      .addFormDataPart("audio", "recording", RequestBody.create(recording, MediaType.get(mime))).build(), "stt");
  }

  @PluginMethod public void synthesize(PluginCall call) {
    String text = call.getString("text");
    int pace = call.getInt("pace", 100);
    if (text == null || text.isBlank() || text.length() > CloudSpeechWire.MAX_SYNTHESIS_TEXT || pace < CloudSpeechPolicy.MIN_PACE || pace > CloudSpeechPolicy.MAX_PACE) {
      call.reject("Invalid speech request", INVALID_REQUEST);
      return;
    }
    String body = "{\"text\":" + CredentialJson.quote(text) + ",\"format\":\"mp3\"" + (pace == 100 ? "" : ",\"speed\":" + pace / 100.0) + "}";
    batch(call, Direction.SYNTHESIZE, () -> RequestBody.create(body, JSON), "tts");
  }

  private interface Body { RequestBody get(); }

  private void batch(PluginCall call, Direction direction, Body body, String route) {
    main.post(() -> {
      if (registration == null) { call.reject("Cloud speech is not configured", NOT_CONFIGURED); return; }
      Binding b = binding(call.getString("environment"));
      if (b == null) { call.reject("Unknown cloud environment", UNKNOWN_ENVIRONMENT); return; }
      String name = call.getString("requestId");
      if (!CloudSpeechWire.id(name) || named.containsKey(name)) { call.reject("Invalid speech request", INVALID_REQUEST); return; }
      CredentialReader.Credential key = credential(b, call);
      if (key == null) return;
      int id = ++requests;
      Batch request = new Batch(name, call, direction, timings.begin(direction == Direction.TRANSCRIBE ? CloudSpeechTimings.Route.STT : CloudSpeechTimings.Route.TTS), new Call[1], new JSObject[1]);
      if (dispatch(b, new Event.BatchRequested(id, direction)) == null) { call.reject("Sign in to use cloud speech", SIGNED_OUT); return; }
      waiting.put(id, request);
      named.put(name, id);
      if (!submit(batches, () -> send(b, id, request, key.value(), body, route))) answered(b, id, CloudSpeechPolicy.UNREACHABLE);
    });
  }

  private void send(Binding b, int id, Batch request, String key, Body body, String route) {
    Answer answer;
    timings.mark(request.timing(), "worker-start");
    try {
      timings.mark(request.timing(), "upload-start");
      Call call = http.newCall(new Request.Builder().url(b.origin + "/api/v1/voice/" + route).header("Authorization", "Bearer " + key).post(body.get()).build());
      request.connection()[0] = call;
      try (Response response = call.execute()) {
        timings.mark(request.timing(), "upload-end");
        timings.mark(request.timing(), "headers");
        String provider = response.header(request.direction() == Direction.TRANSCRIBE ? "X-Eliza-STT-Provider" : "X-Eliza-TTS-Provider");
        timings.response(request.timing(), response.code(), provider, response.header("Server-Timing"), response.header("X-Eliza-TTS-Moderation"));
        if (!response.isSuccessful()) {
          String refusal = new String(bounded(response.body(), 32_768), StandardCharsets.UTF_8);
          answer = new Answer.Refused(CloudSpeechWire.refusal(response.code(), refusal, response.header("Retry-After"), System.currentTimeMillis()));
        } else if (request.direction() == Direction.TRANSCRIBE) {
          Map<String, Object> heard = CredentialJson.object(CredentialJson.parse(new String(bounded(response.body(), MAX_REPLY_BYTES), StandardCharsets.UTF_8)), "transcript");
          request.result()[0] = new JSObject().put("text", CredentialJson.text(heard, "transcript"));
          answer = CloudSpeechPolicy.ANSWERED;
        } else {
          String type = response.header("Content-Type", "");
          String mime = type.split(";")[0].trim().toLowerCase(Locale.ROOT);
          if (!mime.equals("audio/mpeg") && !mime.equals("audio/wav")) throw new IllegalArgumentException("speech type");
          byte[] audio = bounded(response.body(), MAX_AUDIO_BYTES);
          if (audio.length == 0) throw new IllegalArgumentException("empty speech");
          request.result()[0] = new JSObject().put("audio", Base64.getEncoder().encodeToString(audio)).put("mimeType", mime);
          answer = CloudSpeechPolicy.ANSWERED;
        }
        timings.mark(request.timing(), "body-end");
      }
    } catch (IllegalArgumentException misdirected) {
      answer = CloudSpeechPolicy.MISDIRECTED;
    } catch (IOException unreachable) {
      answer = CloudSpeechPolicy.UNREACHABLE;
    }
    Answer settled = answer;
    main.post(() -> answered(b, id, settled));
  }

  private void answered(Binding b, int id, Answer answer) {
    dispatch(b, new Event.BatchAnswered(id, answer));
  }

  private void batchSettled(Notice.BatchSettled settled) {
    Batch request = waiting.remove(settled.requestId());
    if (request == null) return;
    named.remove(request.name());
    Call call = request.connection()[0];
    switch (settled.verdict()) {
      case Verdict.Done d -> {
        timings.finish(request.timing(), "completed");
        request.call().resolve(request.result()[0]);
      }
      case Verdict.Cancelled c -> {
        if (call != null) call.cancel();
        timings.finish(request.timing(), "cancelled");
        request.call().reject("Speech request cancelled", CANCELLED);
      }
      case Verdict.Failed f -> {
        if (call != null) call.cancel();
        timings.finish(request.timing(), "failed");
        request.call().reject("Cloud speech is unavailable", code(f.failure()), waitData(f.waitTime()));
      }
      case Verdict.Pending p -> {
        waiting.put(settled.requestId(), request);
        named.put(request.name(), settled.requestId());
      }
    }
  }

  @PluginMethod public void cancelSpeechRequest(PluginCall call) {
    String name = call.getString("requestId");
    main.post(() -> {
      Integer id = name == null ? null : named.get(name);
      if (id != null) for (Binding b : bindings.values()) dispatch(b, new Event.BatchCancelled(id));
      call.resolve();
    });
  }

  @PluginMethod public void speechTiming(PluginCall call) {
    try {
      call.resolve(JSObject.fromJSONObject(new JSONObject(timings.snapshot())));
    } catch (org.json.JSONException unreadable) {
      call.reject("Speech timing unavailable", INVALID_REQUEST);
    }
  }

  @Override protected void handleOnPause() {
    main.post(() -> {
      Session own = session;
      if (own == null || own.dialog != null) return;
      emit(own, "error", new JSObject().put("code", PAUSED));
      dispatch(own.binding, new Event.Stop());
    });
    super.handleOnPause();
  }

  @Override protected void handleOnDestroy() {
    main.post(() -> {
      destroyed = true;
      Session own = session;
      if (own != null) dispatch(own.binding, new Event.Stop());
      for (Binding b : bindings.values()) {
        main.removeCallbacks(b.expiry);
        b.subscription.close();
      }
      bindings.clear();
      focus.close();
      control.shutdown();
      media.shutdown();
      batches.shutdownNow();
      http.dispatcher().executorService().shutdown();
    });
    super.handleOnDestroy();
  }
}
