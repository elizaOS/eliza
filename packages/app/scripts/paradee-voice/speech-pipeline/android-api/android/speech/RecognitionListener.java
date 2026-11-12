package android.speech;

import android.os.Bundle;

public interface RecognitionListener {
    void onResults(Bundle results);

    void onError(int error);

    void onReadyForSpeech(Bundle params);

    void onBeginningOfSpeech();

    void onRmsChanged(float rmsdB);

    void onBufferReceived(byte[] buffer);

    void onEndOfSpeech();

    void onPartialResults(Bundle partialResults);

    void onEvent(int eventType, Bundle params);
}
