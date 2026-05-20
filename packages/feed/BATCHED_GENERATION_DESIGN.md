# Batched Generation for H100 Saturation

## The Problem

Current training loop is **sequential**: 30 agents each do a full model forward pass one at a time. On H100 with a 4B model using 42GB/80GB, we're at 52% GPU utilization. Half the GPU is idle.

```
Current: agent_1 → generate → agent_2 → generate → ... → agent_30 → generate → train
         [~1 sec each, 30 seconds total, GPU 50% utilized]
```

## The Solution: Batched Generation + Single Backprop

### Architecture

```
1. BATCH FORWARD PASS (all agents in parallel)
   ┌─────────────────────────────────────────────┐
   │ Model receives batch of 30 prompts           │
   │ Generates 30 responses simultaneously        │
   │ GPU utilization: ~95% (memory-bound)         │
   │ Time: ~3-5 seconds (vs 30 seconds sequential)│
   └─────────────────────────────────────────────┘
                         ↓
2. EXECUTE + REWARD (CPU-side, fast)
   ┌─────────────────────────────────────────────┐
   │ Parse 30 actions                             │
   │ Execute in game bridge (async parallel)      │
   │ Compute 30 intent-aware rewards              │
   │ Resolve 30 counterparty contexts             │
   └─────────────────────────────────────────────┘
                         ↓
3. KONDO GATE (select top 3%)
   ┌─────────────────────────────────────────────┐
   │ Compute advantage for all 30 experiences     │
   │ Compute log-probs for all 30 (batched)       │
   │ Compute delight = advantage × surprisal      │
   │ Select top ~1 experience (3% of 30)          │
   └─────────────────────────────────────────────┘
                         ↓
4. SINGLE BACKPROP (on selected experience(s))
   ┌─────────────────────────────────────────────┐
   │ Forward + backward on ~1 selected experience │
   │ Optimizer step (APOLLO)                      │
   │ Weights updated                              │
   └─────────────────────────────────────────────┘
                         ↓
5. NEXT TICK (weights already updated for all agents)
```

### Why Batching Helps Beyond Speed

1. **GPU saturation**: 30 prompts × 2048 tokens = 61K tokens per batch. H100 can process this efficiently with KV cache parallelism.

2. **Smoother gradients**: Like mini-batch SGD vs single-sample SGD. The Kondo gate selects from a diverse pool of 30 experiences per tick, which is already a form of batching. But with true batched forward pass, we can also batch the log-prob computation in step 3, giving us more accurate advantage estimates.

3. **Better Kondo selection**: When we compute log-probs for all 30 experiences in one batched forward pass (instead of one at a time with potentially stale weights), the delight scores are more comparable because they all use the exact same model weights.

4. **Memory efficiency**: Batched generation can share KV cache prefixes across agents with the same team prompt (10 agents per team share the system prompt prefix).

### Implementation

```python
@torch.no_grad()
def generate_batch(self, npc_ids: List[str], scenarios: List[Scenario]) -> List[Tuple[str, torch.Tensor, torch.Tensor]]:
    """Generate actions for ALL agents in a single batched forward pass."""
    
    # Build prompts for all agents
    prompts = [self.build_prompt(npc_id, scenario) 
               for npc_id, scenario in zip(npc_ids, scenarios)]
    
    # Tokenize with padding
    encodings = self.tokenizer(
        prompts, return_tensors="pt", padding=True, 
        truncation=True, max_length=2048,
    ).to(self.config.device)
    
    self.model.eval()
    # Single batched generation call
    output_ids = self.model.generate(
        encodings["input_ids"],
        attention_mask=encodings["attention_mask"],
        max_new_tokens=self.config.max_new_tokens,
        temperature=self.config.temperature,
        top_p=self.config.top_p,
        do_sample=True,
        pad_token_id=self.tokenizer.pad_token_id,
    )
    self.model.train()
    
    # Split batch back into individual results
    results = []
    for i in range(len(npc_ids)):
        prompt_len = encodings["attention_mask"][i].sum().item()
        resp_text = self.tokenizer.decode(
            output_ids[i, prompt_len:], skip_special_tokens=True,
        )
        results.append((resp_text, encodings["input_ids"][i:i+1], output_ids[i:i+1]))
    
    return results
```

### Batched Log-Prob Computation (for Kondo Gate)

```python
def compute_batch_logprobs(self, experiences: List[AgentExperience]) -> List[float]:
    """Compute log-probs for ALL experiences in one forward pass."""
    
    # Pad all output sequences to same length
    max_len = max(e.output_ids.shape[1] for e in experiences)
    padded = torch.zeros(len(experiences), max_len, dtype=torch.long, device=self.config.device)
    masks = torch.zeros(len(experiences), max_len, dtype=torch.bool, device=self.config.device)
    
    for i, exp in enumerate(experiences):
        seq_len = exp.output_ids.shape[1]
        padded[i, :seq_len] = exp.output_ids[0]
        masks[i, :seq_len] = True
    
    with torch.no_grad():
        outputs = self.model(padded[:, :-1])
        # Compute per-token log-probs for each experience
        log_probs = F.log_softmax(outputs.logits, dim=-1)
        
    mean_lps = []
    for i, exp in enumerate(experiences):
        prompt_len = exp.input_ids.shape[1]
        n_tokens = exp.output_ids.shape[1] - prompt_len
        if n_tokens < 1:
            mean_lps.append(0.0)
            continue
        token_lps = log_probs[i, prompt_len-1:prompt_len-1+n_tokens]
        targets = padded[i, prompt_len:prompt_len+n_tokens]
        gathered = token_lps.gather(1, targets.unsqueeze(1)).squeeze(1)
        mean_lps.append(gathered.mean().item())
    
    return mean_lps
```

### Memory Budget on H100 (80GB)

| Component | 4B Model | 9B Model |
|-----------|----------|----------|
| Model weights (bf16) | 8 GB | 18 GB |
| Optimizer (APOLLO) | 4 GB | 9 GB |
| Gradient checkpointing | 2 GB | 4 GB |
| KV cache (batch=30) | 12 GB | 24 GB |
| Activations | 4 GB | 8 GB |
| **Total** | **30 GB** | **63 GB** |
| **Headroom** | **50 GB** | **17 GB** |

4B model: Tons of headroom — could batch 60+ agents.
9B model: Tight but feasible with batch=30. Reduce to batch=20 if OOM.

### Speed Improvement Estimate

| Mode | Time/Tick (4B) | Time/Tick (9B) | GPU Util |
|------|---------------|---------------|----------|
| Sequential (current) | ~60s | ~120s | 50% |
| Batched generation | ~5s | ~10s | 95% |
| + Batched log-probs | ~7s | ~14s | 95% |
| **Total speedup** | **~8x** | **~8x** | |

100 ticks: 100 min → ~12 min (4B), 200 min → ~25 min (9B).

### The Key Insight: Separate Forward and Backward

The model is used in two distinct modes:
1. **Generation (eval mode)**: Produces responses. Can be batched.
2. **Training (train mode)**: Computes loss and backprop. Only on selected experiences (1-2 per tick).

Batching generation is pure speedup with no quality tradeoff. The backprop still operates on individual selected experiences with the Kondo gate.
