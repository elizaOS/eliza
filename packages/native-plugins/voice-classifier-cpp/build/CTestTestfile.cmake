# CMake generated Testfile for 
# Source directory: /home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp
# Build directory: /home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test(voice_classifier_stub_smoke "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_classifier_stub_smoke")
set_tests_properties(voice_classifier_stub_smoke PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;77;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_emotion_classes_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_emotion_classes_test")
set_tests_properties(voice_emotion_classes_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;82;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_speaker_distance_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_speaker_distance_test")
set_tests_properties(voice_speaker_distance_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;87;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_mel_features_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_mel_features_test")
set_tests_properties(voice_mel_features_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;92;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_gguf_loader_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_gguf_loader_test")
set_tests_properties(voice_gguf_loader_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;100;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_diarizer_parity_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_diarizer_parity_test")
set_tests_properties(voice_diarizer_parity_test PROPERTIES  WORKING_DIRECTORY "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build" _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;110;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
add_test(voice_speaker_parity_test "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/build/voice_speaker_parity_test" "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/../../../models/voice/speaker/wespeaker-resnet34-lm-fp32.gguf")
set_tests_properties(voice_speaker_parity_test PROPERTIES  SKIP_RETURN_CODE "77" _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;125;add_test;/home/shaw/milady/eliza/packages/native-plugins/voice-classifier-cpp/CMakeLists.txt;0;")
