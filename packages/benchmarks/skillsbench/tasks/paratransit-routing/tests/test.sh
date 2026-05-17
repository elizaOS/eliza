#!/bin/bash

# Verifier dependencies are installed in the environment image so tests can run
# when task sandbox internet is disabled.

unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS OPENAI_API_KEY ANTHROPIC_API_KEY

python3 - <<'PY'
import importlib

for module in ["pytest", "numpy", "pandas", "ortools"]:
    importlib.import_module(module)
PY

mkdir -p /logs/verifier

pytest --ctrf /logs/verifier/ctrf.json /tests/test_outputs.py -rA -v

if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi

exit 0
