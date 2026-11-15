// Loads a GBNF grammar with a llama.cpp grammar parser and reports whether
// each input is a complete match. planner-grammar-class-loader.real.test.ts
// compiles it against the llama-grammar.cpp of each llama.cpp copy it checks.
// Usage: llama-grammar-loader <grammar-file> [input...]
// Prints LOADED or LOAD FAILED, then ACCEPT or REJECT for each input.
#include "llama-grammar.h"
#include "llama-impl.h"

#include <cstdarg>
#include <cstdio>
#include <exception>
#include <fstream>
#include <sstream>
#include <string>

// llama-grammar.cpp logs parse errors through llama_log_internal, which lives
// in llama-impl.cpp with the rest of the runtime. Print them to stderr.
// llama-cpp-capacitor renames the ggml types with an lm_ prefix.
#ifdef LM_GGML_MAX_DIMS
using llama_grammar_log_level = lm_ggml_log_level;
#else
using llama_grammar_log_level = ggml_log_level;
#endif

void llama_log_internal(llama_grammar_log_level, const char * format, ...) {
    va_list args;
    va_start(args, format);
    std::vfprintf(stderr, format, args);
    va_end(args);
}

int main(int argc, char ** argv) {
    if (argc < 2) {
        return 64;
    }
    std::ifstream file(argv[1], std::ios::binary);
    std::stringstream source;
    source << file.rdbuf();
    const std::string text = source.str();
    // The call the llama.cpp sampler makes; parsing needs no vocabulary.
    llama_grammar * grammar =
        llama_grammar_init_impl(nullptr, text.c_str(), "root", false, nullptr, 0, nullptr, 0);
    if (grammar == nullptr) {
        std::printf("LOAD FAILED\n");
        return 0;
    }
    std::printf("LOADED\n");
    for (int i = 2; i < argc; i++) {
        llama_grammar * attempt = llama_grammar_clone_impl(*grammar);
        bool complete = false;
        try {
            llama_grammar_accept_str(*attempt, argv[i]);
            for (const auto & stack : llama_grammar_get_stacks(attempt)) {
                if (stack.empty()) {
                    complete = true;
                }
            }
        } catch (const std::exception &) {
            // No grammar stack accepts the input.
        }
        std::printf("%s\n", complete ? "ACCEPT" : "REJECT");
        llama_grammar_free_impl(attempt);
    }
    llama_grammar_free_impl(grammar);
    return 0;
}
