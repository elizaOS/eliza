// spec/os/agentService/inference.md, "Story: Embed, speak and transcribe on my phone through my app alone"; spec/os/agentService/inference.md, "An embedding is answered only by the verified model assigned to embeddings, as a finite vector of its dimensions"
package ai.eliza.voice;

import ai.eliza.os.agent.inference.InferenceNative;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * The agent service's inference host over {@link VoiceNative}, the shared JNI bridge of this module's
 * {@code libparadeevoicejni.so} on the consumer's {@code libelizainference.so}. Paradee loads from the
 * speech bundle on the first synthesis of a context; an embedding model file is linked into a private
 * one-model bundle under {@code bundleRoot}, the layout the library opens.
 */
public final class HostInferenceNative implements InferenceNative {
  private static final String PARADEE_MODEL = "tts/paradee/paradee-8m-v1_2.gguf";
  private static final String MISAKI_LEXICON = "tts/paradee/misaki-en-us.lex";
  private static final String ESPEAK_DIR = "tts/paradee";
  private static final String END_OF_TURN_TOKEN = "<end_of_turn>";

  private final String speechBundle;
  private final File bundleRoot;
  private long speechLoaded;

  /** An engine over the host's speech bundle that keeps its private embedding bundles under {@code bundleRoot}. */
  public HostInferenceNative(String speechBundle, File bundleRoot) {
    this.speechBundle = speechBundle;
    this.bundleRoot = bundleRoot;
  }

  @Override public boolean available() {
    try {
      return VoiceNative.nativeEmbedSupported() >= 0;
    } catch (LinkageError missing) {
      return false;
    }
  }

  @Override public long openContext(String bundleDir) {
    return VoiceNative.nativeContextCreateUtf8(bundleDir.getBytes(StandardCharsets.UTF_8));
  }

  @Override public synchronized void closeContext(long context) {
    if (context == speechLoaded) speechLoaded = 0L;
    VoiceNative.nativeContextDestroy(context);
  }

  @Override public long openEmbedding(String modelFile) {
    if (VoiceNative.nativeEmbedSupported() != 1) return 0L;
    File model = new File(modelFile);
    File bundle = new File(bundleRoot, model.getName() + ".bundle");
    Path linked = new File(bundle, "text/" + model.getName()).toPath();
    try {
      Files.createDirectories(linked.getParent());
      if (!Files.isSymbolicLink(linked) || !Files.readSymbolicLink(linked).equals(model.toPath())) {
        Path pending = linked.resolveSibling(model.getName() + ".link");
        Files.deleteIfExists(pending);
        Files.createSymbolicLink(pending, model.toPath());
        Files.move(pending, linked, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      }
    } catch (IOException unlinkable) {
      return 0L;
    }
    return VoiceNative.nativeContextCreateUtf8(bundle.getAbsolutePath().getBytes(StandardCharsets.UTF_8));
  }

  @Override public void closeEmbedding(long session) {
    VoiceNative.nativeContextDestroy(session);
  }

  @Override public float[] embed(long session, byte[] utf8, int pooling) {
    return VoiceNative.nativeEmbedWithOptionsUtf8(session, utf8, pooling, true);
  }

  @Override public boolean synthesisReady(String speechBundle) {
    return VoiceNative.nativeParadeeSupported() == 1 && new File(speechBundle, PARADEE_MODEL).isFile() && new File(speechBundle, MISAKI_LEXICON).isFile();
  }

  @Override public boolean transcriptionReady(String speechBundle) {
    return VoiceNative.nativeAsrSupported() == 1 && new File(speechBundle, "asr").isDirectory();
  }

  @Override public synchronized float[] synthesize(long context, byte[] utf8) {
    if (speechLoaded != context) {
      File espeak = new File(speechBundle, ESPEAK_DIR + "/espeak-ng-data");
      VoiceNative.nativeParadeeLoad(context, new File(speechBundle, PARADEE_MODEL).getAbsolutePath(),
          new File(speechBundle, MISAKI_LEXICON).getAbsolutePath(), espeak.isDirectory() ? new File(speechBundle, ESPEAK_DIR).getAbsolutePath() : null);
      speechLoaded = context;
    }
    return VoiceNative.nativeParadeeSynthesize(context, utf8, 1.0f);
  }

  @Override public int sampleRate(long context) {
    return VoiceNative.nativeParadeeSampleRate(context);
  }

  @Override public String transcribe(long context, float[] pcm, int sampleRate) {
    VoiceNative.nativeMmapAcquire(context, "asr");
    return VoiceNative.nativeAsrTranscribe(context, pcm, sampleRate);
  }

  @Override public void cancelSpeech(long context) {
    VoiceNative.nativeCancelTts(context);
    VoiceNative.nativeAsrCancel(context);
  }

  @Override public boolean endOfTurnReady(long context) {
    return VoiceNative.nativeEotSupported() == 1;
  }

  @Override public float endOfTurn(long context, byte[] utf8) {
    int[] target = VoiceNative.nativeTokenizeWithOptionsUtf8(context, END_OF_TURN_TOKEN.getBytes(StandardCharsets.UTF_8), true);
    if (target == null || target.length != 1) throw new IllegalArgumentException("the loaded model has no single end-of-turn token");
    int[] tokens = VoiceNative.nativeTokenizeUtf8(context, utf8);
    if (tokens == null || tokens.length == 0) throw new IllegalArgumentException("the transcript has no tokens");
    return VoiceNative.nativeEotScore(context, tokens, target[0]);
  }
}
