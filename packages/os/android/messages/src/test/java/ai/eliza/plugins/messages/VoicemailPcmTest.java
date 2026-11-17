package ai.eliza.plugins.messages;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import org.junit.Test;

/**
 * JVM checks of the WAV header and the 16 kHz mono conversion. The MediaExtractor/MediaCodec decode
 * needs a device codec and is not exercised here.
 */
public final class VoicemailPcmTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

 /** The 16 kHz mono samples of {@code input} fed in chunks of {@code chunk} interleaved samples. */
 static short[] convert(short[] input, int rate, int channels, int chunk) throws Exception {
  VoicemailPcm.Output out = new VoicemailPcm.Output();
  VoicemailPcm.Resampler resampler = new VoicemailPcm.Resampler(rate, channels);
  for (int at = 0; at < input.length; at += chunk) {
   short[] part = Arrays.copyOfRange(input, at, Math.min(input.length, at + chunk));
   resampler.feed(part, part.length, out);
  }
  resampler.finish(out);
  byte[] wav = out.wav();
  short[] samples = new short[out.samples()];
  ByteBuffer.wrap(wav, VoicemailPcm.WAV_HEADER_BYTES, wav.length - VoicemailPcm.WAV_HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples);
  require(wav.length == VoicemailPcm.WAV_HEADER_BYTES + samples.length * 2, "header plus two bytes per sample");
  return samples;
 }

 @Test public void wavHeaderDescribesSixteenKilohertzMonoPcm16() {
  byte[] header = VoicemailPcm.wavHeader(32000);
  ByteBuffer b = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN);
  require(header.length == 44, "44 bytes");
  require(new String(header, 0, 4).equals("RIFF") && new String(header, 8, 8).equals("WAVEfmt ") && new String(header, 36, 4).equals("data"), "chunk names");
  require(b.getInt(4) == 36 + 32000 && b.getInt(16) == 16 && b.getInt(40) == 32000, "chunk sizes");
  require(b.getShort(20) == 1 && b.getShort(22) == 1 && b.getInt(24) == 16000, "PCM, mono, 16 kHz");
  require(b.getInt(28) == 32000 && b.getShort(32) == 2 && b.getShort(34) == 16, "byte rate, block align, bits");
  require(VoicemailPcm.wavHeader(0).length == 44, "empty data is still a header");
  for (int bad : new int[] { -2, 3, VoicemailPcm.MAX_WAV_BYTES }) {
   try { VoicemailPcm.wavHeader(bad); } catch (IllegalArgumentException expected) { continue; }
   throw new AssertionError("length " + bad + " refused");
  }
 }

 @Test public void resamplingInterpolatesHoldsTheLastSampleAndIgnoresChunking() throws Exception {
  short[] ramp = { 0, 100, 200, 300, -32768, 32767 };
  require(Arrays.equals(convert(ramp, 16000, 1, 6), ramp), "16 kHz mono passes through, extremes included");
  require(Arrays.equals(convert(new short[] { 0, 100, 200 }, 8000, 1, 3), new short[] { 0, 50, 100, 150, 200, 200 }), "8 kHz doubles with midpoints, last sample held");
  require(Arrays.equals(convert(new short[] { 0, 1, 2, 3, 4, 5, 6 }, 48000, 1, 7), new short[] { 0, 3, 6 }), "48 kHz keeps every third sample");
  require(Arrays.equals(convert(new short[] { 100, 300, -50, -150, 7, 8 }, 16000, 2, 6), new short[] { 200, -100, 8 }), "stereo is averaged to mono");
  require(convert(new short[0], 8000, 1, 1).length == 0, "no input, no output");

  short[] speech = new short[801];
  for (int i = 0; i < speech.length; i++) speech[i] = (short) Math.round(12000 * Math.sin(i * 0.37));
  for (int rate : new int[] { 8000, 16000, 32000, 48000 }) {
   short[] whole = convert(speech, rate, 1, speech.length);
   require(whole.length == (int) Math.ceil(speech.length * 16000.0 / rate), rate + " Hz gives the expected sample count");
   for (int chunk : new int[] { 1, 7, 160, 800 }) require(Arrays.equals(convert(speech, rate, 1, chunk), whole), rate + " Hz in chunks of " + chunk + " equals one pass");
  }
  try { new VoicemailPcm.Resampler(16000, 2).feed(new short[3], 3, new VoicemailPcm.Output()); }
  catch (IllegalArgumentException expected) { return; }
  throw new AssertionError("a partial frame is refused");
 }

 @Test public void audioPastFiveMinutesIsRefusedWholeNotClipped() throws Exception {
  VoicemailPcm.Output out = new VoicemailPcm.Output();
  VoicemailPcm.Resampler resampler = new VoicemailPcm.Resampler(16000, 1);
  short[] second = new short[16000];
  for (int i = 0; i < VoicemailPcm.MAX_SECONDS; i++) resampler.feed(second, second.length, out);
  resampler.finish(out);
  require(out.samples() == VoicemailPcm.MAX_SECONDS * VoicemailPcm.SAMPLE_RATE, "exactly five minutes fits");
  require(out.wav().length <= VoicemailPcm.MAX_WAV_BYTES, "and stays under the size bound");
  try { out.write((short) 1); } catch (VoicemailStore.Refused refused) { require(refused.code.equals("too-long"), "typed"); return; }
  throw new AssertionError("one sample more is refused");
 }
}
