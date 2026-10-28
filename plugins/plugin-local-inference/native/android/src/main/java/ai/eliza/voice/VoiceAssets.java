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

    private static InferenceSession shared;

    /**
     * The process-wide session for the installed bundle: one lazy owner for
     * speech output, recognition and VAD across this process's consumers.
     * Each consumer calls it through its own {@link InferenceSession#client},
     * whose cancel and release never fence or unload another consumer's calls;
     * consumers must not cancel, trim or close the shared session itself. A
     * closed shared session is replaced on the next call. Installs and verifies
     * the bundle on first use: call it on a worker thread.
     */
    public static synchronized InferenceSession sharedInference(Context context) throws IOException {
        if (shared == null || shared.isClosed()) shared = install(context).openInference();
        return shared;
    }

    public static synchronized Bundle install(Context context) throws IOException {
        VoiceBundleAssets.Installation installed = VoiceBundleAssets.install(context);
        return new Bundle(installed.root, installed.model, installed.lexicon, installed.espeakDir);
    }

    static String sha256(File file) throws IOException {
        return VoiceBundleAssets.sha256(file);
    }
}
