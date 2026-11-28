// spec/os/voice/speechOutput.md, "Story: Prime the audio output without playing over anything"; spec/os/voice/speechOutput.md, "Story: Start a reply's audio promptly without playing over anything"; spec/os/voice/speechOutput.md, "A listener holds focus while its microphone is open, and a transient loss pauses it until focus returns"
package ai.eliza.voice;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class SpeechOutputReplay {
  private static final int RATE = 24_000;
  private static final long SETTLE_MS = 5_000;
  private static final Object DRAINED = new Object();

  private enum Stage {
    STARTING("Opening"), OPENING("Opening"), LOOPING("Looping"), WRITING("Writing"),
    CLEANING_UP("CleaningUp"), RELEASED("Released"), NOTHING_OPENED("NothingOpened");

    final String phase;

    Stage(String phase) { this.phase = phase; }
  }

  private static final class Worker implements StreamingSpeechPlayback.Output {
    final int id;
    SpeechOutputWarmup warmup;
    private final Object lock = new Object();
    private Stage stage = Stage.STARTING;
    private int arrivals;
    private Object answer;
    private boolean drained;
    private boolean clockStarted;
    private boolean playFails;
    private long elapsedMs;
    private int releases;

    Worker(int id) { this.id = id; }

    private Object arrive(Stage next) {
      synchronized (lock) {
        stage = next;
        arrivals++;
        lock.notifyAll();
        boolean interrupted = false;
        while (answer == null && !drained) {
          try {
            lock.wait();
          } catch (InterruptedException closed) {
            interrupted = true;
          }
        }
        if (interrupted) Thread.currentThread().interrupt();
        Object given = drained ? DRAINED : answer;
        answer = null;
        return given;
      }
    }

    private void settle(Stage next) {
      synchronized (lock) {
        stage = next;
        arrivals++;
        lock.notifyAll();
      }
    }

    Stage stage() {
      synchronized (lock) { return stage; }
    }

    long elapsedMs() {
      synchronized (lock) { return elapsedMs; }
    }

    void awaitArrival(int seen) {
      synchronized (lock) {
        long deadline = System.currentTimeMillis() + SETTLE_MS;
        while (arrivals == seen) {
          long left = deadline - System.currentTimeMillis();
          if (left <= 0) throw new IllegalStateException("warm-up worker " + id + " did not move on from " + stage.phase);
          try {
            lock.wait(left);
          } catch (InterruptedException stopped) {
            throw new IllegalStateException("interrupted while waiting for worker " + id, stopped);
          }
        }
      }
    }

    void started() {
      awaitArrival(0);
    }

    void deliver(Object given) {
      int seen;
      synchronized (lock) {
        seen = arrivals;
        answer = given;
        lock.notifyAll();
      }
      awaitArrival(seen);
    }

    void drain() {
      synchronized (lock) {
        drained = true;
        lock.notifyAll();
      }
    }

    StreamingSpeechPlayback.Output open() {
      Object given = arrive(Stage.OPENING);
      if (given == DRAINED || given.equals("OutputMissing")) {
        settle(Stage.NOTHING_OPENED);
        throw new IllegalStateException("no speech output");
      }
      synchronized (lock) { playFails = given.equals("PlayFailed"); }
      return this;
    }

    long now() {
      synchronized (lock) {
        if (!clockStarted) {
          clockStarted = true;
          return 0;
        }
      }
      Object given = arrive(Stage.LOOPING);
      if (given == DRAINED) return Long.MAX_VALUE / 2;
      long ms = (Long) given;
      synchronized (lock) { elapsedMs = ms; }
      return ms * 1_000_000L;
    }

    @Override
    public void play() {
      synchronized (lock) {
        if (playFails) throw new IllegalStateException("play failed");
      }
    }

    @Override
    public int write(float[] samples, int offset, int length) {
      for (int i = offset; i < offset + length; i++) if (samples[i] != 0f) throw new IllegalStateException("a warm-up wrote sound");
      Object given = arrive(Stage.WRITING);
      return given == Boolean.TRUE ? length : 0;
    }

    @Override public long playedFrames() { return 0; }
    @Override public long presentationNs(long frame) { return StreamingSpeechPlayback.UNSET; }
    @Override public void setVolume(float volume) {}
    @Override public void abort() {}
    @Override public void stop() {}

    @Override
    public void release() {
      synchronized (lock) { releases++; }
      arrive(Stage.CLEANING_UP);
      settle(Stage.RELEASED);
    }

    int releases() {
      synchronized (lock) { return releases; }
    }
  }

  private static final class Speaker implements StreamingSpeechPlayback.Output {
    int written;

    @Override public void play() {}

    @Override
    public int write(float[] samples, int offset, int length) {
      written++;
      return length;
    }

    @Override public long playedFrames() { return 0; }
    @Override public long presentationNs(long frame) { return StreamingSpeechPlayback.UNSET; }
    @Override public void setVolume(float volume) {}
    @Override public void abort() {}
    @Override public void stop() {}
    @Override public void release() {}
  }

  private record Utterance(int id, Speaker speaker, FirstWriteSpeechOutput output) {}

  private SpeechOutputGate gate = new SpeechOutputGate();
  private final Map<Integer, Worker> workers = new LinkedHashMap<>();
  private Utterance utterance;
  private List<String> out = new ArrayList<>();

  public static void main(String[] args) throws Exception {
    SpeechOutputReplay replay = new SpeechOutputReplay();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = input.readLine()) != null;) {
      if (line.isBlank()) continue;
      try {
        output.println(replay.answer(line));
      } catch (RuntimeException failure) {
        output.println("{\"error\":" + quoted(String.valueOf(failure)) + "}");
      }
    }
  }

  private String answer(String line) {
    Matcher event = Pattern.compile("\"(?:event|raw)\"\\s*:\\s*(\\{[^{}]*\\})").matcher(line);
    if (!event.find()) {
      reset();
      return "{\"state\":" + state() + ",\"out\":[]}";
    }
    out = new ArrayList<>();
    boolean accepted = apply(event.group(1));
    if (utterance != null && !gate.speaking()) utterance = null;
    return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + ",\"out\":[" + String.join(",", out) + "]}";
  }

  private void reset() {
    gate.stopWarmup();
    for (Worker worker : workers.values()) worker.drain();
    workers.clear();
    gate = new SpeechOutputGate();
    utterance = null;
    out = new ArrayList<>();
  }

  private boolean apply(String body) {
    String type = text(body, "type");
    switch (type) {
      case "requestWarmup": {
        int id = (int) number(body, "id");
        if (id <= 0 || workers.containsKey(id)) return false;
        Worker worker = new Worker(id);
        boolean admitted = gate.requestWarmup(() ->
            worker.warmup = new SpeechOutputWarmup(RATE, SpeechOutputWarmup.LIMIT_NS, worker::open, worker::now));
        if (!admitted) return false;
        workers.put(id, worker);
        worker.started();
        return true;
      }
      case "stopWarmup":
        return gate.stopWarmup();
      case "openWarmup":
        return deliver(body, Stage.OPENING, text(body, "opened"));
      case "checkWarmupLoop": {
        long elapsedMs = number(body, "elapsedMs");
        return elapsedMs >= 0 && deliver(body, Stage.LOOPING, elapsedMs);
      }
      case "finishWarmupWrite":
        return deliver(body, Stage.WRITING, flag(body, "written"));
      case "releaseWarmup":
        return deliver(body, Stage.CLEANING_UP, Boolean.TRUE);
      case "startSpeech": {
        int id = (int) number(body, "utteranceId");
        boolean granted = flag(body, "granted");
        if (id <= 0) return false;
        List<SpeechOutputGate.Notice> notices = gate.startSpeech(() -> granted);
        if (notices == null) return false;
        if (notices.isEmpty()) {
          Speaker speaker = new Speaker();
          utterance = new Utterance(id, speaker, new FirstWriteSpeechOutput(speaker, () -> out.add("{\"tag\":\"FirstAudio\",\"utteranceId\":" + id + "}")));
        }
        return notices(notices);
      }
      case "audioModeChanged":
        return notices(gate.modeChanged(switch (text(body, "mode")) {
          case "NormalAudio" -> SpeechAudioFocusPolicy.Mode.NORMAL;
          case "CallAudio" -> SpeechAudioFocusPolicy.Mode.IN_CALL;
          default -> throw new IllegalArgumentException("unknown audio mode in " + body);
        }));
      case "writeSpeech": {
        if (!gate.speaking() || utterance == null) return false;
        float[] chunk = new float[RATE / 50];
        utterance.output().write(chunk, 0, chunk.length);
        return true;
      }
      case "endSpeech":
        return notices(gate.end());
      case "cancelSpeech":
        return notices(gate.cancel());
      case "openListening": {
        boolean granted = flag(body, "granted");
        return notices(gate.openListening(() -> granted));
      }
      case "closeListening":
        return notices(gate.closeListening());
      case "withVolume":
        gate.setDucked(switch (text(body, "v")) {
          case "Ducked" -> true;
          case "FullVolume" -> false;
          default -> throw new IllegalArgumentException("unknown volume in " + body);
        });
        return true;
      case "focusChanged":
        return notices(gate.focusChanged(switch (text(body, "change")) {
          case "FocusGain" -> SpeechAudioFocusPolicy.Event.GAIN;
          case "FocusLoss" -> SpeechAudioFocusPolicy.Event.LOSS;
          case "FocusLossTransient" -> SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT;
          case "FocusLossCanDuck" -> SpeechAudioFocusPolicy.Event.LOSS_TRANSIENT_CAN_DUCK;
          default -> throw new IllegalArgumentException("unknown focus change in " + body);
        }));
      default:
        throw new IllegalArgumentException("unknown event " + type);
    }
  }

  private boolean deliver(String body, Stage expected, Object given) {
    Worker worker = workers.get((int) number(body, "id"));
    if (worker == null || worker.stage() != expected) return false;
    worker.deliver(given);
    return true;
  }

  private boolean notices(List<SpeechOutputGate.Notice> notices) {
    if (notices == null) return false;
    for (SpeechOutputGate.Notice notice : notices) out.add("{\"tag\":" + quoted(tag(notice)) + "}");
    return true;
  }

  private static String tag(SpeechOutputGate.Notice notice) {
    return switch (notice) {
      case REFUSED_CALL_ACTIVE -> "RefusedCallActive";
      case REFUSED_FOCUS_DENIED -> "RefusedFocusDenied";
      case REFUSED_FOCUS_PAUSED -> "RefusedFocusPaused";
      case STOP_PLAYBACK -> "StopPlayback";
      case ABANDON_FOCUS -> "AbandonFocus";
      case DUCK_VOLUME -> "DuckVolume";
      case RESTORE_VOLUME -> "RestoreVolume";
      case STOP_CAPTURE -> "StopCapture";
      case PAUSE_LISTENING -> "PauseListening";
      case RESUME_LISTENING -> "ResumeListening";
      case PERMANENT_LOSS -> "PermanentLoss";
    };
  }

  private String state() {
    SpeechOutputWarmup owner = gate.warmup();
    int ownerId = 0;
    List<String> listed = new ArrayList<>();
    for (Worker worker : workers.values()) {
      if (worker.warmup == owner) ownerId = worker.id;
      if (worker.releases() > 1) throw new IllegalStateException("warm-up worker " + worker.id + " released its output " + worker.releases() + " times");
      listed.add("{\"workerId\":" + worker.id + ",\"phase\":" + quoted(worker.stage().phase)
          + ",\"closed\":" + worker.warmup.closed() + ",\"elapsedMs\":" + worker.elapsedMs() + "}");
    }
    String volume = quoted(gate.ducked() ? "Ducked" : "FullVolume");
    String speech = utterance == null
        ? "{\"tag\":\"Silent\"}"
        : "{\"tag\":\"Speaking\",\"utteranceId\":" + utterance.id() + ",\"written\":" + utterance.speaker().written
            + ",\"volume\":" + volume + "}";
    String hold = !gate.listening() ? "{\"tag\":\"NoHold\"}"
        : gate.paused() ? "{\"tag\":\"HoldPaused\"}"
        : "{\"tag\":\"Holding\",\"volume\":" + volume + "}";
    return "{\"owner\":" + ownerId + ",\"workers\":[" + String.join(",", listed) + "],\"speech\":" + speech
        + ",\"mode\":" + quoted(gate.callActive() ? "CallAudio" : "NormalAudio") + ",\"hold\":" + hold + "}";
  }

  private static Matcher field(String body, String name, String value) {
    Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
    if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
    return found;
  }

  private static long number(String body, String name) {
    return Long.parseLong(field(body, name, "(-?\\d+)").group(1));
  }

  private static boolean flag(String body, String name) {
    return Boolean.parseBoolean(field(body, name, "(true|false)").group(1));
  }

  private static String text(String body, String name) {
    return field(body, name, "\"(\\w+)\"").group(1);
  }

  private static String quoted(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }
}
