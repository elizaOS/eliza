Host-JVM test doubles of the Android types `OnDeviceRecognizer` uses, so
`OnDeviceRecognizerProbeTest` can run the real class on the JVM. `SpeechRecognizer` is a scripted
recognition service, `Handler` posts to one serial "main" thread and `SystemClock` is a settable
clock. They are not Android: they prove the class's wiring to its availability policy, never a
recognition service, a model or a device. Test use only; never packaged.
