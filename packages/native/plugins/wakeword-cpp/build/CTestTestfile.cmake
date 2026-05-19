# CMake generated Testfile for 
# Source directory: /home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp
# Build directory: /home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test(wakeword_stub_smoke "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword_stub_smoke")
set_tests_properties(wakeword_stub_smoke PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;46;add_test;/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;0;")
add_test(wakeword_melspec_test "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword_melspec_test")
set_tests_properties(wakeword_melspec_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;52;add_test;/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;0;")
add_test(wakeword_window_test "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword_window_test")
set_tests_properties(wakeword_window_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;58;add_test;/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;0;")
add_test(wakeword_runtime_test "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword_runtime_test" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword/hey-eliza.melspec.gguf" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword/hey-eliza.embedding.gguf" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword/hey-eliza.classifier.gguf")
set_tests_properties(wakeword_runtime_test PROPERTIES  _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;71;add_test;/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;0;")
add_test(wakeword_parity_test "/usr/bin/python3" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/test/wakeword_parity_test.py" "--libwakeword" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/libwakeword.so" "--gguf-dir" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/build/wakeword" "--phrase-slug" "hey-eliza" "--onnx-dir" "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/../../../artifacts/hf-eliza1-voice-consolidation/voice/wakeword" "--classifier-onnx" "hey-eliza-int8.onnx")
set_tests_properties(wakeword_parity_test PROPERTIES  SKIP_RETURN_CODE "77" _BACKTRACE_TRIPLES "/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;86;add_test;/home/shaw/milady/eliza/packages/native-plugins/wakeword-cpp/CMakeLists.txt;0;")
