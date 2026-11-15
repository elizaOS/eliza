package ai.eliza.voice;
/** Test double: one shared session per process, counted. */
public final class VoiceAssets {
 public static final String ASSET_ROOT="paradee-voice/v1";
 public static final InferenceSession SHARED=new InferenceSession();
 public static volatile int opened;
 public static synchronized InferenceSession sharedInference(android.content.Context context){opened++;return SHARED;}
}
