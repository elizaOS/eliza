// spec/os/agentService/inference.md, "One pass runs at a time on its own context, nothing is freed under it, and a failed pass drops the context it used"
package ai.eliza.os.agent.inference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.junit.Test;

public final class InferenceHostTest {
  private static String sha256Hex(byte[] bytes) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    StringBuilder hex = new StringBuilder();
    for (byte b : digest.digest(bytes)) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
    return hex.toString();
  }

  private static String pcmBase64(float... samples) {
    ByteBuffer bytes = ByteBuffer.allocate(samples.length * 4).order(ByteOrder.LITTLE_ENDIAN);
    for (float sample : samples) bytes.putFloat(sample);
    return Base64.getEncoder().encodeToString(bytes.array());
  }

  @Test public void transcribeDoesNotWaitForConcurrentEmbeddingPassAndFailuresDropOnlyOwnContext() throws Exception {
    File root = Files.createTempDirectory("eliza-inference-host-").toFile();
    File model = new File(root, "bge-small.gguf");
    byte[] contents = "pinned-bge-model".getBytes(StandardCharsets.UTF_8);
    try (FileOutputStream out = new FileOutputStream(model)) {
      out.write(contents);
    }
    String digest = sha256Hex(contents);

    CountDownLatch embedEntered = new CountDownLatch(1);
    CountDownLatch releaseEmbed = new CountDownLatch(1);
    AtomicInteger contextCloses = new AtomicInteger();
    AtomicInteger embeddingCloses = new AtomicInteger();
    AtomicInteger failNextEmbed = new AtomicInteger();

    InferenceNative fakeEngine = new InferenceNative() {
      @Override public boolean available() { return true; }
      @Override public long openContext(String bundleDir) { return 101L; }
      @Override public void closeContext(long context) { contextCloses.incrementAndGet(); }
      @Override public long openEmbedding(String modelFile) { return 202L; }
      @Override public void closeEmbedding(long session) { embeddingCloses.incrementAndGet(); }
      @Override public float[] embed(long session, byte[] utf8, int pooling) {
        if (failNextEmbed.getAndSet(0) == 1) throw new IllegalStateException("embed boom");
        embedEntered.countDown();
        try {
          if (!releaseEmbed.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("timed out waiting");
        } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
        }
        return new float[] {1f, 0f, 0f, 0f};
      }
      @Override public boolean synthesisReady(String speechBundle) { return true; }
      @Override public boolean transcriptionReady(String speechBundle) { return true; }
      @Override public float[] synthesize(long context, byte[] utf8) { return new float[] {0.5f}; }
      @Override public int sampleRate(long context) { return 16000; }
      @Override public String transcribe(long context, float[] pcm, int sampleRate) { return "hello voice"; }
      @Override public void cancelSpeech(long context) {}
      @Override public boolean endOfTurnReady(long context) { return false; }
      @Override public float endOfTurn(long context, byte[] utf8) { return 0f; }
    };

    AtomicLong now = new AtomicLong(1000L);
    InferenceHost host = new InferenceHost("test-socket", root.getAbsolutePath(), root, fakeEngine, 0L, 1000, now::get);
    ExecutorService pool = Executors.newFixedThreadPool(2);
    try {
      JSONObject embedReq = new JSONObject()
          .put("file", model.getAbsolutePath())
          .put("sha256", digest)
          .put("dimensions", 4)
          .put("pooling", 1)
          .put("text", "index my note");
      JSONObject asrReq = new JSONObject()
          .put("pcmBase64", pcmBase64(0.1f, -0.1f, 0.2f, -0.2f))
          .put("sampleRate", 16000);

      Future<String> embedFuture = pool.submit(() -> host.answer(InferencePolicy.Op.EMBED, embedReq, null));
      assertTrue("embed pass must start", embedEntered.await(3, TimeUnit.SECONDS));

      Future<String> asrFuture = pool.submit(() -> host.answer(InferencePolicy.Op.TRANSCRIBE, asrReq, new InferenceHost.SpeechRequest()));
      String asrJson = asrFuture.get(2, TimeUnit.SECONDS);
      JSONObject asrAnswer = new JSONObject(asrJson);
      assertTrue(asrAnswer.getBoolean("ok"));
      assertEquals("hello voice", asrAnswer.getString("text"));
      assertFalse("embedding pass should still be running when ASR finished", embedFuture.isDone());

      releaseEmbed.countDown();
      JSONObject embedAnswer = new JSONObject(embedFuture.get(2, TimeUnit.SECONDS));
      assertTrue(embedAnswer.getBoolean("ok"));
      assertEquals(4, embedAnswer.getJSONArray("embedding").length());

      failNextEmbed.set(1);
      JSONObject failedEmbed = new JSONObject(host.answer(InferencePolicy.Op.EMBED, embedReq, null));
      assertFalse(failedEmbed.getBoolean("ok"));
      assertEquals("UNAVAILABLE", failedEmbed.getString("code"));
      assertEquals(1, embeddingCloses.get());
      assertEquals(0, contextCloses.get());

      host.release("test");
      assertEquals(1, contextCloses.get());
    } finally {
      releaseEmbed.countDown();
      pool.shutdownNow();
      model.delete();
      root.delete();
    }
  }
}
