#!/usr/bin/env python3
import os
import time
from pathlib import Path

try:
    from llama_cpp import Llama

    HAS_LLAMA_CPP = True
except ImportError:
    HAS_LLAMA_CPP = False
    print("⚠️  llama-cpp-python not installed. Install with: pip install llama-cpp-python")

MODELS_DIR = Path.home() / ".eliza" / "models"
SMALL_MODEL = "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
EMBEDDING_MODEL = "bge-small-en-v1.5.Q4_K_M.gguf"


def test_text_generation() -> None:
    print("\n🧪 Testing Python Text Generation...")
    print(f"   Model: {SMALL_MODEL}")

    model_path = MODELS_DIR / SMALL_MODEL
    print(f"   Path: {model_path}")

    if not model_path.exists():
        print(f"   ❌ Model not found at {model_path}")
        return

    n_gpu_layers = -1 if os.environ.get("CUDA_VISIBLE_DEVICES") else 0
    print(f"   GPU layers: {n_gpu_layers}")

    llm = Llama(
        model_path=str(model_path),
        n_gpu_layers=n_gpu_layers,
        n_ctx=2048,
        verbose=False,
    )
    print("   ✓ Model loaded")

    prompt = "What is 2 + 2? Answer in one word."
    print(f"   Prompt: {prompt}")

    start_time = time.time()
    output = llm(
        prompt=prompt,
        max_tokens=50,
        temperature=0.1,
        echo=False,
    )
    elapsed = (time.time() - start_time) * 1000

    response = output["choices"][0]["text"].strip()
    print(f"   Response: {response}")
    print(f"   Time: {elapsed:.0f} ms")
    print("   ✅ Text Generation PASSED\n")


def test_embedding() -> None:
    print("\n🧪 Testing Python Embedding Generation...")
    print(f"   Model: {EMBEDDING_MODEL}")

    model_path = MODELS_DIR / EMBEDDING_MODEL
    print(f"   Path: {model_path}")

    if not model_path.exists():
        print(f"   ❌ Model not found at {model_path}")
        return

    llm = Llama(
        model_path=str(model_path),
        n_gpu_layers=0,
        embedding=True,
        verbose=False,
    )
    print("   ✓ Embedding model loaded")

    text = "Hello, world!"
    print(f"   Text: {text}")

    start_time = time.time()
    embedding = llm.create_embedding(text)["data"][0]["embedding"]
    elapsed = (time.time() - start_time) * 1000

    print(f"   Dimensions: {len(embedding)}")
    print(f"   First 5 values: {[f'{v:.4f}' for v in embedding[:5]]}")
    print(f"   Time: {elapsed:.0f} ms")
    print("   ✅ Embedding Generation PASSED\n")


def main() -> None:
    print("========================================")
    print("Python Local AI Integration Test")
    print("========================================")
    print(f"CUDA_VISIBLE_DEVICES: {os.environ.get('CUDA_VISIBLE_DEVICES', '(not set)')}")
    print(f"Models directory: {MODELS_DIR}")

    if not HAS_LLAMA_CPP:
        print("\n❌ Cannot run tests without llama-cpp-python")
        print("Install with: pip install llama-cpp-python")
        return

    try:
        test_text_generation()
        test_embedding()

        print("========================================")
        print("✅ ALL PYTHON TESTS PASSED")
        print("========================================")
    except Exception as e:
        print(f"❌ Test failed: {e}")
        import traceback

        traceback.print_exc()
        exit(1)


if __name__ == "__main__":
    main()
