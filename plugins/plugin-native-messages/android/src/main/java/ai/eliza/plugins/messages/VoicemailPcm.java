package ai.eliza.plugins.messages;

import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.CancellationSignal;

import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;

/**
 * Decodes one stored voicemail (usually AMR or 3GPP, which a WebView cannot decode) to 16 kHz mono
 * 16-bit PCM in a WAV container, for on-device transcription. The platform's MediaExtractor and
 * MediaCodec decode; {@link Resampler} mixes to mono and converts the rate by linear interpolation
 * (no low-pass filter: fit for speech, not for music). Audio longer than {@link #MAX_SECONDS} or a
 * result over {@link #MAX_WAV_BYTES} is refused whole, never clipped. Call {@link #decode} off the
 * main thread; it stops when the caller's CancellationSignal fires.
 */
@androidx.annotation.RequiresApi(29)
public final class VoicemailPcm {
 private VoicemailPcm() {}
 public static final int SAMPLE_RATE = 16000, MAX_SECONDS = 300, MAX_WAV_BYTES = 10 * 1024 * 1024, WAV_HEADER_BYTES = 44;
 /** A decode that makes no progress for this long fails instead of holding the reader thread. */
 private static final long STALL_MS = 15_000;

 static VoicemailStore.Refused tooLong() { return new VoicemailStore.Refused("too-long", "This voicemail is too long to transcribe here"); }
 static VoicemailStore.Refused tooLarge() { return new VoicemailStore.Refused("too-large", "This voicemail is too large to transcribe here"); }
 static VoicemailStore.Refused undecodable() { return new VoicemailStore.Refused("undecodable", "This voicemail's audio could not be decoded on this phone"); }

 /** The 44-byte RIFF/WAVE header of {@code dataBytes} of 16 kHz mono 16-bit little-endian PCM. */
 public static byte[] wavHeader(int dataBytes) {
  if (dataBytes < 0 || dataBytes % 2 != 0 || dataBytes > MAX_WAV_BYTES - WAV_HEADER_BYTES) throw new IllegalArgumentException("Invalid PCM length");
  ByteBuffer header = ByteBuffer.allocate(WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN);
  header.put(new byte[] { 'R', 'I', 'F', 'F' }).putInt(36 + dataBytes).put(new byte[] { 'W', 'A', 'V', 'E' });
  header.put(new byte[] { 'f', 'm', 't', ' ' }).putInt(16).putShort((short) 1 /* PCM */).putShort((short) 1 /* mono */);
  header.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2 /* bytes per second */).putShort((short) 2 /* block align */).putShort((short) 16 /* bits */);
  header.put(new byte[] { 'd', 'a', 't', 'a' }).putInt(dataBytes);
  return header.array();
 }

 /** The bounded 16 kHz mono output. One sample past {@link #MAX_SECONDS} refuses the whole decode. */
 static final class Output {
  private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
  private int samples;
  void write(short sample) throws VoicemailStore.Refused {
   if (samples >= MAX_SECONDS * SAMPLE_RATE) throw tooLong();
   if (WAV_HEADER_BYTES + (samples + 1) * 2 > MAX_WAV_BYTES) throw tooLarge();
   bytes.write(sample & 0xff); bytes.write((sample >> 8) & 0xff);
   samples++;
  }
  int samples() { return samples; }
  /** The complete WAV file. */
  byte[] wav() {
   byte[] data = bytes.toByteArray(), out = new byte[WAV_HEADER_BYTES + data.length];
   System.arraycopy(wavHeader(data.length), 0, out, 0, WAV_HEADER_BYTES);
   System.arraycopy(data, 0, out, WAV_HEADER_BYTES, data.length);
   return out;
  }
 }

 /**
  * Streams interleaved 16-bit frames of any rate and channel count to 16 kHz mono. Channels are
  * averaged; output sample k is the linear interpolation of the input at time k / 16000, and the
  * last input sample is held to the end, so n input frames give round-up(n * 16000 / rate) samples
  * however the input is split into chunks.
  */
 static final class Resampler {
  private final int channels; private final double step;
  /** Position of the next output sample, in input frames from the start of the next chunk (-1 is the previous chunk's last frame). */
  private double position;
  private int previous; private boolean started;
  Resampler(int rate, int channels) {
   if (rate < 4000 || rate > 192000 || channels < 1 || channels > 8) throw new IllegalArgumentException("Unsupported audio format");
   this.channels = channels; this.step = (double) rate / SAMPLE_RATE;
  }
  private int frame(short[] interleaved, int index) {
   int sum = 0;
   for (int c = 0; c < channels; c++) sum += interleaved[index * channels + c];
   return Math.round((float) sum / channels);
  }
  void feed(short[] interleaved, int count, Output out) throws VoicemailStore.Refused {
   if (count % channels != 0) throw new IllegalArgumentException("Partial audio frame");
   int frames = count / channels;
   if (frames == 0) return;
   while (position < frames - 1) {
    int index = (int) Math.floor(position);
    double fraction = position - index;
    int a = index < 0 ? previous : frame(interleaved, index), b = frame(interleaved, index + 1);
    out.write((short) Math.round(a + (b - a) * fraction));
    position += step;
   }
   previous = frame(interleaved, frames - 1); started = true;
   position -= frames;
  }
  /** Writes the samples that fall at or after the last input frame. */
  void finish(Output out) throws VoicemailStore.Refused {
   if (!started) return;
   for (; position < -1e-9; position += step) out.write((short) previous);
  }
 }

 /**
  * Decodes the audio at {@code uri} to {@code {mimeType: "audio/wav", sampleRateHz: 16000,
  * durationSeconds, data}} with {@code data} the WAV file in base64. Refuses with "too-long",
  * "too-large" or "undecodable"; cancellation throws OperationCanceledException.
  */
 public static JSObject decode(Context context, Uri uri, CancellationSignal cancel) throws VoicemailStore.Refused {
  MediaExtractor extractor = new MediaExtractor();
  MediaCodec codec = null;
  Output out = new Output();
  try {
   extractor.setDataSource(context, uri, null);
   MediaFormat format = null; String mime = null;
   for (int i = 0; i < extractor.getTrackCount() && format == null; i++) {
    MediaFormat track = extractor.getTrackFormat(i);
    String type = track.getString(MediaFormat.KEY_MIME);
    if (type != null && type.startsWith("audio/")) { format = track; mime = type; extractor.selectTrack(i); }
   }
   if (format == null) throw undecodable();
   if (format.containsKey(MediaFormat.KEY_DURATION) && format.getLong(MediaFormat.KEY_DURATION) > MAX_SECONDS * 1_000_000L) throw tooLong();
   int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE), channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
   codec = MediaCodec.createDecoderByType(mime);
   codec.configure(format, null, null, 0);
   codec.start();
   MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
   Resampler resampler = null;
   boolean inputDone = false, outputDone = false;
   long progress = android.os.SystemClock.elapsedRealtime();
   while (!outputDone) {
    cancel.throwIfCanceled();
    if (android.os.SystemClock.elapsedRealtime() - progress > STALL_MS) throw undecodable();
    if (!inputDone) {
     int in = codec.dequeueInputBuffer(10_000);
     if (in >= 0) {
      ByteBuffer buffer = codec.getInputBuffer(in);
      int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
      if (size < 0) { codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true; }
      else { codec.queueInputBuffer(in, 0, size, extractor.getSampleTime(), 0); extractor.advance(); }
      progress = android.os.SystemClock.elapsedRealtime();
     }
    }
    int index = codec.dequeueOutputBuffer(info, 10_000);
    if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
     MediaFormat decoded = codec.getOutputFormat();
     if (decoded.containsKey(MediaFormat.KEY_PCM_ENCODING) && decoded.getInteger(MediaFormat.KEY_PCM_ENCODING) != AudioFormat.ENCODING_PCM_16BIT) throw undecodable();
     // A format change after samples were written would splice two rates; no voicemail codec does it.
     if (resampler != null) throw undecodable();
     rate = decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE); channels = decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
    } else if (index >= 0) {
     ByteBuffer buffer = codec.getOutputBuffer(index);
     if (buffer != null && info.size > 0) {
      if (resampler == null) resampler = new Resampler(rate, channels);
      buffer.position(info.offset).limit(info.offset + info.size);
      ShortBuffer samples = buffer.order(ByteOrder.nativeOrder()).asShortBuffer();
      short[] chunk = new short[samples.remaining()];
      samples.get(chunk);
      resampler.feed(chunk, chunk.length - chunk.length % channels, out);
     }
     codec.releaseOutputBuffer(index, false);
     if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
     progress = android.os.SystemClock.elapsedRealtime();
    }
   }
   if (resampler != null) resampler.finish(out);
  } catch (java.io.IOException | IllegalStateException | IllegalArgumentException | NullPointerException unreadable) {
   // No audio track, no decoder for it, or a codec error: typed, so it is not mistaken for missing access.
   throw undecodable();
  } finally {
   if (codec != null) { try { codec.stop(); } catch (RuntimeException stopped) { /* Already failed or never started. */ } codec.release(); }
   extractor.release();
  }
  if (out.samples() == 0) throw undecodable();
  JSObject value = new JSObject();
  value.put("mimeType", "audio/wav"); value.put("sampleRateHz", SAMPLE_RATE);
  value.put("durationSeconds", Math.round(out.samples() * 1000.0 / SAMPLE_RATE) / 1000.0);
  value.put("data", java.util.Base64.getEncoder().encodeToString(out.wav()));
  return value;
 }
}
