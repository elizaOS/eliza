// spec/os/voice/liveCapture.md, "Only a speech segment and its short pre-roll leave the capture, and nothing is stored"; spec/os/voice/liveCapture.md, "A routed capture sends its segments only to the owner's agent, in order and bounded, and a stop cuts them off"; spec/os/voice/liveCapture.md, "An availability probe keeps at most one idle detector, which the next capture takes"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class LiveCaptureTest {
  private static List<LiveVadGate.Edge> run(LiveVadGate gate, float... probabilities) {
    List<LiveVadGate.Edge> edges = new ArrayList<>();
    for (float probability : probabilities) edges.add(gate.accept(probability));
    return edges;
  }

  @Test public void aSegmentOpensAfterItsRunAndClosesAfterItsHangover() {
    LiveVadGate gate = new LiveVadGate(2, 3);
    List<LiveVadGate.Edge> edges = run(gate, 0.6f, 0.2f, 0.6f, 0.6f, 0.4f, 0.1f, 0.1f, 0.1f, Float.NaN);
    assertEquals(List.of(
        LiveVadGate.Edge.NONE, LiveVadGate.Edge.NONE, LiveVadGate.Edge.NONE, LiveVadGate.Edge.SPEECH_START,
        LiveVadGate.Edge.NONE, LiveVadGate.Edge.NONE, LiveVadGate.Edge.NONE, LiveVadGate.Edge.SPEECH_END,
        LiveVadGate.Edge.NONE), edges);
    assertFalse(gate.speaking());
  }

  @Test(expected = IllegalArgumentException.class) public void aStartRunLongerThanThePrerollIsRefused() {
    new LiveVadGate(LiveVadGate.PREROLL_WINDOWS + 1, 16);
  }

  private static final class Agent implements LiveSegmentPipe.Transport {
    final List<JSONObject> posted = new ArrayList<>();
    @Override public void check() {}
    @Override public synchronized JSONObject post(JSONObject body) throws Exception {
      posted.add(body);
      JSONObject reply = body.optBoolean("close") ? new JSONObject().put("closed", true) : new JSONObject();
      return new JSONObject().put("status", 200).put("body", reply.toString());
    }
  }

  private static JSONArray frames(int count, long at) throws Exception {
    JSONArray frames = new JSONArray();
    for (int i = 0; i < count; i++) frames.put(new JSONObject().put("pcm16", "AA==").put("timestamp", at + i));
    return frames;
  }

  @Test public void aRoutedCaptureSendsInOrderUntilItsCutoffAndRefusesOverload() throws Exception {
    Agent agent = new Agent();
    List<String> failures = new ArrayList<>();
    LiveSegmentPipe pipe = new LiveSegmentPipe(agent, new LiveCaptureController.Pipe.Sink() {
      @Override public void result(JSONObject value) {}
      @Override public void failed(String code) { failures.add(code); }
    }, "00000000-0000-4000-8000-000000000001", "room-1");
    assertTrue(pipe.start(Executors.newSingleThreadExecutor()));
    assertTrue(pipe.ready().get(5, TimeUnit.SECONDS));
    assertTrue(pipe.offer(frames(2, 1_000), new JSONArray().put(new JSONObject().put("type", "speech-start").put("timestampMs", 1_000))));
    pipe.cutoff(1_500);
    assertTrue(pipe.offer(frames(2, 2_000), new JSONArray()));
    assertTrue(pipe.close(false, 1_500).get(5, TimeUnit.SECONDS));
    List<Integer> sent = new ArrayList<>();
    for (JSONObject body : agent.posted) if (body.has("frames")) sent.add(body.getJSONArray("frames").length());
    assertEquals(List.of(0, 2), sent);
    assertTrue(agent.posted.get(agent.posted.size() - 1).optBoolean("close"));
    assertEquals(List.of(), failures);

    LiveSegmentPipe overloaded = new LiveSegmentPipe(new Agent(), new LiveCaptureController.Pipe.Sink() {
      @Override public void result(JSONObject value) {}
      @Override public void failed(String code) { failures.add(code); }
    }, "00000000-0000-4000-8000-000000000002", null);
    assertFalse(overloaded.offer(frames(LiveSegmentPipe.MAX_QUEUED_FRAMES + 1, 0), new JSONArray()));
    assertEquals(List.of("BACKPRESSURE"), failures);
  }

  @Test public void aRoutedCaptureListensWhileTheAgentSessionWarmsAndSendsWhatItHeardOnceReady() throws Exception {
    routedCaptureWhileWarming(false);
  }

  @Test public void aStopThatKeepsTheTailWhileTheAgentSessionWarmsStillSendsWhatItHeard() throws Exception {
    routedCaptureWhileWarming(true);
  }

  private static void routedCaptureWhileWarming(boolean stopBeforeReady) throws Exception {
    CountDownLatch warming = new CountDownLatch(1), warmed = new CountDownLatch(1), started = new CountDownLatch(1), stopped = new CountDownLatch(1);
    List<JSONObject> posted = Collections.synchronizedList(new ArrayList<>());
    LiveSegmentPipe.Transport agent = new LiveSegmentPipe.Transport() {
      @Override public void check() {}
      @Override public JSONObject post(JSONObject body) throws Exception {
        if (posted.isEmpty()) {
          warming.countDown();
          if (!warmed.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("never warmed");
        }
        posted.add(body);
        JSONObject reply = body.optBoolean("close") ? new JSONObject().put("closed", true) : new JSONObject();
        return new JSONObject().put("status", 200).put("body", reply.toString());
      }
    };
    AtomicReference<LiveCaptureController.Sink> capture = new AtomicReference<>();
    AtomicReference<LiveCaptureController.Pipe> route = new AtomicReference<>();
    List<String> transcripts = Collections.synchronizedList(new ArrayList<>());
    LiveCaptureController controller = new LiveCaptureController(new LiveCaptureController.Host() {
      @Override public boolean open(long epoch) { return true; }
      @Override public LiveCaptureController.Capture capture(String id, LiveCaptureController.Sink sink, LiveCaptureOptions options) {
        capture.set(sink);
        return new LiveCaptureController.Capture() {
          @Override public String captureId() { return id; }
          @Override public boolean echoCancelled() { return true; }
          @Override public void start() {}
          @Override public long stopAndWait() { return 0; }
          @Override public void cancelPending() {}
          @Override public void requestStop() {}
          @Override public void interrupt(String reason) {}
        };
      }
      @Override public void frames(String id, JSONArray frames, JSONArray vad, float peak) {}
      @Override public void ended(String id, String error) {}
      @Override public void transcript(String id, JSONObject value, String error) { if (error != null) transcripts.add(error); }
    });
    try {
      String id = "00000000-0000-4000-8000-000000000003";
      List<String> refusals = new ArrayList<>();
      AtomicReference<Boolean> serverClosed = new AtomicReference<>();
      controller.start(controller.reserve(id, 1L), true, (sink, captureId, room) -> {
        LiveSegmentPipe pipe = new LiveSegmentPipe(agent, sink, captureId, room);
        route.set(pipe);
        return pipe;
      }, "room-1", false, new LiveCaptureController.Started() {
        @Override public void started(String captureId, int sampleRate, boolean echoCancelled, boolean piped) { started.countDown(); }
        @Override public void refused(String message, String code) { refusals.add(message); }
      });
      assertTrue(started.await(2, TimeUnit.SECONDS));
      assertTrue(warming.await(2, TimeUnit.SECONDS));
      capture.get().frames(id, frames(2, 1_000), new JSONArray().put(new JSONObject().put("type", "speech-start").put("timestampMs", 1_000)), 0.5f);
      LiveCaptureController.Stopped done = (captureId, durationMs, closed) -> { serverClosed.set(closed); stopped.countDown(); };
      if (stopBeforeReady) {
        controller.stop(id, false, 2_000, done);
        assertFalse(route.get().ready().isDone());
        warmed.countDown();
      } else {
        warmed.countDown();
        assertTrue(route.get().ready().get(5, TimeUnit.SECONDS));
        controller.stop(id, false, 2_000, done);
      }
      assertTrue(stopped.await(5, TimeUnit.SECONDS));
      List<Integer> sent = new ArrayList<>();
      for (JSONObject body : posted) if (body.has("frames")) sent.add(body.getJSONArray("frames").length());
      assertEquals(List.of(0, 2), sent);
      assertTrue(posted.get(posted.size() - 1).optBoolean("close"));
      assertTrue(serverClosed.get());
      assertEquals(List.of(), refusals);
      assertEquals(List.of(), transcripts);
    } finally {
      controller.shutdown();
    }
  }

  @Test public void aVadProbeOpensOneDetectorThatTheNextCaptureTakes() throws Exception {
    File bundle = Files.createTempDirectory("eliza-vad-").toFile();
    AtomicInteger contexts = new AtomicInteger(), destroyed = new AtomicInteger(), opened = new AtomicInteger(), closed = new AtomicInteger();
    InferenceSession session = new InferenceSession(bundle, new File(bundle, "m"), new File(bundle, "l"), null, Collections.emptyMap(), new InferenceSession.VadOps() {
      @Override public boolean supported() { return true; }
      @Override public long createContext(String bundlePath) { return contexts.incrementAndGet(); }
      @Override public void destroyContext(long context) { destroyed.incrementAndGet(); }
      @Override public long open(long context) { return 10 + opened.incrementAndGet(); }
      @Override public float[] processBatch(long handle, float[] pcm16kMono) { return new float[] {0.1f}; }
      @Override public void reset(long handle) {}
      @Override public void close(long handle) { closed.incrementAndGet(); }
    });
    try {
      for (int i = 0; i < 5; i++) assertTrue(LiveVoiceCapture.vadAvailable(session));
      assertEquals(List.of(1, 1, 0), List.of(contexts.get(), opened.get(), closed.get()));
      session.openVad().close();
      assertTrue(LiveVoiceCapture.vadAvailable(session));
      assertEquals(List.of(1, 1, 1), List.of(contexts.get(), opened.get(), closed.get()));
      assertTrue(LiveVoiceCapture.vadAvailable(session));
      session.trimMemory();
      assertEquals(List.of(1, 1), List.of(closed.get(), destroyed.get()));
      assertTrue(LiveVoiceCapture.vadAvailable(session));
      assertEquals(List.of(2, 2), List.of(contexts.get(), opened.get()));
    } finally {
      session.close();
      bundle.delete();
    }
    assertFalse(LiveVoiceCapture.vadAvailable(session));
  }
}
