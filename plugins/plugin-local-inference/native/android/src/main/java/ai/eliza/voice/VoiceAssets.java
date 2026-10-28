package ai.eliza.voice;

import android.content.Context;
import java.io.File;
import java.io.IOException;

/** Compatibility facade for the shared installer and optional native session API. */
public final class VoiceAssets {
    public static final String ASSET_ROOT = VoiceBundleAssets.ASSET_ROOT;

    /** Installed file locations. */
    public static final class Bundle {
        /** Bundle root: pass it to {@link NativeAsr} when it has {@code asr/}. */
        public final File root;
        public final File model;
        public final File lexicon;
        /** Directory that contains {@code espeak-ng-data}, or null. */
        public final File espeakDir;

        Bundle(File root, File model, File lexicon, File espeakDir) {
            this.root = root;
            this.model = model;
            this.lexicon = lexicon;
            this.espeakDir = espeakDir;
        }

        /** One lifecycle owner for all modalities in this bundle. */
        public InferenceSession openInference() throws IOException {
            return new InferenceSession(root, model, lexicon, espeakDir);
        }

        public ParadeeVoice openVoice() throws IOException {
            return new ParadeeVoice(model, lexicon, espeakDir);
        }

        public NativeAsr openAsr() throws IOException {
            return new NativeAsr(root);
        }
    }

    private VoiceAssets() {}

    public static synchronized Bundle install(Context context) throws IOException {
        VoiceBundleAssets.Installation installed = VoiceBundleAssets.install(context);
        return new Bundle(installed.root, installed.model, installed.lexicon, installed.espeakDir);
    }

    static String sha256(File file) throws IOException {
        return VoiceBundleAssets.sha256(file);
    }
}
