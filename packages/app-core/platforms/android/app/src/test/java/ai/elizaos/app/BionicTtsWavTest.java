/**
 * Verifies the bionic TTS transport's PCM16 WAV encoding byte-for-byte.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;

import org.junit.Test;

public class BionicTtsWavTest {

    @Test
    public void encodesValidMonoPcm16WavAndClampsSamples() {
        byte[] wav = ElizaBionicInferenceServer.encodeMonoPcm16Wav(
            new float[] {-2.0f, -0.25f, 0.25f, 2.0f},
            24_000);
        ByteBuffer view = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);

        assertArrayEquals(new byte[] {'R', 'I', 'F', 'F'}, slice(wav, 0, 4));
        assertEquals(44 + 8, wav.length);
        assertEquals(36 + 8, view.getInt(4));
        assertArrayEquals(new byte[] {'W', 'A', 'V', 'E'}, slice(wav, 8, 12));
        assertEquals(1, view.getShort(20));
        assertEquals(1, view.getShort(22));
        assertEquals(24_000, view.getInt(24));
        assertEquals(48_000, view.getInt(28));
        assertEquals(16, view.getShort(34));
        assertArrayEquals(new byte[] {'d', 'a', 't', 'a'}, slice(wav, 36, 40));
        assertEquals(8, view.getInt(40));
        assertEquals(Short.MIN_VALUE, view.getShort(44));
        assertEquals(-8192, view.getShort(46));
        assertEquals(8192, view.getShort(48));
        assertEquals(Short.MAX_VALUE, view.getShort(50));
    }

    @Test
    public void resolvesNestedKokoroAssetsWithStableVoicePreference() throws IOException {
        File root = Files.createTempDirectory("kokoro-assets").toFile();
        File voices = new File(root, "voices");
        if (!voices.mkdirs()) {
            throw new IOException("failed to create " + voices);
        }
        File model = new File(root, "kokoro-82m-v1_0.gguf");
        File fallbackVoice = new File(voices, "af_bella.bin");
        File defaultVoice = new File(voices, "af_same.bin");
        Files.write(model.toPath(), new byte[] {1});
        Files.write(fallbackVoice.toPath(), new byte[] {2});
        Files.write(defaultVoice.toPath(), new byte[] {3});

        assertEquals(model.getAbsolutePath(), ElizaBionicInferenceServer.resolveKokoroModel(root));
        assertEquals(
            defaultVoice.getAbsolutePath(),
            ElizaBionicInferenceServer.resolveKokoroVoice(root));
    }

    private static byte[] slice(byte[] source, int start, int end) {
        byte[] result = new byte[end - start];
        System.arraycopy(source, start, result, 0, result.length);
        return result;
    }
}
