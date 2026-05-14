// kokoro-file-picker.cpp: bundle-side discovery for the fused Kokoro engine.
//
// Read kokoro-file-picker.h for the contract. The implementation is
// deliberately small and side-effect-free: it never opens the GGUF, never
// validates the header, never logs. Validation happens at engine-load time
// in kokoro_engine_load() so the caller can hand a precise error message
// to the user.

#include "kokoro-file-picker.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <system_error>
#include <vector>

namespace {

std::string lower_ascii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return (char) std::tolower(c);
    });
    return value;
}

// Find the first file under `dir` whose name ends with `.gguf`. Returns
// empty string when none. Symlinks are followed; the lexicographic first
// match wins so the chooser is deterministic across filesystems.
std::string first_gguf_in(const std::filesystem::path & dir) {
    std::error_code ec;
    if (!std::filesystem::is_directory(dir, ec)) return {};

    std::vector<std::string> matches;
    for (auto & entry : std::filesystem::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        const std::string name = lower_ascii(entry.path().filename().string());
        if (name.size() >= 5 && name.substr(name.size() - 5) == ".gguf") {
            matches.push_back(entry.path().string());
        }
    }
    if (matches.empty()) return {};
    std::sort(matches.begin(), matches.end());
    return matches.front();
}

// Find the first `.bin` file under `dir`. Same deterministic-ordering
// rules. Used to resolve a default voice id when the bundle does not pin
// one in its manifest.
std::string first_voice_bin_in(const std::filesystem::path & dir) {
    std::error_code ec;
    if (!std::filesystem::is_directory(dir, ec)) return {};

    std::vector<std::string> matches;
    for (auto & entry : std::filesystem::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        const std::string name = lower_ascii(entry.path().filename().string());
        if (name.size() >= 4 && name.substr(name.size() - 4) == ".bin") {
            matches.push_back(entry.path().filename().string());
        }
    }
    if (matches.empty()) return {};
    std::sort(matches.begin(), matches.end());
    // Strip the .bin suffix; the voice id is the bare filename (e.g.
    // "af_bella.bin" -> "af_bella").
    std::string name = matches.front();
    name.resize(name.size() - 4);
    return name;
}

}  // namespace

bool eliza_pick_kokoro_files(const std::filesystem::path & bundle_dir,
                             std::string & gguf_path,
                             std::string & voices_dir,
                             std::string & default_voice_id) {
    const auto kokoro_dir = bundle_dir / "tts" / "kokoro";
    std::error_code ec;
    if (!std::filesystem::is_directory(kokoro_dir, ec)) return false;

    gguf_path = first_gguf_in(kokoro_dir);
    if (gguf_path.empty()) return false;

    const auto voices_path = kokoro_dir / "voices";
    if (!std::filesystem::is_directory(voices_path, ec)) return false;
    voices_dir = voices_path.string();

    default_voice_id = first_voice_bin_in(voices_path);
    if (default_voice_id.empty()) return false;

    return true;
}

bool eliza_bundle_has_kokoro_gguf(const std::filesystem::path & bundle_dir) {
    const auto kokoro_dir = bundle_dir / "tts" / "kokoro";
    std::error_code ec;
    if (!std::filesystem::is_directory(kokoro_dir, ec)) return false;
    return !first_gguf_in(kokoro_dir).empty();
}
