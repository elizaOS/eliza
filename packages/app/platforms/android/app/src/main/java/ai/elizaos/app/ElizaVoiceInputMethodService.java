package ai.elizaos.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Uri;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import ai.elizaos.app.R;

/**
 * Voice-input keyboard for Eliza (FUTO Voice Input pattern).
 *
 * A compact, voice-only {@link InputMethodService} — no QWERTY. It presents a
 * mic button, a live level/state indicator, and a "switch back" affordance so a
 * user can hop straight back to their previous keyboard (declared via
 * {@code supportsSwitchingToNextInputMethod} in {@code res/xml/method.xml}). The
 * voice subtype ({@code imeSubtypeMode="voice"}) is what lets another keyboard's
 * mic long-press hand off to Eliza.
 *
 * Unlike iOS keyboard extensions (which the platform bars from the microphone),
 * Android IMEs may record audio while their input view is shown, so this service
 * records directly with {@link AudioRecord} (16 kHz mono PCM16), wraps the
 * captured PCM in a canonical WAV container, and transcribes it through the
 * on-device engine's loopback ASR route
 * ({@code POST http://127.0.0.1:31337/api/asr/local-inference}) — the same
 * fused Gemma ASR pipeline the app uses. The final transcript is inserted via
 * {@link InputConnection#commitText}.
 *
 * When the local engine is not reachable (loopback refused) or has no ASR model
 * staged, the keyboard shows an explicit, user-facing state — never a silent
 * failure — with an "Open Eliza" affordance that deep-links into the app
 * ({@code elizaos://voice?source=android-ime}) so the user can start/finish
 * on-device setup.
 */
public class ElizaVoiceInputMethodService extends InputMethodService {

    private static final String TAG = "ElizaVoiceIme";

    /** Distinct deep-link source tag so logs prove the IME entry point fired (D1). */
    static final String IME_DEEP_LINK =
            "elizaos://voice?source=android-ime&action=voice&voice=1";

    private static final int AGENT_PORT = 31337;
    private static final String ASR_STATUS_URL =
            "http://127.0.0.1:" + AGENT_PORT + "/api/asr/local-inference/status";
    private static final String ASR_TRANSCRIBE_URL =
            "http://127.0.0.1:" + AGENT_PORT + "/api/asr/local-inference";

    // ASR pipeline standard: 16 kHz mono PCM16.
    private static final int SAMPLE_RATE_HZ = 16_000;
    private static final int MAX_RECORD_MS = 60_000;
    private static final int STATUS_TIMEOUT_MS = 2_000;
    private static final int TRANSCRIBE_TIMEOUT_MS = 30_000;
    private static final int MAX_TRANSCRIBE_BODY_BYTES = 16 * 1024 * 1024;

    private enum UiState {
        IDLE,
        RECORDING,
        TRANSCRIBING,
        ENGINE_OFF,
        MODEL_NOT_READY,
        PERMISSION_NEEDED,
        ERROR
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean recording = new AtomicBoolean(false);

    private View rootView;
    private TextView stateLabel;
    private TextView hintLabel;
    private ImageButton micButton;
    private ImageButton switchButton;
    private ProgressBar levelMeter;

    private UiState uiState = UiState.IDLE;
    private volatile AudioRecord audioRecord;

    @Override
    public View onCreateInputView() {
        LayoutInflater inflater = LayoutInflater.from(this);
        rootView = inflater.inflate(R.layout.eliza_voice_ime, null);
        stateLabel = rootView.findViewById(R.id.eliza_ime_state);
        hintLabel = rootView.findViewById(R.id.eliza_ime_hint);
        micButton = rootView.findViewById(R.id.eliza_ime_mic);
        switchButton = rootView.findViewById(R.id.eliza_ime_switch);
        levelMeter = rootView.findViewById(R.id.eliza_ime_level);

        micButton.setOnClickListener(v -> onMicTapped());
        switchButton.setOnClickListener(v -> switchToPreviousKeyboard());
        return rootView;
    }

    @Override
    public void onStartInputView(EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        // Surface whether the previous-IME switch is even possible so the
        // affordance never dead-ends.
        boolean canSwitch = shouldOfferSwitchingToNextInputMethod();
        if (switchButton != null) {
            switchButton.setEnabled(canSwitch);
            switchButton.setAlpha(canSwitch ? 1f : 0.4f);
        }
        applyState(UiState.IDLE, getString(R.string.eliza_ime_prompt));
        refreshEngineStatus();
    }

    @Override
    public void onFinishInputView(boolean finishingInput) {
        stopRecording();
        super.onFinishInputView(finishingInput);
    }

    @Override
    public void onDestroy() {
        stopRecording();
        worker.shutdownNow();
        super.onDestroy();
    }

    // ── Mic button ───────────────────────────────────────────────────────

    private void onMicTapped() {
        switch (uiState) {
            case ENGINE_OFF:
            case MODEL_NOT_READY:
            case PERMISSION_NEEDED:
                openElizaApp();
                return;
            case RECORDING:
                stopRecording();
                return;
            case TRANSCRIBING:
                // Busy; ignore taps until the round-trip completes.
                return;
            default:
                beginRecordingFlow();
        }
    }

    private void beginRecordingFlow() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "[ElizaVoiceInputMethodService] RECORD_AUDIO not granted");
            applyState(UiState.PERMISSION_NEEDED,
                    getString(R.string.eliza_ime_permission_needed));
            return;
        }
        applyState(UiState.RECORDING, getString(R.string.eliza_ime_listening));
        worker.execute(this::recordLoop);
    }

    /**
     * Records mic audio into a PCM buffer until the user stops or the cap is
     * hit, publishing live input level to the meter, then hands the WAV to the
     * transcription round-trip. Runs on the worker thread.
     */
    private void recordLoop() {
        int minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) {
            Log.e(TAG, "[ElizaVoiceInputMethodService] AudioRecord unsupported buffer size " + minBuffer);
            postState(UiState.ERROR, getString(R.string.eliza_ime_error_mic));
            recording.set(false);
            return;
        }
        int bufferBytes = Math.max(minBuffer, SAMPLE_RATE_HZ / 5 * 2);
        AudioRecord record;
        try {
            record = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE_HZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferBytes);
        } catch (IllegalArgumentException | SecurityException e) {
            Log.e(TAG, "[ElizaVoiceInputMethodService] AudioRecord init failed", e);
            postState(UiState.ERROR, getString(R.string.eliza_ime_error_mic));
            recording.set(false);
            return;
        }
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "[ElizaVoiceInputMethodService] AudioRecord not initialized");
            record.release();
            postState(UiState.ERROR, getString(R.string.eliza_ime_error_mic));
            recording.set(false);
            return;
        }

        audioRecord = record;
        recording.set(true);
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        byte[] buffer = new byte[bufferBytes];
        long maxBytes = (long) SAMPLE_RATE_HZ * 2 * MAX_RECORD_MS / 1000;
        try {
            record.startRecording();
            while (recording.get() && pcm.size() < maxBytes) {
                int read = record.read(buffer, 0, buffer.length);
                if (read <= 0) {
                    continue;
                }
                pcm.write(buffer, 0, read);
                postLevel(peakLevel(buffer, read));
            }
        } catch (IllegalStateException e) {
            Log.e(TAG, "[ElizaVoiceInputMethodService] recording failed", e);
        } finally {
            recording.set(false);
            try {
                record.stop();
            } catch (IllegalStateException ignored) {
                // stop() throws only if never started; nothing to clean up.
            }
            record.release();
            audioRecord = null;
        }
        postLevel(0);

        byte[] pcmBytes = pcm.toByteArray();
        if (pcmBytes.length < SAMPLE_RATE_HZ / 2 * 2) {
            // Under ~0.5 s of audio — treat as an accidental tap, reset quietly.
            Log.i(TAG, "[ElizaVoiceInputMethodService] discarded short capture (" + pcmBytes.length + " bytes)");
            postState(UiState.IDLE, getString(R.string.eliza_ime_prompt));
            return;
        }
        postState(UiState.TRANSCRIBING, getString(R.string.eliza_ime_transcribing));
        transcribeAndCommit(wrapPcmAsWav(pcmBytes));
    }

    private void stopRecording() {
        if (recording.getAndSet(false)) {
            Log.i(TAG, "[ElizaVoiceInputMethodService] stop recording requested");
        }
    }

    // ── Transcription round-trip ─────────────────────────────────────────

    private void transcribeAndCommit(byte[] wav) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(ASR_TRANSCRIBE_URL);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(STATUS_TIMEOUT_MS);
            conn.setReadTimeout(TRANSCRIBE_TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(wav.length);
            conn.setRequestProperty("Content-Type", "audio/wav");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(wav);
            }
            int status = conn.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, "[ElizaVoiceInputMethodService] ASR responded " + status);
                if (status == 503) {
                    postState(UiState.MODEL_NOT_READY,
                            getString(R.string.eliza_ime_model_not_ready));
                } else {
                    postState(UiState.ERROR, getString(R.string.eliza_ime_error_transcribe));
                }
                return;
            }
            String body = readBody(conn.getInputStream());
            String text = new JSONObject(body).optString("text", "").trim();
            if (text.isEmpty()) {
                Log.i(TAG, "[ElizaVoiceInputMethodService] empty transcript");
                postState(UiState.IDLE, getString(R.string.eliza_ime_no_speech));
                return;
            }
            Log.i(TAG, "[ElizaVoiceInputMethodService] transcript committed (" + text.length() + " chars)");
            postCommit(text);
        } catch (IOException e) {
            // Connection refused / timeout → the loopback engine isn't up.
            Log.w(TAG, "[ElizaVoiceInputMethodService] ASR loopback unreachable: " + e.getMessage());
            postState(UiState.ENGINE_OFF, getString(R.string.eliza_ime_engine_off));
        } catch (Exception e) {
            Log.e(TAG, "[ElizaVoiceInputMethodService] transcription error", e);
            postState(UiState.ERROR, getString(R.string.eliza_ime_error_transcribe));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Probes the loopback ASR readiness so the keyboard shows the right resting
     * state before the user taps the mic (engine up + model staged vs. not).
     * Runs on the worker thread; never blocks the mic tap itself.
     */
    private void refreshEngineStatus() {
        worker.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(ASR_STATUS_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(STATUS_TIMEOUT_MS);
                conn.setReadTimeout(STATUS_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                int status = conn.getResponseCode();
                if (status < 200 || status >= 300) {
                    postState(UiState.MODEL_NOT_READY,
                            getString(R.string.eliza_ime_model_not_ready));
                    return;
                }
                boolean ready = new JSONObject(readBody(conn.getInputStream()))
                        .optBoolean("ready", false);
                if (ready) {
                    postState(UiState.IDLE, getString(R.string.eliza_ime_prompt));
                } else {
                    postState(UiState.MODEL_NOT_READY,
                            getString(R.string.eliza_ime_model_not_ready));
                }
            } catch (IOException e) {
                Log.i(TAG, "[ElizaVoiceInputMethodService] engine status unreachable: " + e.getMessage());
                postState(UiState.ENGINE_OFF, getString(R.string.eliza_ime_engine_off));
            } catch (Exception e) {
                Log.w(TAG, "[ElizaVoiceInputMethodService] engine status error", e);
                postState(UiState.ENGINE_OFF, getString(R.string.eliza_ime_engine_off));
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    // ── Open-the-app fallback ────────────────────────────────────────────

    private void openElizaApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(IME_DEEP_LINK));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Log.i(TAG, "[ElizaVoiceInputMethodService] opening Eliza: " + IME_DEEP_LINK);
        startActivity(intent);
    }

    private void switchToPreviousKeyboard() {
        Log.i(TAG, "[ElizaVoiceInputMethodService] switching back to previous keyboard");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            if (switchToPreviousInputMethod()) return;
        }
        switchToNextInputMethod(false);
    }

    // ── UI thread plumbing ───────────────────────────────────────────────

    private void postState(UiState next, String label) {
        mainHandler.post(() -> applyState(next, label));
    }

    private void postLevel(int level) {
        mainHandler.post(() -> {
            if (levelMeter != null) levelMeter.setProgress(level);
        });
    }

    private void postCommit(String text) {
        mainHandler.post(() -> {
            InputConnection ic = getCurrentInputConnection();
            if (ic != null) {
                ic.commitText(text, 1);
            }
            applyState(UiState.IDLE, getString(R.string.eliza_ime_prompt));
        });
    }

    private void applyState(UiState next, String label) {
        uiState = next;
        if (stateLabel != null) stateLabel.setText(label);
        if (micButton != null) {
            boolean actionOpensApp = next == UiState.ENGINE_OFF
                    || next == UiState.MODEL_NOT_READY
                    || next == UiState.PERMISSION_NEEDED;
            micButton.setActivated(next == UiState.RECORDING);
            micButton.setImageResource(actionOpensApp
                    ? R.drawable.ic_eliza_ime_open
                    : R.drawable.ic_eliza_ime_mic);
            micButton.setContentDescription(label);
        }
        if (levelMeter != null && next != UiState.RECORDING) {
            levelMeter.setProgress(0);
        }
        if (hintLabel != null) {
            hintLabel.setText(getString(R.string.eliza_ime_hint));
        }
    }

    // ── Audio helpers ────────────────────────────────────────────────────

    private static int peakLevel(byte[] pcm, int lengthBytes) {
        int peak = 0;
        for (int i = 0; i + 1 < lengthBytes; i += 2) {
            int sample = (short) ((pcm[i] & 0xFF) | (pcm[i + 1] << 8));
            int magnitude = Math.abs(sample);
            if (magnitude > peak) peak = magnitude;
        }
        return Math.min(100, peak * 100 / 32_767);
    }

    /** Wrap raw little-endian PCM16 mono samples in a canonical 44-byte WAV header. */
    private static byte[] wrapPcmAsWav(byte[] pcm) {
        int dataLen = pcm.length;
        int byteRate = SAMPLE_RATE_HZ * 2; // mono * 16-bit
        ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        header.putInt(36 + dataLen);
        header.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        header.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        header.putInt(16);            // PCM fmt chunk size
        header.putShort((short) 1);   // audioFormat = PCM
        header.putShort((short) 1);   // channels = mono
        header.putInt(SAMPLE_RATE_HZ);
        header.putInt(byteRate);
        header.putShort((short) 2);   // block align = channels * bytesPerSample
        header.putShort((short) 16);  // bits per sample
        header.put("data".getBytes(StandardCharsets.US_ASCII));
        header.putInt(dataLen);

        byte[] wav = new byte[44 + dataLen];
        System.arraycopy(header.array(), 0, wav, 0, 44);
        System.arraycopy(pcm, 0, wav, 44, dataLen);
        return wav;
    }

    private static String readBody(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int total = 0;
            int n;
            while ((n = input.read(buf)) >= 0) {
                total += n;
                if (total > MAX_TRANSCRIBE_BODY_BYTES) {
                    throw new IOException("ASR response body is too large");
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
