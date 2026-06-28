# #9581 — CUDA on-device VLM IMAGE_DESCRIPTION smoke (RTX 5080, sm_120)

Target built: `llama-mtmd-cli` (fork's mtmd vision CLI) into existing cuda-build (GGML_CUDA sm_120), 22s.

Model: gemma-4-E4B-it-Q8_0.gguf + mmproj-gemma-4-E4B-it-Q8_0.gguf (projector)
Image: 9581-paddleocr/test-image.png ("Eliza OCR 12345" repeated lines)
Cmd: llama-mtmd-cli -m <text> --mmproj <mmproj> --image <png> -p "Describe..." -ngl 99 --jinja
(--jinja REQUIRED: stock chat-template path throws "this custom template is not supported")

## CUDA backend proof
- llama_prepare_model_devices: using device CUDA0 (NVIDIA GeForce RTX 5080 Laptop GPU) - 15624 MiB free
- all model layers assigned to device CUDA0
- nvidia-smi during run: 90-92% GPU util, 8773 MiB VRAM used
- CUDA Graph reused (79 graphs), CUDA0 compute buffer 806 MiB
- perf: prompt eval 1159 tok/s / 311 tokens; gen eval 64.1 tok/s

## Output (coherent, correct)
VLM correctly identified the image as lines of text "Eliza OCR 12345" in
varying fonts, describing it as an OCR demonstration. Full text in run-paddleocr-image.log.
