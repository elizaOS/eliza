package ai.eliza.voice;

import android.content.Context;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import java.io.File;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;

/** Exact live controller and draft owner, with controlled microphone ports. */
public final class ProcessLocalMicrophoneTest {
  private static final String A = LiveCaptureControllerTest.A;
  private static final String B = LiveCaptureControllerTest.B;

  private static void check(boolean condition, String detail) {
    if (!condition) throw new AssertionError(detail);
  }

  private static LiveCaptureControllerTest.Result queueStart(LiveCaptureController controller, String id) {
    var result = new LiveCaptureControllerTest.Result();
    controller.start(controller.reserve(id, 1), false, null, null, false, result);
    return result;
  }

  private static LiveCaptureControllerTest.Result start(LiveCaptureController controller, String id) throws Exception {
    var result = queueStart(controller, id);
    LiveCaptureControllerTest.await(result.done);
    return result;
  }

  private static void stop(LiveCaptureController controller, String id) throws Exception {
    var result = new LiveCaptureControllerTest.Stop();
    controller.stop(id, true, System.currentTimeMillis(), result);
    LiveCaptureControllerTest.await(result.done);
  }

  private static void refusesLive(LiveCaptureController controller, LiveCaptureControllerTest.Host host) throws Exception {
    check(start(controller, B).refused != null && host.sources.isEmpty(), "competing live owner reached the microphone");
  }

  private static void refusesDraft(LocalVoiceRecording draft) throws IOException {
    int opened = MediaRecorder.opens;
    try {
      draft.start(LocalVoiceRecording.SHORT_LIMIT_MS);
      throw new AssertionError("competing draft opened the microphone");
    } catch (IllegalStateException busy) {
      check(MediaRecorder.opens == opened, "draft refusal came after recorder construction");
    }
  }

  private static LiveCaptureController controllerWith(LiveVoiceCapture.SourceFactory source) {
    return new LiveCaptureController(new LiveCaptureController.Host() {
      public boolean open(long epoch) { return true; }
      public LiveVoiceCapture capture(String id, LiveVoiceCapture.Sink sink, boolean echoCancel) {
        return new LiveVoiceCapture(null, id, sink, LiveVoiceCapture.DICTATION,
            source, () -> LiveCaptureControllerTest.DETECTOR);
      }
      public void frames(String id, JSONArray frames, JSONArray vad, float peak) {}
      public void ended(String id, String error) {}
    });
  }

  public static void main(String[] args) throws Exception {
    var firstHost = new LiveCaptureControllerTest.Host();
    var secondHost = new LiveCaptureControllerTest.Host();
    var first = new LiveCaptureController(firstHost);
    var second = new LiveCaptureController(secondHost);
    var context = new Context(new File(args[1]));
    var draft = new LocalVoiceRecording(context, "microphone-fixture-", value -> {});
    try {
      switch (args[0]) {
        case "two-live-hosts":
          check(start(first, A).refused == null, "first source opened");
          refusesLive(second, secondHost);
          check(firstHost.sources.getFirst().closed.getCount() == 1, "refusal preserved the first source");
          stop(first, A);
          check(start(second, B).refused == null, "confirmed release lets the next host start");
          break;
        case "draft-then-live": {
          draft.start(LocalVoiceRecording.SHORT_LIMIT_MS);
          refusesLive(second, secondHost);
          check(MediaRecorder.active == 1, "refusal preserved the draft");
          String recordingId = draft.stop().getString("recordingId");
          check(start(second, B).refused == null, "finalized draft released the microphone");
          check(draft.selected(recordingId).isFile(), "live acquisition retained the finished draft");
          break;
        }
        case "live-then-draft":
          check(start(first, A).refused == null, "live source opened");
          refusesDraft(draft);
          check(firstHost.sources.getFirst().closed.getCount() == 1, "refusal preserved live capture");
          stop(first, A);
          draft.start(LocalVoiceRecording.SHORT_LIMIT_MS);
          check(MediaRecorder.active == 1, "draft may retry after live release");
          break;
        case "cancel-while-opening": {
          var opening = new CountDownLatch(1);
          var finishOpening = new CountDownLatch(1);
          firstHost.beforeOpen.set(() -> {
            opening.countDown();
            try { LiveCaptureControllerTest.await(finishOpening); }
            catch (Exception error) { throw new AssertionError(error); }
          });
          var pending = queueStart(first, A);
          LiveCaptureControllerTest.await(opening);
          var stopped = new LiveCaptureControllerTest.Stop();
          first.stop(A, true, System.currentTimeMillis(), stopped);
          try { refusesLive(second, secondHost); }
          finally { finishOpening.countDown(); }
          LiveCaptureControllerTest.await(pending.done);
          LiveCaptureControllerTest.await(stopped.done);
          check(pending.refused != null && firstHost.sources.getFirst().closed.getCount() == 0,
              "late source was released without publishing a started capture");
          check(start(second, B).refused == null, "late release allows retry");
          break;
        }
        case "live-close-unconfirmed": {
          check(start(first, A).refused == null, "live source opened");
          var source = firstHost.sources.getFirst();
          source.failClose = true;
          stop(first, A);
          check(source.closed.getCount() == 1, "source close was unconfirmed");
          refusesLive(second, secondHost);
          refusesDraft(draft);
          break;
        }
        case "native-open-failed":
        case "native-open-release-unconfirmed": {
          var nativeCapture = controllerWith(() -> new LiveVoiceCapture.MicrophoneSource(context, false));
          try {
            AudioRecord.failStart = true;
            AudioRecord.failRelease = args[0].endsWith("unconfirmed");
            var result = start(nativeCapture, A);
            check(result.refused != null, "failed source opening must refuse");
            if (AudioRecord.failRelease) {
              check(AudioRecord.releases == 0, "failed native cleanup has no release receipt");
              refusesLive(second, secondHost);
              refusesDraft(draft);
            } else {
              check(AudioRecord.releases == 1, "failed open released its native source");
              check(start(second, B).refused == null, "known open failure released the slot");
            }
          } finally { nativeCapture.shutdown(); }
          break;
        }
        case "clock-setup-failed": {
          var allowClock = new CountDownLatch(1);
          var closed = new CountDownLatch(1);
          var closes = new AtomicInteger();
          var failing = controllerWith(() -> new LiveVoiceCapture.Source() {
            public String clock() {
              try { LiveCaptureControllerTest.await(allowClock); }
              catch (Exception error) { throw new AssertionError(error); }
              throw new IllegalStateException("synthetic clock failure");
            }
            public int read(short[] buffer, int offset, int length) { throw new AssertionError("unexpected read"); }
            public long captureTimeNs(long frame) { return VoiceLatencyTrials.UNSET; }
            public void requestStop() {}
            public void close() { closes.incrementAndGet(); closed.countDown(); }
          });
          try {
            check(start(failing, A).refused == null, "source was admitted before its setup failed");
            allowClock.countDown();
            check(closed.await(5, java.util.concurrent.TimeUnit.SECONDS), "throwing clock must close its source");
            stop(failing, A);
            check(closes.get() == 1, "failed setup closes its source exactly once");
            check(start(second, B).refused == null, "setup cleanup permits another owner");
          } finally {
            allowClock.countDown();
            failing.shutdown();
          }
          break;
        }
        case "draft-release-retry":
          draft.start(LocalVoiceRecording.SHORT_LIMIT_MS);
          MediaRecorder.failRelease = true;
          try { draft.cancel(); throw new AssertionError("unconfirmed draft release"); }
          catch (IllegalStateException expected) { check(MediaRecorder.active == 1, "draft owner retained"); }
          refusesLive(second, secondHost);
          MediaRecorder.failRelease = false;
          draft.cancel();
          check(start(second, B).refused == null, "successful retry released the draft");
          break;
        case "draft-open-failed":
          MediaRecorder.failPrepare = true;
          try { draft.start(LocalVoiceRecording.SHORT_LIMIT_MS); throw new AssertionError("prepare should fail"); }
          catch (IOException expected) { check(MediaRecorder.active == 0, "draft never became active"); }
          check(start(second, B).refused == null, "failed draft start released its reservation");
          break;
        case "draft-stop-error": {
          String recordingId = draft.start(LocalVoiceRecording.SHORT_LIMIT_MS).getString("recordingId");
          MediaRecorder.stopError = true;
          try { draft.cancel(); throw new AssertionError("stop should fail"); }
          catch (AssertionError expected) { check("synthetic stop error".equals(expected.getMessage()), "stop error is preserved"); }
          check(MediaRecorder.active == 0 && draft.selected(recordingId) == null,
              "stop Error must release the recorder and discard the draft");
          check(start(second, B).refused == null, "released draft lets another owner start");
          break;
        }
        default: throw new AssertionError(args[0]);
      }
    } finally {
      MediaRecorder.failRelease = false;
      MediaRecorder.stopError = false;
      draft.cancel();
      first.shutdown();
      second.shutdown();
    }
    System.out.println("PASS " + args[0]);
  }
}
