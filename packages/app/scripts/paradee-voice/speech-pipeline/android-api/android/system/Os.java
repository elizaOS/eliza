package android.system;

/** Compile-only: VoiceNative's static setup names it; the probe test never loads VoiceNative. */
public final class Os {
    public static void setenv(String name, String value, boolean overwrite) throws ErrnoException {
        throw new UnsupportedOperationException("not Android");
    }
}
