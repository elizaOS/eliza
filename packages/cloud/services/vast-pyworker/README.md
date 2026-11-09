# Vast inference worker

Python proxy for an Eliza-1 model server on Vast.ai. `onstart.sh`,
`onstart-vllm.sh`, and `manifests/` define deployment setup; install the Python
dependencies from `requirements.txt` in the target image.

After installing `requirements.txt`, run `python -m unittest discover -s tests`
from this directory. Validate the deployed worker's health and model completion
path with its actual GPU/model configuration before rollout. The local tests do
not exercise a GPU or prove the model server's readiness log grammar.

The vLLM metrics/heartbeat supervisor reuses a lock beside `VLLM_STATS_PATH` and
appends to existing JSONL. Restart the container when upgrading from the legacy
untracked background loops; they do not hold the new ownership lock.
