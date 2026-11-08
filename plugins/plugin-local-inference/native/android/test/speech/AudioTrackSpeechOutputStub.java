package ai.eliza.voice;

/** Host-JVM stand-in: the warm-up contract test injects its own output and never opens a track. */
final class AudioTrackSpeechOutput {
 static StreamingSpeechPlayback.Output open(int rate){throw new AssertionError("Android output is not used by this host test");}
}
