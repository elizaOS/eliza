package ai.eliza.voice;

/** Host-JVM check of the on-device recognizer's language rules; no Android method runs. */
public final class RecognizerLanguageCheck {
    private static void refused(String tag) {
        try {
            OnDeviceRecognizer.requireLanguage(tag);
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("accepted " + tag);
    }

    public static void main(String[] args) {
        for (String tag : new String[] {"en-US", "es-US", "es", "es-419", "fil-PH"}) {
            if (!tag.equals(OnDeviceRecognizer.requireLanguage(tag))) throw new AssertionError(tag);
        }
        for (String tag : new String[] {null, "", "EN-us", "en_US", "en-", "spanish", "es-US;x", "a"}) refused(tag);
        if (!"en-US".equals(OnDeviceRecognizer.DEFAULT_LANGUAGE)) throw new AssertionError("default");
        System.out.println("PASS recognizer language tags");
    }
}
