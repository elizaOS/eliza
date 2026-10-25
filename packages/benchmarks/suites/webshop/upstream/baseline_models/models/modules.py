import itertools
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils import rnn


def duplicate(output, mask, lens, act_sizes):
    """
    Duplicate the output based on the action sizes.
    """
    output = torch.cat([output[i:i+1].repeat(j, 1, 1) for i, j in enumerate(act_sizes)], dim=0)
    mask = torch.cat([mask[i:i+1].repeat(j, 1) for i, j in enumerate(act_sizes)], dim=0)
    lens = list(itertools.chain.from_iterable([lens[i:i+1] * j for i, j in enumerate(act_sizes)]))
    return output, mask, lens


def get_aggregated(output, lens, method):
    """
    Get the aggregated hidden state of the encoder.
    B x D
    """
    if method == 'mean':
        return torch.stack([output[i, :j, :].mean(0) for i, j in enumerate(lens)], dim=0)
    elif method == 'last':
        return torch.stack([output[i, j-1, :] for i, j in enumerate(lens)], dim=0)
    elif method == 'first':
        return output[:, 0, :]


class EncoderRNN(nn.Module):
    def __init__(self, input_size, num_units, nlayers, concat,
                 bidir, layernorm, return_last):
        super().__init__()
        self.layernorm = (layernorm == 'layer')
        if layernorm:
            self.norm = nn.LayerNorm(input_size)

        self.rnns = []
        for i in range(nlayers):
            if i == 0:
                input_size_ = input_size
                output_size_ = num_units
            else:
                input_size_ = num_units if not bidir else num_units * 2
                output_size_ = num_units
            self.rnns.append(
                nn.GRU(input_size_, output_size_, 1,
                       bidirectional=bidir, batch_first=True))

        self.rnns = nn.ModuleList(self.rnns)
        self.init_hidden = nn.ParameterList(
            [nn.Parameter(
                torch.zeros(size=(2 if bidir else 1, 1, num_units)),
                requires_grad=True) for _ in range(nlayers)])
        self.concat = concat
        self.nlayers = nlayers
        self.return_last = return_last

        self.reset_parameters()

    def reset_parameters(self):
        with torch.no_grad():
            for rnn_layer in self.rnns:
                for name, p in rnn_layer.named_parameters():
                    if 'weight_ih' in name:
                        torch.nn.init.xavier_uniform_(p.data)
                    elif 'weight_hh' in name:
                        torch.nn.init.orthogonal_(p.data)
                    elif 'bias' in name:
                        p.data.fill_(0.0)
                    else:
                        p.data.normal_(std=0.1)

    def get_init(self, bsz, i):
        return self.init_hidden[i].expand(-1, bsz, -1).contiguous()

    def forward(self, inputs, input_lengths=None):
        bsz, slen = inputs.size(0), inputs.size(1)
        if self.layernorm:
            inputs = self.norm(inputs)
        output = inputs
        outputs = []
        lens = 0
        if input_lengths is not None:
            lens = input_lengths  # .data.cpu().numpy()
        for i in range(self.nlayers):
            hidden = self.get_init(bsz, i)
            # output = self.dropout(output)
            if input_lengths is not None:
                output = rnn.pack_padded_sequence(output, lens,
                                                  batch_first=True,
                                                  enforce_sorted=False)
            output, hidden = self.rnns[i](output, hidden)
            if input_lengths is not None:
                output, _ = rnn.pad_packed_sequence(output, batch_first=True)
                if output.size(1) < slen:
                    # used for parallel
                    # padding = Variable(output.data.new(1, 1, 1).zero_())
                    padding = torch.zeros(
                        size=(1, 1, 1), dtype=output.type(),
                        device=output.device())
                    output = torch.cat(
                        [output,
                         padding.expand(
                             output.size(0),
                             slen - output.size(1),
                             output.size(2))
                         ], dim=1)
            if self.return_last:
                outputs.append(
                    hidden.permute(1, 0, 2).contiguous().view(bsz, -1))
            else:
                outputs.append(output)
        if self.concat:
            return torch.cat(outputs, dim=2)
        return outputs[-1]


class BiAttention(nn.Module):
    def __init__(self, input_size, dropout):
        super().__init__()
        self.dropout = nn.Dropout(dropout)
        self.input_linear = nn.Linear(input_size, 1, bias=False)
        self.memory_linear = nn.Linear(input_size, 1, bias=False)
        self.dot_scale = nn.Parameter(
            torch.zeros(size=(input_size,)).uniform_(1. / (input_size ** 0.5)),
            requires_grad=True)
        self.init_parameters()

    def init_parameters(self):
        return

    def forward(self, context, memory, mask):
        bsz, input_len = context.size(0), context.size(1)
        memory_len = memory.size(1)
        context = self.dropout(context)
        memory = self.dropout(memory)

        input_dot = self.input_linear(context)
        memory_dot = self.memory_linear(memory).view(bsz, 1, memory_len)
        cross_dot = torch.bmm(
            context * self.dot_scale,
            memory.permute(0, 2, 1).contiguous())
        att = input_dot + memory_dot + cross_dot
        att = att - 1e30 * (1 - mask[:, None])

        weight_one = F.softmax(att, dim=-1)
        output_one = torch.bmm(weight_one, memory)
        weight_two = (F.softmax(att.max(dim=-1)[0], dim=-1)
                      .view(bsz, 1, input_len))
        output_two = torch.bmm(weight_two, context)
        return torch.cat(
            [context, output_one, context * output_one,
             output_two * output_one],
            dim=-1)