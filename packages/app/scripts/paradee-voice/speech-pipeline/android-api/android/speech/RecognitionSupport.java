package android.speech;

import java.util.List;

public class RecognitionSupport {
    private final List<String> installed;

    public RecognitionSupport(List<String> installed) {
        this.installed = installed;
    }

    public List<String> getInstalledOnDeviceLanguages() {
        return installed;
    }
}
