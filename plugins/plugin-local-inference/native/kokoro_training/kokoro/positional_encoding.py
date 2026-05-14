import torch
import torch.nn as nn
import logging

logger = logging.getLogger(__name__)

class PositionalEncoding(nn.Module):
    def __init__(self, d_model: int, dropout: float = 0.1, max_len: int = 4000):
        """
        Initializes the PositionalEncoding layer.

        Args:
            d_model: The embedding dimension.
            dropout: The dropout rate.
            max_len: The maximum length of sequences this positional encoding will support.
        """
        super().__init__()
        self.dropout = nn.Dropout(p=dropout)
        self.d_model = d_model

        # Compute the positional encodings once in log space.
        position = torch.arange(max_len).unsqueeze(1).float()
        div_term = torch.exp(torch.arange(0, d_model, 2).float() *
                            (-torch.log(torch.tensor(10000.0)) / d_model))

        # Create positional encoding matrix
        pe = torch.zeros(max_len, d_model)
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)

        # Add batch dimension and register as buffer
        # Shape: (1, max_len, d_model)
        self.register_buffer('pe', pe.unsqueeze(0))

    def forward(self, x: torch.Tensor, seq_offset: int = 0) -> torch.Tensor:
        """
        Adds positional encoding to the input tensor.

        Args:
            x: Input tensor (batch_size, seq_len, d_model).
            seq_offset: An integer offset to apply to the positional encoding.

        Returns:
            Tensor with positional encoding added (batch_size, seq_len, d_model).
        """
        batch_size, seq_len, d_model = x.shape

        # Validate d_model matches
        if d_model != self.d_model:
            raise ValueError(f"Input d_model ({d_model}) doesn't match PE d_model ({self.d_model})")

        # Check bounds
        if seq_offset + seq_len > self.pe.size(1):
            logger.warning(
                f"Positional encoding max_len ({self.pe.size(1)}) is too small. "
                f"Requested slice (offset {seq_offset} + length {seq_len}) = {seq_offset + seq_len}. "
                f"Consider increasing max_len during initialization."
            )
            # Extend PE if needed
            self._extend_pe(seq_offset + seq_len)

        # Extract the positional encoding slice
        # pe shape: (1, max_len, d_model)
        # pe_slice shape: (1, seq_len, d_model)
        pe_slice = self.pe[:, seq_offset:seq_offset + seq_len, :]

        # Add positional encoding (broadcasting handles batch dimension)
        # x: (batch_size, seq_len, d_model)
        # pe_slice: (1, seq_len, d_model)
        # Result: (batch_size, seq_len, d_model)
        x = x + pe_slice

        return self.dropout(x)

    def _extend_pe(self, new_max_len: int):
        """Extend positional encoding if needed."""
        if new_max_len <= self.pe.size(1):
            return

        # Create extended PE
        old_max_len = self.pe.size(1)
        position = torch.arange(new_max_len).unsqueeze(1).float()
        div_term = torch.exp(torch.arange(0, self.d_model, 2).float() *
                            (-torch.log(torch.tensor(10000.0)) / self.d_model))

        pe_extended = torch.zeros(new_max_len, self.d_model, device=self.pe.device)
        pe_extended[:, 0::2] = torch.sin(position * div_term.to(self.pe.device))
        pe_extended[:, 1::2] = torch.cos(position * div_term.to(self.pe.device))

        # Update the buffer
        self.pe = pe_extended.unsqueeze(0)
        logger.info(f"Extended positional encoding from {old_max_len} to {new_max_len}")
