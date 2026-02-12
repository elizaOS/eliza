import argparse
import logging
import os
import sys
import torch
import pandas as pd
from datasets import Dataset
from transformers import (
    AutoModelForCausalLM, 
    AutoTokenizer
)
from peft import LoraConfig, get_peft_model, TaskType
from trl import SFTTrainer, SFTConfig

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def train_local(
    csv_path: str,
    output_dir: str,
    max_length: int = 1024,
):
    if not os.path.exists(csv_path):
        logger.error(f"Data file not found: {csv_path}")
        return

    # 1. Load and Filter Data
    logger.info(f"Loading data from {csv_path}")
    df = pd.read_csv(csv_path)
    
    # Filter for high quality data only (Score > 0.7)
    df_high_quality = df[df['score'] > 0.7].copy()
    logger.info(f"Training on {len(df_high_quality)} high-quality samples (filtered from {len(df)})")
    
    # 2. Pre-format Data
    def format_row(row):
        return (
            f"<|im_start|>system\n{row['system']}<|im_end|>\n"
            f"<|im_start|>user\n{row['prompt']}<|im_end|>\n"
            f"<|im_start|>assistant\n{row['response']}<|im_end|>"
        )
    
    df_high_quality['text'] = df_high_quality.apply(format_row, axis=1)
    
    # KEY FIX: Select ONLY the 'text' column to prevent auto-detection confusion
    dataset = Dataset.from_pandas(df_high_quality[['text']])

    # 3. Load Base Model
    model_id = "Qwen/Qwen2.5-0.5B-Instruct" 
    logger.info(f"Loading base model: {model_id}...")
    
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    tokenizer.pad_token = tokenizer.eos_token

    # Determine device
    if torch.cuda.is_available():
        device = "cuda"
        logger.info(f"Using GPU: {torch.cuda.get_device_name(0)}")
    elif torch.backends.mps.is_available():
        device = "mps" # Apple Silicon
        logger.info("Using MPS (Apple Silicon)")
    else:
        device = "cpu"
        logger.info("Using CPU (Warning: This will be slow)")

    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch.float16 if device != "cpu" else torch.float32,
        device_map="auto" if device == "cuda" else None
    )
    if device != "cuda":
        model.to(device)

    # 4. Configure LoRA
    peft_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        inference_mode=False,
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        target_modules=["q_proj", "v_proj"]
    )
    model = get_peft_model(model, peft_config)
    model.print_trainable_parameters()

    # 5. Training Configuration
    training_args = SFTConfig(
        output_dir=output_dir,
        max_length=max_length,
        num_train_epochs=3,
        per_device_train_batch_size=4,
        gradient_accumulation_steps=2,
        learning_rate=2e-4,
        logging_steps=10,
        save_strategy="no",
        fp16=(device == "cuda"),
        use_cpu=(device == "cpu"),
        report_to="none",
        dataset_text_field="text",
        packing=False
    )

    # 6. Initialize Trainer
    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=dataset,
        args=training_args,
    )

    # 7. Train
    logger.info("Starting training...")
    trainer.train()
    
    # 8. Save
    final_path = os.path.join(output_dir, "adapter")
    logger.info(f"Saving model adapter to {final_path}")
    trainer.save_model(final_path)
    tokenizer.save_pretrained(final_path) 
    print(f"\n✅ Training Complete. Adapter saved at: {final_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="../data/scored_trajectories.csv")
    parser.add_argument("--output", default="./trained_models/babylon-v1")
    args = parser.parse_args()
    
    # Create output directory if it doesn't exist
    os.makedirs(args.output, exist_ok=True)
    
    train_local(args.data, args.output)