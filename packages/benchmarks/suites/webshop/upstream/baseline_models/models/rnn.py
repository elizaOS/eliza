# Adapted from https://github.com/XiaoxiaoGuo/rcdqn/blob/master/agents/nn/networks.py
import torch
import torch.nn as nn
import torch.nn.functional as F
from .modules import EncoderRNN, BiAttention, get_aggregated, duplicate


class RCDQN(nn.Module):
    def __init__(self, vocab_size, embedding_dim, hidden_dim, arch, grad, embs=None, gru_embed='embedding', get_image=0, bert_path=''):
        super().__init__()
        self.word_dim = embedding_dim
        self.word_emb = nn.Embedding(vocab_size, embedding_dim)
        if embs is not None:
            print('Loading embeddings of shape {}'.format(embs.shape))
            self.word_emb.weight.data.copy_(torch.from_numpy(embs))
            # self.word_emb.weight.requires_grad = False
        self.hidden_dim = hidden_dim
        self.keep_prob = 1.0
        self.rnn = EncoderRNN(self.word_dim, self.hidden_dim, 1,
                              concat=True,
                              bidir=True,
                              layernorm='None',
                              return_last=False)
        # self.rnn = AutoModelForMaskedLM.from_pretrained("google/bert_uncased_L-4_H-128_A-2").bert
        # self.linear_bert = nn.Linear(128, 256)
        self.att_1 = BiAttention(self.hidden_dim * 2, 1 - self.keep_prob)
        self.att_2 = BiAttention(self.hidden_dim * 2, 1 - self.keep_prob)
        self.att_3 = BiAttention(embedding_dim, 1 - self.keep_prob)

        self.linear_1 = nn.Sequential(
            nn.Linear(self.hidden_dim * 8, self.hidden_dim),
            nn.LeakyReLU())

        self.rnn_2 = EncoderRNN(self.hidden_dim, self.hidden_dim, 1,
                                concat=True,
                                bidir=True,
                                layernorm='layer',
                                return_last=False)
        # self.self_att = BiAttention(self.hidden_dim * 2, 1 - self.keep_prob)
        self.linear_2 = nn.Sequential(
            nn.Linear(self.hidden_dim * 12, self.hidden_dim * 2),
            nn.LeakyReLU())

        self.linear_3 = nn.Sequential(
            nn.Linear(self.hidden_dim * 2, self.hidden_dim),
            nn.LeakyReLU(),
            nn.Linear(self.hidden_dim, 1),
        )

        self.get_image = get_image
        if self.get_image:
            self.linear_image = nn.Linear(512, self.hidden_dim)

    def prepare(self, ids):
        """
        Prepare the input for the encoder. Pass it through pad, embedding, and rnn.
        """
        lens = [len(_) for _ in ids]
        ids = [torch.tensor(_) for _ in ids]
        ids = nn.utils.rnn.pad_sequence(ids, batch_first=True).cuda()
        mask = (ids > 0).float()
        embed = self.word_emb(ids)
        output = self.rnn(embed, lens)
        return ids, lens, mask, embed, output
    
    def forward(self, state_batch, act_batch, value=False, q=False, act=False):
        if self.arch == 'bert':
            return self.bert_forward(state_batch, act_batch, value, q, act)

        # state representation
        obs_ids, obs_lens, obs_mask, obs_embed, obs_output = self.prepare([state.obs for state in state_batch])
        goal_ids, goal_lens, goal_mask, goal_embed, goal_output = self.prepare([state.goal for state in state_batch])

        state_output = self.att_1(obs_output, goal_output, goal_mask)
        state_output = self.linear_1(state_output)
        if self.get_image:
            images = [state.image_feat for state in state_batch]
            images = [torch.zeros(512) if _ is None else _ for _ in images] 
            images = torch.stack([_ for _ in images]).cuda()  # BS x 512
            images = self.linear_image(images)
            state_output = torch.cat([images.unsqueeze(1), state_output], dim=1)
            obs_lens = [_ + 1 for _ in obs_lens]
            obs_mask = torch.cat([obs_mask[:, :1], obs_mask], dim=1)
        state_output = self.rnn_2(state_output, obs_lens)
        
        # state value
        if value:
            values = get_aggregated(state_output, obs_lens, 'mean')
            values = self.linear_3(values).squeeze(1)

        # action
        act_sizes = [len(_) for _ in act_batch]
        act_batch = list(itertools.chain.from_iterable(act_batch))
        act_ids, act_lens, act_mask, act_embed, act_output = self.prepare(act_batch)

        # duplicate based on action sizes
        state_output, state_mask, state_lens = duplicate(state_output, obs_mask, obs_lens, act_sizes)
        goal_embed, goal_mask, goal_lens = duplicate(goal_embed, goal_mask, goal_lens, act_sizes)

        # full contextualized 
        state_act_output = self.att_2(act_output, state_output, state_mask)

        # based on goal and action tokens
        goal_act_output = self.att_3(act_embed, goal_embed, goal_mask)

        output = torch.cat([state_act_output, goal_act_output], dim=-1)
        output = get_aggregated(output, act_lens, 'mean')
        output = self.linear_2(output)
        act_values = self.linear_3(output).squeeze(1)
        # Log softmax
        if not q:
            act_values = torch.cat([F.log_softmax(_, dim=0) for _ in act_values.split(act_sizes)], dim=0)

        # Optionally, output state value prediction
        if value:
            return act_values, act_sizes, values
        else:
            return act_values, act_sizes



