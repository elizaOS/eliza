// spec/os/agentService/inference.md, "Only the app's own process is served, for an operation the host offers, within its frame limit and its model storage"; spec/os/agentService/inference.md, "An embedding is answered only by the verified model assigned to embeddings, as a finite vector of its dimensions"; spec/os/agentService/inference.md, "Speech readiness and the end-of-turn score say only what the host answered"
package ai.eliza.os.agent.inference;

import java.io.File;
import java.io.IOException;

/** The host's pure admission rules: offered operations, frame limits, model storage and the vectors it answers. */
public final class InferencePolicy {
  private InferencePolicy() {}

  /** The operations the host offers; anything else, text generation among them, is refused. */
  public enum Op {
    CAPABILITIES("capabilities"), LOAD("load"), UNLOAD("unload"), WARM_EMBEDDING("warmEmbedding"), EMBED("embed"),
    SYNTHESIZE("synthesize"), TRANSCRIBE("transcribe"), CANCEL_SPEECH("cancelSpeech"), END_OF_TURN("endOfTurn");

    public final String wire;
    Op(String wire) { this.wire = wire; }

    /** The offered operation a wire name names, or null. */
    public static Op named(String wire) {
      for (Op op : values()) if (op.wire.equals(wire)) return op;
      return null;
    }
  }

  /** What becomes of a request before it reaches the native library. */
  public enum Verdict { SERVED, PEER_REFUSED, FRAME_TOO_LARGE, OP_REFUSED, PATH_REFUSED }

  /** What becomes of an embedding the native library returned. */
  public enum EmbeddingVerdict { VECTOR_SERVED, ARTIFACT_REFUSED, VECTOR_REFUSED }

  public static final int TEXT_FRAME_BYTES = 1 << 20;
  public static final int AUDIO_FRAME_BYTES = 16 << 20;
  public static final int END_OF_TURN_COMMIT_MILLI = 500;

  /** The largest frame an operation may arrive in; an unknown operation gets the text limit. */
  public static int frameLimit(Op op) {
    return op == Op.TRANSCRIBE ? AUDIO_FRAME_BYTES : TEXT_FRAME_BYTES;
  }

  /** The spec's request verdict, in its order: peer, frame, operation, storage. */
  public static Verdict requestVerdict(boolean sameUid, Op op, long bytes, boolean pathsConfined) {
    if (!sameUid) return Verdict.PEER_REFUSED;
    if (bytes > frameLimit(op)) return Verdict.FRAME_TOO_LARGE;
    if (op == null) return Verdict.OP_REFUSED;
    if (!pathsConfined) return Verdict.PATH_REFUSED;
    return Verdict.SERVED;
  }

  /** Whether every named path resolves, links followed, inside the model storage; an empty list is confined. */
  public static boolean confined(File modelRoot, Iterable<String> paths) {
    final String root;
    try {
      root = modelRoot.getCanonicalPath();
    } catch (IOException unreadable) {
      return false;
    }
    for (String path : paths) {
      if (path == null || path.isEmpty() || path.indexOf('\0') >= 0) return false;
      try {
        if (!new File(path).getCanonicalPath().startsWith(root + File.separator)) return false;
      } catch (IOException unresolvable) {
        return false;
      }
    }
    return true;
  }

  /** The spec's embedding verdict over a vector the native library returned. */
  public static EmbeddingVerdict embeddingVerdict(boolean digestMatches, int dimensions, float[] vector) {
    if (!digestMatches) return EmbeddingVerdict.ARTIFACT_REFUSED;
    if (vector == null || vector.length != dimensions) return EmbeddingVerdict.VECTOR_REFUSED;
    double normSquared = 0;
    for (float value : vector) {
      if (!Float.isFinite(value)) return EmbeddingVerdict.VECTOR_REFUSED;
      normSquared += (double) value * value;
    }
    return normSquared > 0 && Double.isFinite(normSquared) ? EmbeddingVerdict.VECTOR_SERVED : EmbeddingVerdict.VECTOR_REFUSED;
  }

  /** A served vector scaled to unit length. */
  public static double[] unit(float[] vector) {
    double normSquared = 0;
    for (float value : vector) normSquared += (double) value * value;
    double norm = Math.sqrt(normSquared);
    double[] out = new double[vector.length];
    for (int i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
    return out;
  }

  /** The native end-of-turn probability in thousandths, or -1 when it is not a probability. */
  public static int endOfTurnMilli(float probability) {
    return Float.isFinite(probability) && probability >= 0f && probability <= 1f ? Math.round(probability * 1000f) : -1;
  }

  /** Whether a score in thousandths completes the turn. */
  public static boolean endOfTurnComplete(int milli) {
    return milli >= END_OF_TURN_COMMIT_MILLI;
  }
}
