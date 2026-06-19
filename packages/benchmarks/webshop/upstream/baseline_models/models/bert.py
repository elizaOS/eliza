import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import (
    BertModel,
    BertConfig,
    PretrainedConfig,
    PreTrainedModel,
)
from transformers.modeling_outputs import SequenceClassifierOutput
from .modules import EncoderRNN, BiAttention, get_aggregated


class BertConfigForWebshop(PretrainedConfig):
    model_type = "bert"

    def __init__(
        self,
        pretrained_bert=True,
        image=False,

        **kwargs
    ):
        self.pretrained_bert = pretrained_bert
        self.image = image
        super().__init__(**kwargs)



class BertModelForWebshop(PreTrainedModel):

    config_class = BertConfigForWebshop

    def __init__(self, config):
        super().__init__(config)
        bert_config = BertConfig.from_pretrained('bert-base-uncased')
        if config.pretrained_bert:
            self.bert = BertModel.from_pretrained('bert-base-uncased')
        else:
            self.bert = BertModel(config)
        self.bert.resize_token_embeddings(30526)
        self.attn = BiAttention(768, 0.0)
        self.linear_1 = nn.Linear(768 * 4, 768)
        self.relu = nn.ReLU()
        self.linear_2 = nn.Linear(768, 1)
        if config.image:
            self.image_linear = nn.Linear(512, 768)
        else:
            self.image_linear = None

        # for state value prediction, used in RL
        self.linear_3 = nn.Sequential(
                nn.Linear(768, 128),
                nn.LeakyReLU(),
                nn.Linear(128, 1),
            )

    def forward(self, state_input_ids, state_attention_mask, action_input_ids, action_attention_mask, sizes, images=None, labels=None):
        sizes = sizes.tolist()
        # print(state_input_ids.shape, action_input_ids.shape)
        state_rep = self.bert(state_input_ids, attention_mask=state_attention_mask)[0]
        if images is not None and self.image_linear is not None:
            images = self.image_linear(images)
            state_rep = torch.cat([images.unsqueeze(1), state_rep], dim=1)
            state_attention_mask = torch.cat([state_attention_mask[:, :1], state_attention_mask], dim=1)
        action_rep = self.bert(action_input_ids, attention_mask=action_attention_mask)[0]
        state_rep = torch.cat([state_rep[i:i+1].repeat(j, 1, 1) for i, j in enumerate(sizes)], dim=0)
        state_attention_mask = torch.cat([state_attention_mask[i:i+1].repeat(j, 1) for i, j in enumerate(sizes)], dim=0)
        act_lens = action_attention_mask.sum(1).tolist()
        state_action_rep = self.attn(action_rep, state_rep, state_attention_mask)
        state_action_rep = self.relu(self.linear_1(state_action_rep))
        act_values = get_aggregated(state_action_rep, act_lens, 'mean')
        act_values = self.linear_2(act_values).squeeze(1)

        logits = [F.log_softmax(_, dim=0) for _ in act_values.split(sizes)]

        loss = None
        if labels is not None:
            loss = - sum([logit[label] for logit, label in zip(logits, labels)]) / len(logits)
        
        return SequenceClassifierOutput(
            loss=loss,
            logits=logits,
        )

    def rl_forward(self, state_batch, act_batch, value=False, q=False, act=False):
        act_values = []
        act_sizes = []
        values = []
        for state, valid_acts in zip(state_batch, act_batch):
            with torch.set_grad_enabled(not act):
                state_ids = torch.tensor([state.obs]).cuda()
                state_mask = (state_ids > 0).int()
                act_lens = [len(_) for _ in valid_acts]
                act_ids = [torch.tensor(_) for _ in valid_acts]
                act_ids = nn.utils.rnn.pad_sequence(act_ids, batch_first=True).cuda()
                act_mask = (act_ids > 0).int()
                act_size = torch.tensor([len(valid_acts)]).cuda()
                if self.image_linear is not None:
                    images = [state.image_feat]
                    images = [torch.zeros(512) if _ is None else _ for _ in images] 
                    images = torch.stack(images).cuda()  # BS x 512
                else:
                    images = None
                logits = self.forward(state_ids, state_mask, act_ids, act_mask, act_size, images=images).logits[0]
                act_values.append(logits)
                act_sizes.append(len(valid_acts))
            if value:
                v = self.bert(state_ids, state_mask)[0]
                values.append(self.linear_3(v[0][0]))
        act_values = torch.cat(act_values, dim=0)
        act_values = torch.cat([F.log_softmax(_, dim=0) for _ in act_values.split(act_sizes)], dim=0)
        # Optionally, output state value prediction
        if value:
            values = torch.cat(values, dim=0)
            return act_values, act_sizes, values
        else:
            return act_values, act_sizes