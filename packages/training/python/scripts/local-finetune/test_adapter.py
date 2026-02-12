import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel, PeftConfig
import sys

# Paths
BASE_MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
ADAPTER_PATH = "./trained_models/babylon-v1/adapter"

def get_device():
    if torch.cuda.is_available(): return "cuda"
    if torch.backends.mps.is_available(): return "mps"
    return "cpu"

def main():
    device = get_device()
    print(f"Running on: {device}")
    
    if device != "cuda":
        model.to(device)

    print(f"Loading base model: {BASE_MODEL_ID}...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_ID)
    
    # Load Base Model
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL_ID,
        torch_dtype=torch.float16,
        device_map="auto"
    )

    # Load Adapter
    print(f"Loading adapter from: {ADAPTER_PATH}...")
    try:
        model = PeftModel.from_pretrained(model, ADAPTER_PATH)
    except Exception as e:
        print(f"Error loading adapter: {e}")
        print("Did you finish training? Check if the directory exists.")
        return

    print("\n✅ Model Loaded! (Type 'quit' to exit)\n")

    while True:
        # Simulate a market situation
        default_prompt = (
            "Current Market State:\n"
            "{\n"
            '  "agentBalance": 10000,\n'
            '  "heldPositions": [],\n'
            '  "recentPrice": 105.50,\n'
            '  "indicators": {"RSI": 75, "MACD": "bearish_crossover"}\n'
            "}\n\n"
            "Task: Analyze the market and make a trading decision."
        )
        
        user_input = input(f"Press Enter for default test case, or type prompt: ")
        if user_input.lower() in ["quit", "exit"]:
            break
            
        prompt = user_input if user_input.strip() else default_prompt
        
        # Format input like the training data
        messages = [
            {"role": "system", "content": "You are an expert autonomous trading agent."},
            {"role": "user", "content": prompt}
        ]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        
        inputs = tokenizer(text, return_tensors="pt").to(device)
        
        print("\n🤔 Thinking...")
        with torch.no_grad():
            outputs = model.generate(
                **inputs, 
                max_new_tokens=256,
                temperature=0.7,
                do_sample=True
            )
            
        result = tokenizer.decode(outputs[0], skip_special_tokens=True)
        # Extract just the assistant part
        response = result.split("assistant\n")[-1]
        
        print("\n" + "="*40)
        print("🤖 AGENT RESPONSE:")
        print("="*40)
        print(response)
        print("="*40 + "\n")

if __name__ == "__main__":
    main()
