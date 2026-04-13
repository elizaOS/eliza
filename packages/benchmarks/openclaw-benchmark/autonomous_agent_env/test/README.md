# Test Suite

This directory contains tests for the shell scripts in the `../scripts/` directory.

## hello.test.sh

Comprehensive test suite for `hello.sh` that verifies:

- Default behavior (outputs "hello" with no arguments)
- Custom message handling
- Multi-word message support
- Special character handling
- Help flag functionality (`--help` and `-h`)
- Input validation (whitespace-only rejection)
- Exit code behavior
- Script structure (executable, proper shebang, error handling)

## Running Tests

### Standalone Mode (Recommended)
```bash
./test/hello.test.sh
```

The test suite includes a standalone test runner that works in any bash environment.

### With BATS (Optional)
If you have BATS installed:
```bash
bats test/hello.test.sh
```

## Test Coverage

- ✅ Default output
- ✅ Custom messages
- ✅ Multi-word arguments
- ✅ Special characters
- ✅ Help functionality
- ✅ Input validation
- ✅ Error handling
- ✅ Exit codes
- ✅ Script structure

## Philosophy Compliance

The test suite follows the 5 Laws of Elegant Defense:

1. **Early Exit**: Tests validate edge cases and exit conditions
2. **Parse Don't Validate**: Tests verify that input parsing works correctly
3. **Atomic Predictability**: Each test is independent and deterministic
4. **Fail Fast**: Tests immediately fail when assertions don't match
5. **Intentional Naming**: Test function names clearly describe what they verify