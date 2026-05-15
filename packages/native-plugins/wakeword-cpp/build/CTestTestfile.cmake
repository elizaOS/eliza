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
