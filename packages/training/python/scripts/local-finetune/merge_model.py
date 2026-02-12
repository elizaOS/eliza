import torch
from peft import AutoPeftModelForCausalLM
from transformers import AutoTokenizer
import os

ADAPTER_DIR = "./trained_models/babylon-v1/adapter"
OUTPUT_DIR = "./trained_models/babylon-v1/merged"

def main():
    print(f"Loading adapter from {ADAPTER_DIR}...")
    
    # Load model with adapter
    model = AutoPeftModelForCausalLM.from_pretrained(
        ADAPTER_DIR,
        device_map="auto",
        torch_dtype=torch.float16
    )
    
    # Load tokenizer
    tokenizer = AutoTokenizer.from_pretrained(ADAPTER_DIR)
    
    print("Merging weights (this makes inference faster)...")
    model = model.merge_and_unload()
    
    print(f"Saving merged model to {OUTPUT_DIR}...")
    model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    
    print("✅ Done! You can now serve this model.")

if __name__ == "__main__":
    main()
