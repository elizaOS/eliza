// SPDX-License-Identifier: MIT
// English text to Kokoro-82M phoneme symbols with eSpeak NG (en-us).
//
// The output is eSpeak IPA, the same symbols the agent's phonemizer sends
// today, plus the clause punctuation that eSpeak drops. A misaki-style symbol
// rewrite (eɪ -> A, tʃ -> ʧ, ...) was measured and did not improve Whisper
// word error rate on the fork's Kokoro GGUF, so it is not applied.

#include "kokoro-g2p.h"

#include <espeak-ng/speak_lib.h>

#include <cstring>
#include <mutex>

namespace eliza_kokoro_voice {
namespace {

std::mutex & espeak_mutex() {
    static std::mutex m;
    return m;
}

std::string g_data_root;
bool g_ready = false;

size_t codepoints(const std::string & s) {
    size_t n = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0u) != 0x80u) ++n;
    }
    return n;
}

std::string trim(const std::string & s) {
    const size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return std::string();
    const size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// Splits one over-long phrase at word spaces. A single word longer than the
// limit is an error, because Kokoro cannot read it in one pass.
bool split_words(const std::string & phrase, size_t max_symbols,
                 std::vector<std::string> & out, std::string * error) {
    std::string current;
    size_t start = 0;
    while (start < phrase.size()) {
        size_t end = phrase.find(' ', start);
        if (end == std::string::npos) end = phrase.size();
        const std::string word = phrase.substr(start, end - start);
        start = end + 1;
        if (word.empty()) continue;
        if (codepoints(word) > max_symbols) {
            if (error) *error = "a word is too long for one Kokoro phrase";
            return false;
        }
        if (!current.empty() && codepoints(current) + 1 + codepoints(word) > max_symbols) {
            out.push_back(current);
            current.clear();
        }
        if (!current.empty()) current.push_back(' ');
        current += word;
    }
    if (!current.empty()) out.push_back(current);
    return true;
}

}  // namespace

bool g2p_init(const std::string & data_root, std::string * error) {
    std::lock_guard<std::mutex> lock(espeak_mutex());
    if (g_ready) {
        if (data_root != g_data_root) {
            if (error) *error = "eSpeak NG already started with a different data directory";
            return false;
        }
        return true;
    }
    const int rate = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data_root.c_str(),
                                       espeakINITIALIZE_DONT_EXIT);
    if (rate < 0) {
        if (error) *error = "eSpeak NG did not start; check espeak-ng-data under " + data_root;
        return false;
    }
    if (espeak_SetVoiceByName("en-us") != EE_OK) {
        if (error) *error = "eSpeak NG has no en-us voice under " + data_root;
        return false;
    }
    g_data_root = data_root;
    g_ready = true;
    return true;
}

std::vector<std::string> g2p_phrases(const std::string & text, size_t max_symbols,
                                     std::string * error) {
    std::vector<std::string> clauses;
    {
        std::lock_guard<std::mutex> lock(espeak_mutex());
        if (!g_ready) {
            if (error) *error = "eSpeak NG is not started";
            return {};
        }
        const int mode = espeakPHONEMES_IPA;
        // eSpeak returns phonemes without the clause punctuation that Kokoro
        // uses for pauses and intonation. Cut the text after , . ! ? ; : when
        // a space or the end follows ("3:30" and "1,000" stay whole), then put
        // the mark back after the phonemes of that clause.
        size_t start = 0;
        while (start < text.size()) {
            size_t end = start;
            char punct = 0;
            while (end < text.size()) {
                const char c = text[end];
                const bool boundary = end + 1 == text.size() || text[end + 1] == ' ' ||
                                      text[end + 1] == '\n' || text[end + 1] == '\t';
                ++end;
                if (std::strchr(",.!?;:", c) != nullptr && boundary) {
                    punct = c;
                    break;
                }
            }
            const std::string piece = text.substr(start, end - start);
            start = end;
            std::string clause;
            const void * cursor = piece.c_str();
            while (cursor != nullptr) {
                const char * ipa = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8, mode);
                if (ipa == nullptr) break;
                const std::string part = trim(ipa);
                if (part.empty()) continue;
                if (!clause.empty()) clause.push_back(' ');
                clause += part;
            }
            if (clause.empty()) continue;
            if (punct) clause.push_back(punct);
            clauses.push_back(clause);
        }
    }
    if (clauses.empty()) {
        if (error) *error = "the text has no English words to speak";
        return {};
    }
    std::vector<std::string> phrases;
    std::string current;
    for (const std::string & clause : clauses) {
        if (codepoints(clause) > max_symbols) {
            if (!current.empty()) phrases.push_back(current);
            current.clear();
            if (!split_words(clause, max_symbols, phrases, error)) return {};
            continue;
        }
        if (!current.empty() && codepoints(current) + 1 + codepoints(clause) > max_symbols) {
            phrases.push_back(current);
            current.clear();
        }
        if (!current.empty()) current.push_back(' ');
        current += clause;
    }
    if (!current.empty()) phrases.push_back(current);
    return phrases;
}

}  // namespace eliza_kokoro_voice
