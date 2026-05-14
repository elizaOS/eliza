import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.checkpoint import checkpoint
from typing import Optional, Tuple
import math
import logging

logger = logging.getLogger(__name__)

class MultiHeadAttention(nn.Module):
    """Multi-head attention with better initialization and optional relative positioning"""

    def __init__(self, d_model: int, num_heads: int, dropout: float = 0.1,
                 use_relative_pos: bool = False, max_relative_distance: int = 32):
        super().__init__()
        assert d_model % num_heads == 0, f"d_model ({d_model}) must be divisible by num_heads ({num_heads})"

        self.d_model = d_model
        self.num_heads = num_heads
        self.d_k = d_model // num_heads # Dimension of each head's key/query/value
        self.use_relative_pos = use_relative_pos

        # Linear projections for Query, Key, Value
        self.w_q = nn.Linear(d_model, d_model, bias=False)
        self.w_k = nn.Linear(d_model, d_model, bias=False)
        self.w_v = nn.Linear(d_model, d_model, bias=False)

        # Output linear projection
        self.w_o = nn.Linear(d_model, d_model)

        # Relative positional encoding
        if use_relative_pos:
            self.max_relative_distance = max_relative_distance
            # Total unique relative positions: -max_dist to +max_dist (inclusive) = 2*max_dist + 1
            self.relative_position_k = nn.Embedding(2 * max_relative_distance + 1, self.d_k)
            self.relative_position_v = nn.Embedding(2 * max_relative_distance + 1, self.d_k)
            # Initialize these embeddings appropriately
            nn.init.xavier_uniform_(self.relative_position_k.weight)
            nn.init.xavier_uniform_(self.relative_position_v.weight)

        self.dropout_attn = nn.Dropout(dropout)
        self.scale = math.sqrt(self.d_k)

        # Better initialization for linear layers
        self._init_weights()

    def _init_weights(self):
        # Glorot (Xavier) uniform for weight matrices
        nn.init.xavier_uniform_(self.w_q.weight)
        nn.init.xavier_uniform_(self.w_k.weight)
        nn.init.xavier_uniform_(self.w_v.weight)
        nn.init.xavier_uniform_(self.w_o.weight)
        if self.w_o.bias is not None:
            nn.init.zeros_(self.w_o.bias)

    def _get_relative_positions(self, seq_len: int, device: torch.device) -> torch.Tensor:
        """
        Generate relative position indices for attention.
        Output shape: (seq_len, seq_len)
        """
        # Create a tensor of indices from 0 to seq_len-1
        idx = torch.arange(seq_len, device=device)
        # Create a matrix of (i - j) for all pairs (i, j)
        # Resulting shape: (seq_len, seq_len)
        relative_pos_indices = idx.unsqueeze(0) - idx.unsqueeze(1)

        # Clip values to be within [-max_relative_distance, max_relative_distance]
        relative_pos_indices = torch.clamp(
            relative_pos_indices, -self.max_relative_distance, self.max_relative_distance
        )

        # Shift values to be positive for embedding lookup
        # e.g., if max_dist=32, range is -32 to 32. Adding 32 shifts to 0 to 64.
        # This maps to indices [0, 2*max_relative_distance]
        relative_pos_indices = relative_pos_indices + self.max_relative_distance

        return relative_pos_indices # (S, S)

    def forward(self, query: torch.Tensor, key: torch.Tensor, value: torch.Tensor,
                attn_mask: Optional[torch.Tensor] = None, # Causal mask for decoder self-attention (float('-inf'))
                key_padding_mask: Optional[torch.Tensor] = None # Padding mask (True for padded)
               ) -> Tuple[torch.Tensor, torch.Tensor]: # Return output and attention weights

        batch_size, seq_len_q, _ = query.size()
        seq_len_k = key.size(1)
        seq_len_v = value.size(1) # Should be same as seq_len_k

        # 1. Linear projections and reshape for multi-head attention
        Q = self.w_q(query).view(batch_size, seq_len_q, self.num_heads, self.d_k).transpose(1, 2) # (B, H, S_q, D_k)
        K = self.w_k(key).view(batch_size, seq_len_k, self.num_heads, self.d_k).transpose(1, 2)   # (B, H, S_k, D_k)
        V = self.w_v(value).view(batch_size, seq_len_v, self.num_heads, self.d_k).transpose(1, 2)  # (B, H, S_v, D_k)

        # 2. Scaled dot-product attention (Content-based scores)
        # scores = Q @ K.transpose(-2, -1) / sqrt(d_k)
        # (B, H, S_q, D_k) @ (B, H, D_k, S_k) -> (B, H, S_q, S_k)
        scores = torch.matmul(Q, K.transpose(-2, -1)) / self.scale

        # 3. Add relative positional encoding scores
        if self.use_relative_pos and seq_len_q == seq_len_k:
            # Generate relative position indices (S_q, S_k)
            rel_pos_indices = self._get_relative_positions(seq_len_q, query.device)

            # Retrieve relative key embeddings (S_q, S_k, D_k)
            rel_pos_k_emb = self.relative_position_k(rel_pos_indices)

            # Compute relative scores (Q * R_k) using einsum
            # Q: (B, H, S_q, D_k)
            # rel_pos_k_emb: (S_q, S_k, D_k)
            # Output: (B, H, S_q, S_k)
            rel_scores = torch.einsum('bhid,ijd->bhij', Q, rel_pos_k_emb)
            scores = scores + rel_scores

        # 4. Apply masks
        if attn_mask is not None:
            # attn_mask (e.g., causal mask): (S_q, S_k) float('-inf') mask
            # Broadcast to (1, 1, S_q, S_k)
            scores = scores.masked_fill(attn_mask == float('-inf'), float('-inf'))

        if key_padding_mask is not None:
            # key_padding_mask: (B, S_k) boolean mask (True for padded, False for not padded)
            # Need to broadcast to (B, 1, 1, S_k) for scores
            # Crucially, ensure key_padding_mask is boolean before using with masked_fill
            key_padding_mask = key_padding_mask.to(torch.bool)
            scores = scores.masked_fill(
                key_padding_mask.unsqueeze(1).unsqueeze(2), float('-inf')
            )

        # 5. Softmax to get attention probabilities
        attn_weights = F.softmax(scores, dim=-1)
        attn_weights = self.dropout_attn(attn_weights)

        # 6. Apply attention weights to values (Content-based context)
        # context = attn_weights @ V
        # (B, H, S_q, S_k) @ (B, H, S_k, D_k) -> (B, H, S_q, D_k)
        context = torch.matmul(attn_weights, V)

        # 7. Add relative positional encoding to values (for the `A * R_v` term)
        if self.use_relative_pos and seq_len_q == seq_len_k:
            # Retrieve relative value embeddings (S_q, S_k, D_k)
            rel_pos_v_emb = self.relative_position_v(rel_pos_indices)

            # Compute relative context (A * R_v) using einsum
            # attn_weights: (B, H, S_q, S_k)
            # rel_pos_v_emb: (S_q, S_k, D_k)
            # Output: (B, H, S_q, D_k)
            rel_context = torch.einsum('bhij,ijd->bhid', attn_weights, rel_pos_v_emb)
            context = context + rel_context

        # 8. Concatenate heads and apply final linear layer
        # Transpose back (B, S_q, H, D_k) -> (B, S_q, D_model)
        context = context.transpose(1, 2).contiguous().view(
            batch_size, seq_len_q, self.d_model
        )
        output = self.w_o(context)

        return output, attn_weights.mean(dim=1) # Return mean attention weights for visualization/debugging


class TransformerEncoderBlock(nn.Module):
    """Transformer encoder block with better normalization and activations"""

    def __init__(self, d_model: int, nhead: int, dim_feedforward: int, dropout: float,
                 activation: str = 'gelu', use_prenorm: bool = True,
                 use_relative_pos: bool = False):
        super().__init__()
        self.use_prenorm = use_prenorm

        # Self-attention module
        self.self_attn = MultiHeadAttention(
            d_model, nhead, dropout, use_relative_pos
        )

        # Activation function for feed-forward network
        if activation == 'gelu':
            self.activation = nn.GELU()
        elif activation == 'swish': # SiLU is Swish
            self.activation = nn.SiLU()
        elif activation == 'relu':
            self.activation = nn.ReLU()
        else:
            raise ValueError(f"Unsupported activation: {activation}")

        # GLU-style feedforward (Gated Linear Unit)
        # Input to linear1 is d_model, output is dim_feedforward * 2 (for gate and linear paths)
        self.linear1 = nn.Linear(d_model, dim_feedforward * 2)
        self.linear2 = nn.Linear(dim_feedforward, d_model)

        # Normalization layers (LayerNorm)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)

        # Dropout layers
        self.dropout1 = nn.Dropout(dropout) # After self-attention residual
        self.dropout2 = nn.Dropout(dropout) # After feed-forward residual
        self.dropout_ff = nn.Dropout(dropout) # Inside feed-forward

        # Initialize weights for linear layers
        self._init_weights()

    def _init_weights(self):
        # Initialize only weight here, bias is usually initialized to zeros by default
        nn.init.xavier_uniform_(self.linear1.weight)
        if self.linear1.bias is not None:
            nn.init.zeros_(self.linear1.bias)
        nn.init.xavier_uniform_(self.linear2.weight)
        if self.linear2.bias is not None:
            nn.init.zeros_(self.linear2.bias)

    def _ff_block(self, x: torch.Tensor) -> torch.Tensor:
        """GLU-style feed-forward block"""
        x = self.linear1(x)
        # Split into two parts: one for gating, one for linear transformation
        gate, linear = x.chunk(2, dim=-1)
        # Apply activation to gate and multiply with linear path
        gated_output = self.activation(gate) * linear
        # Apply dropout and final linear transformation
        return self.linear2(self.dropout_ff(gated_output))

    def forward(self, src: torch.Tensor, src_mask: Optional[torch.Tensor] = None, # Self-attention mask (e.g., causal)
                src_key_padding_mask: Optional[torch.Tensor] = None # Padding mask for src (True for padded)
               ) -> torch.Tensor:

        # Ensure src_key_padding_mask is boolean at this level
        if src_key_padding_mask is not None:
            src_key_padding_mask = src_key_padding_mask.to(torch.bool)

        if self.use_prenorm:
            # Pre-normalization (e.g., Transformer-XL, GPT-2)
            # Self-attention sub-layer
            src_norm = self.norm1(src) # Apply LayerNorm BEFORE attention
            # MultiHeadAttentionImproved returns (output, attn_weights)
            attn_output, _ = self.self_attn(src_norm, src_norm, src_norm,
                                            attn_mask=src_mask,
                                            key_padding_mask=src_key_padding_mask)
            src = src + self.dropout1(attn_output) # Residual connection + Dropout

            # Feed-forward sub-layer
            src_norm = self.norm2(src) # Apply LayerNorm BEFORE FFN
            ff_output = self._ff_block(src_norm)
            src = src + self.dropout2(ff_output) # Residual connection + Dropout
        else:
            # Post-normalization (Original Transformer)
            # Self-attention sub-layer
            attn_output, _ = self.self_attn(src, src, src,
                                            attn_mask=src_mask,
                                            key_padding_mask=src_key_padding_mask)
            src = self.norm1(src + self.dropout1(attn_output)) # Residual + Dropout + LayerNorm

            # Feed-forward sub-layer
            ff_output = self._ff_block(src)
            src = self.norm2(src + self.dropout2(ff_output)) # Residual + Dropout + LayerNorm

        return src


class TransformerDecoderBlock(nn.Module):
    """Transformer decoder block with improved architecture"""

    def __init__(self, d_model: int, nhead: int, dim_feedforward: int, dropout: float,
                 activation: str = 'gelu', use_prenorm: bool = True):
        super().__init__()
        self.use_prenorm = use_prenorm

        # Decoder self-attention: usually causal, can use relative positional encoding
        self.self_attn = MultiHeadAttention(d_model, nhead, dropout, use_relative_pos=True)

        # Cross-attention (encoder-decoder attention): no relative pos, queries from decoder, keys/values from encoder
        self.cross_attn = MultiHeadAttention(d_model, nhead, dropout, use_relative_pos=False)

        # Activation function for feed-forward network
        if activation == 'gelu':
            self.activation = nn.GELU()
        elif activation == 'swish':
            self.activation = nn.SiLU()
        elif activation == 'relu':
            self.activation = nn.ReLU()
        else:
            raise ValueError(f"Unsupported activation: {activation}")

        # GLU-style feedforward
        self.linear1 = nn.Linear(d_model, dim_feedforward * 2)
        self.linear2 = nn.Linear(dim_feedforward, d_model)

        # Normalization layers
        self.norm1 = nn.LayerNorm(d_model) # For self-attention
        self.norm2 = nn.LayerNorm(d_model) # For cross-attention
        self.norm3 = nn.LayerNorm(d_model) # For feed-forward

        # Dropout layers
        self.dropout1 = nn.Dropout(dropout) # After self-attention residual
        self.dropout2 = nn.Dropout(dropout) # After cross-attention residual
        self.dropout3 = nn.Dropout(dropout) # After feed-forward residual
        self.dropout_ff = nn.Dropout(dropout) # Inside feed-forward

        self._init_weights()

    def _init_weights(self):
        nn.init.xavier_uniform_(self.linear1.weight)
        if self.linear1.bias is not None:
            nn.init.zeros_(self.linear1.bias)
        nn.init.xavier_uniform_(self.linear2.weight)
        if self.linear2.bias is not None:
            nn.init.zeros_(self.linear2.bias)

    def _ff_block(self, x: torch.Tensor) -> torch.Tensor:
        """GLU-style feed-forward block"""
        x = self.linear1(x)
        gate, linear = x.chunk(2, dim=-1)
        gated_output = self.activation(gate) * linear
        return self.linear2(self.dropout_ff(gated_output))

    def forward(self, tgt: torch.Tensor, memory: torch.Tensor, # memory is encoder output
                tgt_mask: Optional[torch.Tensor] = None, # Causal mask for decoder self-attention
                memory_mask: Optional[torch.Tensor] = None, # Not typically used for cross-attention
                tgt_key_padding_mask: Optional[torch.Tensor] = None, # Padding mask for decoder input
                memory_key_padding_mask: Optional[torch.Tensor] = None # Padding mask for encoder output
               ) -> torch.Tensor:

        # Ensure masks are boolean at this level
        if tgt_key_padding_mask is not None:
            tgt_key_padding_mask = tgt_key_padding_mask.to(torch.bool)
        if memory_key_padding_mask is not None:
            memory_key_padding_mask = memory_key_padding_mask.to(torch.bool)

        if self.use_prenorm:
            # Pre-normalization
            # Self-attention sub-layer
            tgt_norm = self.norm1(tgt)
            attn_output, _ = self.self_attn(tgt_norm, tgt_norm, tgt_norm,
                                            attn_mask=tgt_mask,
                                            key_padding_mask=tgt_key_padding_mask)
            tgt = tgt + self.dropout1(attn_output)

            # Cross-attention sub-layer
            tgt_norm = self.norm2(tgt)
            # Query is from decoder (tgt_norm), Key/Value from encoder (memory)
            cross_attn_output, _ = self.cross_attn(tgt_norm, memory, memory,
                                                   attn_mask=memory_mask, # Usually None
                                                   key_padding_mask=memory_key_padding_mask)
            tgt = tgt + self.dropout2(cross_attn_output)

            # Feed-forward sub-layer
            tgt_norm = self.norm3(tgt)
            ff_output = self._ff_block(tgt_norm)
            tgt = tgt + self.dropout3(ff_output)
        else:
            # Post-normalization
            # Self-attention sub-layer
            attn_output, _ = self.self_attn(tgt, tgt, tgt,
                                            attn_mask=tgt_mask,
                                            key_padding_mask=tgt_key_padding_mask)
            tgt = self.norm1(tgt + self.dropout1(attn_output))

            # Cross-attention sub-layer
            cross_attn_output, _ = self.cross_attn(tgt, memory, memory,
                                                   attn_mask=memory_mask, # Usually None
                                                   key_padding_mask=memory_key_padding_mask)
            tgt = self.norm2(tgt + self.dropout2(cross_attn_output))

            # Feed-forward sub-layer
            ff_output = self._ff_block(tgt)
            tgt = self.norm3(tgt + self.dropout3(ff_output))

        return tgt


class TransformerDecoder(nn.Module):
    """Transformer decoder with better layer organization"""

    def __init__(self, d_model: int, nhead: int, dim_feedforward: int,
                 dropout: float, num_layers: int, use_prenorm: bool = True,
                 activation: str = 'gelu'):
        super().__init__()
        self.num_layers = num_layers
        self.use_prenorm = use_prenorm

        self.layers = nn.ModuleList([
            TransformerDecoderBlock(
                d_model, nhead, dim_feedforward, dropout, activation, use_prenorm
            ) for _ in range(num_layers)
        ])

        # Final layer norm for pre-norm architecture (applied after all blocks)
        if use_prenorm:
            self.norm = nn.LayerNorm(d_model)
        else:
            self.norm = None # No final norm for post-norm architecture

    def forward(self, tgt: torch.Tensor, memory: torch.Tensor,
                tgt_mask: Optional[torch.Tensor] = None, # Causal mask for decoder self-attention
                memory_key_padding_mask: Optional[torch.Tensor] = None, # Padding mask for encoder output
                tgt_key_padding_mask: Optional[torch.Tensor] = None # Padding mask for decoder input
               ) -> torch.Tensor:

        output = tgt

        for layer in self.layers:
            if self.training:
                # Use gradient checkpointing during training to save memory
                # Arguments to checkpoint must be positional and match the layer's forward signature
                # ImprovedTransformerDecoderBlock.forward takes:
                # tgt, memory, tgt_mask, memory_mask, tgt_key_padding_mask, memory_key_padding_mask
                # Here, memory_mask is typically None for cross-attention.
                output = checkpoint(
                    layer, output, memory, tgt_mask, None,
                    tgt_key_padding_mask, memory_key_padding_mask,
                    use_reentrant=False
                )
            else:
                # Direct forward pass during inference
                output = layer(
                    output, memory, tgt_mask, None,
                    tgt_key_padding_mask, memory_key_padding_mask
                )

        # Apply final normalization if pre-norm architecture is used
        if self.norm is not None:
            output = self.norm(output)

        return output
