# Sherpa JNI resolves this concrete typed signature by name. Do not erase/rename it.
-keep class ai.eliza.speech.LocalSpeechEngine$SynthesisCallback {
    public java.lang.Integer invoke(float[]);
    public java.lang.Object invoke(java.lang.Object);
}
