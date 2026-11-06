package android.speech;

public interface RecognitionSupportCallback {
    void onSupportResult(RecognitionSupport support);

    void onError(int error);
}
