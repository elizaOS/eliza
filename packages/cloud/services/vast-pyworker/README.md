# Vast inference worker

Python proxy for an Eliza-1 model server on Vast.ai. `onstart.sh`,
`onstart-vllm.sh`, and `manifests/` define deployment setup; install the Python
dependencies from `requirements.txt` in the target image.

There is no standalone build or local test suite. Validate the deployed worker's
health and model completion path with its actual GPU/model configuration.
