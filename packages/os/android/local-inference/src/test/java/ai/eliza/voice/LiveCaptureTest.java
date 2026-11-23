// spec/os/voice/liveCapture.md, "Only a speech segment and its short pre-roll leave the capture, and nothing is stored"; spec/os/voice/liveCapture.md, "A routed capture sends its segments only to the owner's agent, in order and bounded, and a stop cuts them off"
package ai.eliza.voice;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
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
}
