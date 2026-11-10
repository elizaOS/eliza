package android.speech;

/** Test double: the extra names are placeholders; the recognizer only passes them through. */
public class RecognizerIntent {
    public static final String ACTION_RECOGNIZE_SPEECH = "action";
    public static final String EXTRA_LANGUAGE = "language";
    public static final String EXTRA_LANGUAGE_MODEL = "language_model";
    public static final String LANGUAGE_MODEL_FREE_FORM = "free_form";
    public static final String EXTRA_PREFER_OFFLINE = "prefer_offline";
    public static final String EXTRA_MAX_RESULTS = "max_results";
    public static final String EXTRA_AUDIO_SOURCE = "audio_source";
    public static final String EXTRA_AUDIO_SOURCE_CHANNEL_COUNT = "channel_count";
    public static final String EXTRA_AUDIO_SOURCE_ENCODING = "encoding";
    public static final String EXTRA_AUDIO_SOURCE_SAMPLING_RATE = "sampling_rate";
}
