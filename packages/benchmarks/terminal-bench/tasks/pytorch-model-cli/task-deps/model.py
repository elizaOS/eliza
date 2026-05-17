import torch
import torch.nn as nn


class MnistModel(nn.Module):
    def __init__(
        self,
        input_dim: int,
        hidden_dim: int,
        num_classes: int,
    ) -> torch.nn.Module:
        super().__init__()

        self.input_layer = nn.Linear(input_dim, hidden_dim)
        self.hidden_layer = nn.Linear(hidden_dim, hidden_dim)
        self.output_layer = nn.Linear(hidden_dim, num_classes)
        self.activation = nn.ReLU()

    def forward(self, x):
        x = self.input_layer(x)
        x = self.activation(x)

        x = self.hidden_layer(x)
        x = self.activation(x)

        x = self.output_layer(x)
        return x
