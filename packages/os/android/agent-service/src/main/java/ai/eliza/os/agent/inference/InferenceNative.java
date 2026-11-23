// spec/os/agentService/inference.md, "Story: Embed, speak and transcribe on my phone through my app alone"
package ai.eliza.os.agent.inference;

/**
 * The consumer's native inference library, under the consumer's own JNI identity. Handles are native
 * pointers, 0 when a context cannot be opened. A call the library rejects for its input throws
 * {@link IllegalArgumentException}; a cancelled synthesis or transcription throws
 * {@link java.util.concurrent.CancellationException}; any other throw is a failure of the context.
 */
public interface InferenceNative {
  /** Loads the library once; false when it cannot be loaded on this device. */
  boolean available();

  /** Opens the resident context on a model or speech bundle directory. */
  long openContext(String bundleDir);

  /** Frees a resident context. */
  void closeContext(long context);

  /** Opens an embedding session on one model file. */
  long openEmbedding(String modelFile);

  /** Frees an embedding session. */
  void closeEmbedding(long session);

  /** Embeds UTF-8 text with llama.cpp pooling 1 (mean), 2 (CLS) or 3 (last token); null when nothing came back. */
  float[] embed(long session, byte[] utf8, int pooling);

  /** Whether the speech bundle can synthesize. */
  boolean synthesisReady(String speechBundle);

  /** Whether the speech bundle can transcribe. */
  boolean transcriptionReady(String speechBundle);

  /** Synthesizes UTF-8 text on the resident context as mono float PCM at {@link #sampleRate}. */
  float[] synthesize(long context, byte[] utf8);

  /** The resident context's synthesis sample rate. */
  int sampleRate(long context);

  /** Transcribes mono float PCM at a sample rate on the resident context. */
  String transcribe(long context, float[] pcm, int sampleRate);

  /** Signals the synthesis or transcription running on the context to stop; it then throws a cancellation. */
  void cancelSpeech(long context);

  /** Whether the resident context can score the end of a turn. */
  boolean endOfTurnReady(long context);

  /** The probability that the UTF-8 transcript ends a turn. */
  float endOfTurn(long context, byte[] utf8);
}
