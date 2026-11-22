// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/cloudSpeech.md, "Story: Transcribe a recording or hear a reply with one cloud request"
package ai.eliza.voice;

import java.util.ArrayList;
import java.util.List;

public final class CloudSpeechPolicy {
  private CloudSpeechPolicy() {}

  public static final long CONSENT_DEADLINE_MS = 30_000;
  public static final int MIN_PACE = 50, MAX_PACE = 200;

  public enum Failure {
    NO_FAILURE("NoFailure"), CAPABILITY_UNAVAILABLE("CapabilityUnavailable"), ACCOUNT_INELIGIBLE("AccountIneligible"),
    REMOTE_UNREACHABLE("RemoteUnreachable"), REQUEST_FAILED("RequestFailed");
    public final String tag;
    Failure(String tag) { this.tag = tag; }
  }

  public enum Capture {
    MUTED("Muted"), RESERVING("Reserving"), LISTENING("Listening");
    public final String tag;
    Capture(String tag) { this.tag = tag; }
  }

  public enum Direction {
    TRANSCRIBE("Transcribe"), SYNTHESIZE("Synthesize");
    public final String tag;
    Direction(String tag) { this.tag = tag; }
  }

  public enum SlotAnswer { NO_REFUSAL, SLOT_BUSY, FENCED_REOPEN }

  public enum DeviceCause {
    NO_DEVICE_CAUSE("NoDeviceCause"), DEVICE_PAUSED("DevicePaused"), PLAYBACK_STUCK("PlaybackStuck"),
    MICROPHONE_LOST("MicrophoneLost"), CALL_BEFORE_LIVE("CallBeforeLive");
    public final String tag;
    DeviceCause(String tag) { this.tag = tag; }
  }

  public enum OutputNotice { FIRST_AUDIO, REFUSED_CALL_ACTIVE, REFUSED_FOCUS_DENIED, STOP_PLAYBACK, ABANDON_FOCUS, DUCK_VOLUME, RESTORE_VOLUME, STOP_CAPTURE }

  public enum SttKind { CONNECTED, START_OF_TURN, TURN_RESUMED, END_OF_TURN, TRANSCRIPT_UPDATE, EAGER_END_OF_TURN }

  public enum RelayErrorCode { UNAUTHORIZED, PROTOCOL, UNAVAILABLE, CLOSED }

  public enum RefusalReason {
    NO_REASON("NoReason"), GRANT_REQUIRED("GrantRequired"), UNSUPPORTED_FIELD("UnsupportedField"), CREDENTIAL_EXPIRED("CredentialExpired"),
    CREDENTIAL_REVOKED("CredentialRevoked"), CREDENTIAL_UNKNOWN("CredentialUnknown"), CHALLENGE_LOCKED("ChallengeLocked"),
    GOOGLE_ACCOUNT_CHANGED("GoogleAccountChanged"), ACCOUNT_INACTIVE("AccountInactive"), CAPABILITY_MISSING("CapabilityMissing"),
    GOOGLE_NOT_CONFIGURED("GoogleNotConfigured");
    public final String tag;
    RefusalReason(String tag) { this.tag = tag; }
    public boolean credential() { return this == CREDENTIAL_EXPIRED || this == CREDENTIAL_REVOKED || this == CREDENTIAL_UNKNOWN; }
    public String wire() { return snake(tag); }
  }

  public enum RefusalCode {
    INVALID_REQUEST("InvalidRequest", 400), MODEL_UNAVAILABLE("ModelUnavailable", 400), INVALID_CLIENT("InvalidClient", 400),
    REDIRECT_MISMATCH("RedirectMismatch", 400), GRANT_CODE_INVALID("GrantCodeInvalid", 400), AUTHENTICATION_REQUIRED("AuthenticationRequired", 401),
    CREDENTIAL_PROOF_INVALID("CredentialProofInvalid", 401), INSUFFICIENT_CREDITS("InsufficientCredits", 402), ALLOWANCE_EXHAUSTED("AllowanceExhausted", 402),
    ACCESS_DENIED("AccessDenied", 403), CLIENT_DISABLED("ClientDisabled", 403), SPEECH_CONSENT_REQUIRED("SpeechConsentRequired", 403),
    NOT_FOUND("NotFound", 404), CAPABILITY_UNAVAILABLE("CapabilityUnavailable", 404), IDEMPOTENCY_CONFLICT("IdempotencyConflict", 409),
    STALE_REVISION("StaleRevision", 409), BILLING_STATE_CONFLICT("BillingStateConflict", 409), IDENTITY_IN_USE("IdentityInUse", 409),
    LAST_METHOD("LastMethod", 409), GOOGLE_REAUTH_REQUIRED("GoogleReauthRequired", 409), SUBSCRIPTION_GRANT_ALREADY_REDEEMED("SubscriptionGrantAlreadyRedeemed", 409),
    SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE("SubscriptionGrantPaidPlanActive", 409), REFERRAL_ALREADY_APPLIED("ReferralAlreadyApplied", 409),
    SESSION_CLOSED("SessionClosed", 410), PRECONDITION_FAILED("PreconditionFailed", 412), CONTENT_TOO_LARGE("ContentTooLarge", 413),
    NO_ROUTE("NoRoute", 422), UNSUPPORTED_MODE("UnsupportedMode", 422), UNSUPPORTED_REGION("UnsupportedRegion", 422),
    FRESH_SESSION_REQUIRED("FreshSessionRequired", 428), RATE_LIMITED("RateLimited", 429), PROVIDER_INVALID_RESPONSE("ProviderInvalidResponse", 502),
    SERVICE_UNAVAILABLE("ServiceUnavailable", 503), PROVIDER_UNAVAILABLE("ProviderUnavailable", 503), RATE_LIMIT_UNAVAILABLE("RateLimitUnavailable", 503);
    public final String tag;
    public final int status;
    RefusalCode(String tag, int status) { this.tag = tag; this.status = status; }
    public String wire() { return snake(tag); }
  }

  static String snake(String tag) { return tag.replaceAll("(?<=[a-z0-9])(?=[A-Z])", "_").toLowerCase(java.util.Locale.ROOT); }

  public sealed interface Wait {
    record NoWait() implements Wait {}
    record RetryAt(long retryAtMs) implements Wait {}
    record ResetsAt(long resetsAtMs) implements Wait {}
  }

  public static final Wait NO_WAIT = new Wait.NoWait();

  public record Refusal(RefusalCode code, RefusalReason reason, Wait waitTime) {}

  public sealed interface Answer {
    record Answered() implements Answer {}
    record Misdirected() implements Answer {}
    record Unreachable() implements Answer {}
    record Refused(Refusal refusal) implements Answer {}
  }

  public static final Answer ANSWERED = new Answer.Answered(), MISDIRECTED = new Answer.Misdirected(), UNREACHABLE = new Answer.Unreachable();

  public sealed interface Frame {
    record Ready() implements Frame {}
    record Extended() implements Frame {}
    record Stt(SttKind kind) implements Frame {}
    record Prepared(String id) implements Frame {}
    record Audio(String id) implements Frame {}
    record Flushed(String id) implements Frame {}
    record Complete(String id) implements Frame {}
    record Error(RelayErrorCode code, boolean funding) implements Frame {}
    record Close(int closeCode) implements Frame {}
  }

  public sealed interface Ending {
    record Stopped() implements Ending {}
    record NotConsented() implements Ending {}
    record FailedBeforeAudio(Failure failure) implements Ending {}
    record FailedAfterAudio(Failure failure) implements Ending {}
  }

  public sealed interface Phase {
    record Idle() implements Phase {}
    record AwaitingConsent(int asks, long waitedMs) implements Phase {}
    record Minting() implements Phase {}
    record Connecting() implements Phase {}
    record Ready() implements Phase {}
    record Live() implements Phase {}
    record Closed(Ending ending) implements Phase {}
  }

  public static final Phase IDLE = new Phase.Idle(), MINTING = new Phase.Minting(), CONNECTING = new Phase.Connecting(),
    READY = new Phase.Ready(), LIVE = new Phase.Live();

  public record Playing(String utteranceId, int pace, long receivedMs, long playedMs, boolean completed) {}

  public sealed interface Verdict {
    record Pending() implements Verdict {}
    record Done() implements Verdict {}
    record Cancelled() implements Verdict {}
    record Failed(Failure failure, Wait waitTime) implements Verdict {}
  }

  public static final Verdict PENDING = new Verdict.Pending(), DONE = new Verdict.Done(), CANCELLED = new Verdict.Cancelled();

  public record Batch(int requestId, Direction direction, int version, Verdict verdict) {}

  public record State(int credential, int bound, Phase phase, boolean audioStarted, Capture capture,
                      int generation, int turn, Playing reply, List<Batch> batches, DeviceCause endedBy) {
    public State { batches = List.copyOf(batches); }
    State phase(Phase p) { return new State(credential, bound, p, audioStarted, capture, generation, turn, reply, batches, endedBy); }
    State capture(Capture c) { return new State(credential, bound, phase, audioStarted, c, generation, turn, reply, batches, endedBy); }
    State turn(int t) { return new State(credential, bound, phase, audioStarted, capture, generation, t, reply, batches, endedBy); }
    State reply(Playing r) { return new State(credential, bound, phase, audioStarted, capture, generation, turn, r, batches, endedBy); }
    State batches(List<Batch> b) { return new State(credential, bound, phase, audioStarted, capture, generation, turn, reply, b, endedBy); }
    State endedBy(DeviceCause c) { return new State(credential, bound, phase, audioStarted, capture, generation, turn, reply, batches, c); }
    State heard() { return new State(credential, bound, phase, true, capture, generation, turn, reply, batches, endedBy); }
  }

  public static final int NO_TURN = -1;
  public static final State INITIAL = new State(0, 0, IDLE, false, Capture.MUTED, 0, NO_TURN, null, List.of(), DeviceCause.NO_DEVICE_CAUSE);

  public sealed interface Notice {
    record AskConsent() implements Notice {}
    record ReserveLiveCapture() implements Notice {}
    record ReleaseLiveCapture() implements Notice {}
    record RevokeSession() implements Notice {}
    record CancelUtterance(String utteranceId) implements Notice {}
    record ReportRefusedKey(int version, RefusalReason reason) implements Notice {}
    record SessionFailed(Failure failure, boolean beforeAudio, Wait waitTime) implements Notice {}
    record Heard(boolean last, int capture) implements Notice {}
    record ReplySettled(String utteranceId, boolean completed) implements Notice {}
    record BatchSettled(int requestId, Verdict verdict) implements Notice {}
  }

  public sealed interface Event {
    record ConsentClock(long waitMs) implements Event {}
    record ConsentGiven() implements Event {}
    record QuietStep() implements Event {}
    record Begin() implements Event {}
    record ConsentDismissed() implements Event {}
    record CredentialChanged(int version) implements Event {}
    record Minted(Answer answer) implements Event {}
    record RelayLost() implements Event {}
    record FrameArrived(Frame frame) implements Event {}
    record Unmute(boolean recordAudio) implements Event {}
    record Mute() implements Event {}
    record CaptureAnswered(SlotAnswer slot) implements Event {}
    record Speak(String utteranceId, int pace) implements Event {}
    record AudioArrived(String utteranceId, long audioMs) implements Event {}
    record Played(long playedMs) implements Event {}
    record CancelReply() implements Event {}
    record Output(OutputNotice notice) implements Event {}
    record Stop() implements Event {}
    record DeviceEnded(DeviceCause cause) implements Event {}
    record BatchRequested(int requestId, Direction direction) implements Event {}
    record BatchCancelled(int requestId) implements Event {}
    record BatchAnswered(int requestId, Answer answer) implements Event {}
  }

  public record Step(State state, List<Notice> out) {
    public Step { out = List.copyOf(out); }
  }

  static Step quiet(State s) { return new Step(s, List.of()); }

  static boolean isOpen(Phase p) { return !(p instanceof Phase.Idle) && !(p instanceof Phase.Closed); }
  static int asks(Phase p) { return p instanceof Phase.AwaitingConsent a ? a.asks() : 0; }
  static long waited(Phase p) { return p instanceof Phase.AwaitingConsent a ? a.waitedMs() : 0; }
  static boolean minted(Phase p) { return p instanceof Phase.Connecting || p instanceof Phase.Ready || p instanceof Phase.Live; }
  static boolean revokeOwed(Phase p) { return p instanceof Phase.Minting || minted(p); }
  public static boolean live(State s) { return s.phase() instanceof Phase.Live; }
  public static boolean ended(State s) { return s.phase() instanceof Phase.Closed; }
  static boolean pending(State s, int id) {
    for (Batch b : s.batches()) if (b.requestId() == id && b.verdict() instanceof Verdict.Pending) return true;
    return false;
  }
  public static boolean ownedTurn(State s) { return s.turn() >= 1 && s.turn() == s.generation(); }

  static Failure refusalFailure(RefusalCode code) {
    int status = code.status;
    if (status == 401 || status == 402 || status == 403) return Failure.ACCOUNT_INELIGIBLE;
    if (status == 404) return Failure.CAPABILITY_UNAVAILABLE;
    if (status == 503) return Failure.REMOTE_UNREACHABLE;
    return Failure.REQUEST_FAILED;
  }

  static Failure failureOf(Answer a) {
    return switch (a) {
      case Answer.Answered x -> Failure.NO_FAILURE;
      case Answer.Misdirected x -> Failure.REQUEST_FAILED;
      case Answer.Unreachable x -> Failure.REMOTE_UNREACHABLE;
      case Answer.Refused r -> refusalFailure(r.refusal().code());
    };
  }

  static Wait waitOf(Answer a) { return a instanceof Answer.Refused r ? r.refusal().waitTime() : NO_WAIT; }

  static List<Notice> keyReport(Answer a, int version) {
    if (a instanceof Answer.Refused r && r.refusal().code() == RefusalCode.AUTHENTICATION_REQUIRED && r.refusal().reason().credential())
      return List.of(new Notice.ReportRefusedKey(version, r.refusal().reason()));
    return List.of();
  }

  static Verdict verdictOf(Answer a) { return a instanceof Answer.Answered ? DONE : new Verdict.Failed(failureOf(a), waitOf(a)); }

  static Step closeWith(Ending ending, State s, List<Notice> first, Wait wait) {
    Failure failure = switch (ending) {
      case Ending.FailedBeforeAudio f -> f.failure();
      case Ending.FailedAfterAudio f -> f.failure();
      default -> Failure.NO_FAILURE;
    };
    List<Notice> out = new ArrayList<>(first);
    if (s.capture() != Capture.MUTED) out.add(new Notice.ReleaseLiveCapture());
    if (s.reply() != null) out.add(new Notice.ReplySettled(s.reply().utteranceId(), false));
    if (revokeOwed(s.phase())) out.add(new Notice.RevokeSession());
    if (failure != Failure.NO_FAILURE) out.add(new Notice.SessionFailed(failure, !s.audioStarted(), wait));
    State closed = new State(s.credential(), s.bound(), new Phase.Closed(ending), s.audioStarted(), Capture.MUTED, s.generation(), NO_TURN, null, s.batches(), s.endedBy());
    return new Step(closed, out);
  }

  static Step failWith(Failure failure, State s, List<Notice> first, Wait wait) {
    return closeWith(s.audioStarted() ? new Ending.FailedAfterAudio(failure) : new Ending.FailedBeforeAudio(failure), s, first, wait);
  }

  private static Step protocolEnd(State s) { return failWith(Failure.REQUEST_FAILED, s, List.of(), NO_WAIT); }

  static Failure relayFailure(RelayErrorCode code, boolean funding) {
    if (code == RelayErrorCode.UNAUTHORIZED || funding) return Failure.ACCOUNT_INELIGIBLE;
    return code == RelayErrorCode.UNAVAILABLE ? Failure.REMOTE_UNREACHABLE : Failure.REQUEST_FAILED;
  }

  static Step onTurn(SttKind kind, State s) {
    if (kind == SttKind.START_OF_TURN || kind == SttKind.TURN_RESUMED)
      return quiet(s.turn() == NO_TURN ? s.turn(s.capture() == Capture.LISTENING ? s.generation() : 0) : s);
    if (kind == SttKind.END_OF_TURN)
      return new Step(s.turn(NO_TURN), ownedTurn(s) ? List.of(new Notice.Heard(true, s.generation())) : List.of());
    return new Step(s, ownedTurn(s) ? List.of(new Notice.Heard(false, s.generation())) : List.of());
  }

  static Step settleReply(String id, boolean completed, State s) {
    return new Step(s.reply(null), List.of(new Notice.ReplySettled(id, completed)));
  }

  static Step onComplete(String id, State s) {
    Playing x = s.reply();
    if (x == null || !x.utteranceId().equals(id)) return quiet(s);
    if (x.receivedMs() == 0) return protocolEnd(s);
    if (x.playedMs() == x.receivedMs()) return settleReply(id, true, s);
    return quiet(s.reply(new Playing(x.utteranceId(), x.pace(), x.receivedMs(), x.playedMs(), true)));
  }

  static Step cancelReply(State s) {
    String id = s.reply().utteranceId();
    Step after = settleReply(id, false, s);
    List<Notice> out = new ArrayList<>();
    out.add(new Notice.CancelUtterance(id));
    out.addAll(after.out());
    return new Step(after.state(), out);
  }

  static Step frameArrived(State s, Frame frame) {
    Phase p = s.phase();
    return switch (frame) {
      case Frame.Ready r -> p instanceof Phase.Connecting ? quiet(s.phase(READY)) : protocolEnd(s);
      case Frame.Stt e -> e.kind() == SttKind.CONNECTED
        ? (p instanceof Phase.Ready ? quiet(s.phase(LIVE)) : p instanceof Phase.Live ? quiet(s) : protocolEnd(s))
        : (p instanceof Phase.Live ? onTurn(e.kind(), s) : protocolEnd(s));
      case Frame.Extended x -> !(p instanceof Phase.Connecting) ? quiet(s) : protocolEnd(s);
      case Frame.Complete c -> p instanceof Phase.Live ? onComplete(c.id(), s) : protocolEnd(s);
      case Frame.Error e -> failWith(relayFailure(e.code(), e.funding()), s, List.of(), NO_WAIT);
      case Frame.Close c -> failWith(Failure.REMOTE_UNREACHABLE, s, List.of(), NO_WAIT);
      case Frame.Prepared x -> p instanceof Phase.Live ? quiet(s) : protocolEnd(s);
      case Frame.Audio x -> p instanceof Phase.Live ? quiet(s) : protocolEnd(s);
      case Frame.Flushed x -> p instanceof Phase.Live ? quiet(s) : protocolEnd(s);
    };
  }

  static Step settleBatch(int id, Verdict verdict, State s) {
    List<Batch> next = new ArrayList<>();
    for (Batch b : s.batches()) next.add(b.requestId() == id ? new Batch(b.requestId(), b.direction(), b.version(), verdict) : b);
    return new Step(s.batches(next), List.of(new Notice.BatchSettled(id, verdict)));
  }

  static Step credentialChanged(State s, int version) {
    Verdict gone = new Verdict.Failed(Failure.ACCOUNT_INELIGIBLE, NO_WAIT);
    List<Batch> next = new ArrayList<>();
    List<Notice> notices = new ArrayList<>();
    for (Batch b : s.batches()) {
      boolean waiting = b.verdict() instanceof Verdict.Pending;
      next.add(waiting ? new Batch(b.requestId(), b.direction(), b.version(), gone) : b);
      if (waiting) notices.add(new Notice.BatchSettled(b.requestId(), gone));
    }
    State rebound = new State(version, s.bound(), s.phase(), s.audioStarted(), s.capture(), s.generation(), s.turn(), s.reply(), next, s.endedBy());
    return isOpen(s.phase()) ? failWith(Failure.ACCOUNT_INELIGIBLE, rebound, notices, NO_WAIT) : new Step(rebound, notices);
  }

  public static boolean enabled(State s, Event event) {
    return switch (event) {
      case Event.ConsentClock e -> asks(s.phase()) >= 1 && e.waitMs() > 0;
      case Event.ConsentGiven e -> asks(s.phase()) >= 1;
      case Event.QuietStep e -> true;
      case Event.Begin e -> s.credential() >= 1 && !isOpen(s.phase());
      case Event.ConsentDismissed e -> asks(s.phase()) >= 1;
      case Event.CredentialChanged e -> e.version() >= 0 && e.version() != s.credential();
      case Event.Minted e -> s.phase() instanceof Phase.Minting;
      case Event.RelayLost e -> minted(s.phase());
      case Event.FrameArrived e -> minted(s.phase());
      case Event.Unmute e -> live(s) && s.capture() == Capture.MUTED && e.recordAudio();
      case Event.Mute e -> s.capture() != Capture.MUTED;
      case Event.CaptureAnswered e -> s.capture() == Capture.RESERVING;
      case Event.Speak e -> live(s) && s.reply() == null && !e.utteranceId().isEmpty() && e.pace() >= MIN_PACE && e.pace() <= MAX_PACE;
      case Event.AudioArrived e -> live(s) && e.audioMs() > 0;
      case Event.Played e -> s.reply() != null && e.playedMs() > 0 && s.reply().playedMs() + e.playedMs() <= s.reply().receivedMs();
      case Event.CancelReply e -> s.reply() != null;
      case Event.Output e -> live(s);
      case Event.Stop e -> isOpen(s.phase());
      case Event.DeviceEnded e -> switch (e.cause()) {
        case DEVICE_PAUSED -> isOpen(s.phase());
        case PLAYBACK_STUCK -> live(s);
        case MICROPHONE_LOST -> live(s) && s.capture() != Capture.MUTED;
        case CALL_BEFORE_LIVE -> isOpen(s.phase()) && !live(s);
        case NO_DEVICE_CAUSE -> false;
      };
      case Event.BatchRequested e -> s.credential() >= 1 && e.requestId() >= 1 && s.batches().stream().noneMatch(b -> b.requestId() == e.requestId());
      case Event.BatchCancelled e -> pending(s, e.requestId());
      case Event.BatchAnswered e -> pending(s, e.requestId());
    };
  }

  public static Step step(State s, Event event) {
    if (!enabled(s, event)) return quiet(s);
    return switch (event) {
      case Event.ConsentClock e -> quiet(waited(s.phase()) + e.waitMs() >= CONSENT_DEADLINE_MS
        ? s.phase(new Phase.Closed(new Ending.NotConsented()))
        : s.phase(new Phase.AwaitingConsent(asks(s.phase()), waited(s.phase()) + e.waitMs())));
      case Event.ConsentGiven e -> quiet(s.phase(MINTING));
      case Event.QuietStep e -> quiet(s);
      case Event.Begin e -> new Step(new State(s.credential(), s.credential(), new Phase.AwaitingConsent(1, 0), false, Capture.MUTED, 0, NO_TURN, null, s.batches(), DeviceCause.NO_DEVICE_CAUSE),
        List.of(new Notice.AskConsent()));
      case Event.ConsentDismissed e -> asks(s.phase()) == 1
        ? new Step(s.phase(new Phase.AwaitingConsent(2, waited(s.phase()))), List.of(new Notice.AskConsent()))
        : quiet(s.phase(new Phase.Closed(new Ending.NotConsented())));
      case Event.CredentialChanged e -> credentialChanged(s, e.version());
      case Event.Minted e -> e.answer() instanceof Answer.Answered
        ? quiet(new State(s.credential(), s.bound(), CONNECTING, s.audioStarted(), s.capture(), s.generation(), s.turn(), s.reply(), s.batches(), s.endedBy()))
        : failWith(failureOf(e.answer()), s, keyReport(e.answer(), s.credential()), waitOf(e.answer()));
      case Event.RelayLost e -> failWith(Failure.REMOTE_UNREACHABLE, s, List.of(), NO_WAIT);
      case Event.FrameArrived e -> frameArrived(s, e.frame());
      case Event.Unmute e -> new Step(s.capture(Capture.RESERVING), List.of(new Notice.ReserveLiveCapture()));
      case Event.Mute e -> new Step(s.capture(Capture.MUTED), List.of(new Notice.ReleaseLiveCapture()));
      case Event.CaptureAnswered e -> e.slot() == SlotAnswer.NO_REFUSAL
        ? quiet(new State(s.credential(), s.bound(), s.phase(), true, Capture.LISTENING, s.generation() + 1, s.turn(), s.reply(), s.batches(), s.endedBy()))
        : failWith(Failure.CAPABILITY_UNAVAILABLE, s.capture(Capture.MUTED), List.of(), NO_WAIT);
      case Event.Speak e -> quiet(s.reply(new Playing(e.utteranceId(), e.pace(), 0, 0, false)));
      case Event.AudioArrived e -> {
        Playing x = s.reply();
        if (x == null || !x.utteranceId().equals(e.utteranceId())) yield quiet(s);
        if (x.completed()) yield protocolEnd(s);
        yield quiet(s.heard().reply(new Playing(x.utteranceId(), x.pace(), x.receivedMs() + e.audioMs(), x.playedMs(), false)));
      }
      case Event.Played e -> {
        Playing x = s.reply();
        if (x.completed() && x.playedMs() + e.playedMs() == x.receivedMs()) yield settleReply(x.utteranceId(), true, s);
        yield quiet(s.reply(new Playing(x.utteranceId(), x.pace(), x.receivedMs(), x.playedMs() + e.playedMs(), x.completed())));
      }
      case Event.CancelReply e -> cancelReply(s);
      case Event.Output e -> e.notice() == OutputNotice.STOP_CAPTURE ? failWith(Failure.CAPABILITY_UNAVAILABLE, s, List.of(), NO_WAIT)
        : (e.notice() == OutputNotice.REFUSED_FOCUS_DENIED || e.notice() == OutputNotice.REFUSED_CALL_ACTIVE) && s.reply() != null ? cancelReply(s)
        : quiet(s);
      case Event.Stop e -> closeWith(new Ending.Stopped(), s, List.of(), NO_WAIT);
      case Event.DeviceEnded e -> {
        Step ended = failWith(Failure.CAPABILITY_UNAVAILABLE, s, List.of(), NO_WAIT);
        yield new Step(ended.state().endedBy(e.cause()), ended.out());
      }
      case Event.BatchRequested e -> {
        List<Batch> next = new ArrayList<>(s.batches());
        next.add(new Batch(e.requestId(), e.direction(), s.credential(), PENDING));
        yield quiet(s.batches(next));
      }
      case Event.BatchCancelled e -> settleBatch(e.requestId(), CANCELLED, s);
      case Event.BatchAnswered e -> {
        Step after = settleBatch(e.requestId(), verdictOf(e.answer()), s);
        List<Notice> out = new ArrayList<>(keyReport(e.answer(), s.credential()));
        out.addAll(after.out());
        yield new Step(after.state(), out);
      }
    };
  }

  public static final class Machine {
    private State state = INITIAL;

    public synchronized State state() { return state; }

    public synchronized Step apply(Event event) {
      if (!enabled(state, event)) return null;
      Step next = step(state, event);
      state = next.state();
      return next;
    }
  }

  static String q(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      if (c == '"' || c == '\\') out.append('\\').append(c);
      else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
      else out.append(c);
    }
    return out.append('"').toString();
  }

  static String tag(String tag) { return "{\"tag\":" + q(tag) + "}"; }

  public static String json(Wait w) {
    return switch (w) {
      case Wait.NoWait x -> tag("NoWait");
      case Wait.RetryAt r -> "{\"tag\":\"RetryAt\",\"retryAtMs\":" + r.retryAtMs() + "}";
      case Wait.ResetsAt r -> "{\"tag\":\"ResetsAt\",\"resetsAtMs\":" + r.resetsAtMs() + "}";
    };
  }

  public static String json(Verdict v) {
    return switch (v) {
      case Verdict.Pending x -> tag("BatchPending");
      case Verdict.Done x -> tag("BatchDone");
      case Verdict.Cancelled x -> tag("BatchCancelled");
      case Verdict.Failed f -> "{\"tag\":\"BatchFailed\",\"failure\":" + q(f.failure().tag) + ",\"wait\":" + json(f.waitTime()) + "}";
    };
  }

  static String json(Ending e) {
    return switch (e) {
      case Ending.Stopped x -> tag("Stopped");
      case Ending.NotConsented x -> tag("NotConsented");
      case Ending.FailedBeforeAudio f -> "{\"tag\":\"FailedBeforeAudio\",\"failure\":" + q(f.failure().tag) + "}";
      case Ending.FailedAfterAudio f -> "{\"tag\":\"FailedAfterAudio\",\"failure\":" + q(f.failure().tag) + "}";
    };
  }

  static String json(Phase p) {
    return switch (p) {
      case Phase.Idle x -> tag("Idle");
      case Phase.AwaitingConsent a -> "{\"tag\":\"AwaitingConsent\",\"asks\":" + a.asks() + ",\"waitedMs\":" + a.waitedMs() + "}";
      case Phase.Minting x -> tag("Minting");
      case Phase.Connecting x -> tag("Connecting");
      case Phase.Ready x -> tag("Ready");
      case Phase.Live x -> tag("Live");
      case Phase.Closed c -> "{\"tag\":\"Closed\",\"ending\":" + json(c.ending()) + "}";
    };
  }

  public static String json(State s) {
    StringBuilder batches = new StringBuilder("[");
    for (Batch b : s.batches()) {
      if (batches.length() > 1) batches.append(',');
      batches.append("{\"requestId\":").append(b.requestId()).append(",\"direction\":").append(q(b.direction().tag))
        .append(",\"version\":").append(b.version()).append(",\"verdict\":").append(json(b.verdict())).append('}');
    }
    Playing r = s.reply();
    String reply = r == null ? tag("NoReply") : "{\"tag\":\"Playing\",\"utteranceId\":" + q(r.utteranceId()) + ",\"pace\":" + r.pace()
      + ",\"receivedMs\":" + r.receivedMs() + ",\"playedMs\":" + r.playedMs() + ",\"completed\":" + r.completed() + "}";
    String turn = s.turn() == NO_TURN ? tag("NoTurn") : "{\"tag\":\"TurnOf\",\"capture\":" + s.turn() + "}";
    return "{\"credential\":" + s.credential() + ",\"bound\":" + s.bound() + ",\"phase\":" + json(s.phase())
      + ",\"audioStarted\":" + s.audioStarted() + ",\"capture\":" + q(s.capture().tag)
      + ",\"generation\":" + s.generation() + ",\"turn\":" + turn + ",\"reply\":" + reply + ",\"batches\":" + batches.append(']')
      + ",\"endedBy\":" + q(s.endedBy().tag) + "}";
  }

  public static String json(Notice n) {
    return switch (n) {
      case Notice.AskConsent x -> tag("AskConsent");
      case Notice.ReserveLiveCapture x -> tag("ReserveLiveCapture");
      case Notice.ReleaseLiveCapture x -> tag("ReleaseLiveCapture");
      case Notice.RevokeSession x -> tag("RevokeSession");
      case Notice.CancelUtterance c -> "{\"tag\":\"CancelUtterance\",\"utteranceId\":" + q(c.utteranceId()) + "}";
      case Notice.ReportRefusedKey k -> "{\"tag\":\"ReportRefusedKey\",\"version\":" + k.version() + ",\"reason\":" + q(k.reason().tag) + ",\"on\":\"OtherRequest\"}";
      case Notice.SessionFailed f -> "{\"tag\":\"SessionFailed\",\"failure\":" + q(f.failure().tag) + ",\"beforeAudio\":" + f.beforeAudio() + ",\"wait\":" + json(f.waitTime()) + "}";
      case Notice.Heard h -> "{\"tag\":\"Heard\",\"final\":" + h.last() + ",\"capture\":" + h.capture() + "}";
      case Notice.ReplySettled r -> "{\"tag\":\"ReplySettled\",\"utteranceId\":" + q(r.utteranceId()) + ",\"completed\":" + r.completed() + "}";
      case Notice.BatchSettled b -> "{\"tag\":\"BatchSettled\",\"requestId\":" + b.requestId() + ",\"verdict\":" + json(b.verdict()) + "}";
    };
  }
}
