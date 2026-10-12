// SPDX-License-Identifier: MIT
// English text to Kokoro-82M phoneme symbols with eSpeak NG (en-us).
#pragma once

#include <string>
#include <vector>

namespace eliza_kokoro_voice {

// Starts eSpeak NG once per process. `data_root` is the directory that
// contains `espeak-ng-data`. Later calls must pass the same directory.
bool g2p_init(const std::string & data_root, std::string * error);

// Phonemizes UTF-8 text. Each returned phrase has at most `max_symbols`
// Unicode code points. Clause punctuation from the text is kept.
std::vector<std::string> g2p_phrases(const std::string & text, size_t max_symbols,
                                     std::string * error);

}  // namespace eliza_kokoro_voice
