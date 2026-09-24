import os
import random
import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import AutoTokenizer
from collections import defaultdict, namedtuple

from models.bert import BertConfigForWebshop, BertModelForWebshop
from models.rnn import RCDQN

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

State = namedtuple('State', ('obs', 'goal', 'click', 'estimate', 'obs_str', 'goal_str', 'image_feat'))
TransitionPG = namedtuple('TransitionPG', ('state', 'act', 'reward', 'value', 'valid_acts', 'done'))


def discount_reward(transitions, last_values, gamma):
    returns, advantages = [], []
    R = last_values.detach()  # always detached
    for t in reversed(range(len(transitions))):
        _, _, rewards, values, _, dones = transitions[t]
        R = torch.FloatTensor(rewards).to(device) + gamma * R * (1 - torch.FloatTensor(dones).to(device))
        baseline = values
        adv = R - baseline
        returns.append(R)
        advantages.append(adv)
    return returns[::-1], advantages[::-1]


class Agent:
    def __init__(self, args):
        # tokenizer
        self.tokenizer = AutoTokenizer.from_pretrained('bert-base-uncased', truncation_side='left', max_length=512)
        self.tokenizer.add_tokens(['[button], [button_], [clicked button], [clicked button_]'], special_tokens=True)
        vocab_size = len(self.tokenizer)
        embedding_dim = args.embedding_dim

        # network
        if args.network == 'rnn':
            self.network = RCDQN(vocab_size, embedding_dim, 
                args.hidden_dim, args.arch_encoder, args.grad_encoder, None, args.gru_embed, args.get_image, args.bert_path)
            self.network.rl_forward = self.network.forward
        elif args.network == 'bert':
            config = BertConfigForWebshop(image=args.get_image, pretrained_bert=(args.bert_path != 'scratch'))
            self.network = BertModelForWebshop(config)
            if args.bert_path != '' and args.bert_path != 'scratch':
                self.network.load_state_dict(torch.load(args.bert_path, map_location=torch.device('cpu')), strict=False)
        else:
            raise ValueError('Unknown network: {}'.format(args.network))
        self.network = self.network.to(device)

        self.save_path = args.output_dir
        self.clip = args.clip
        self.w = {'loss_pg': args.w_pg, 'loss_td': args.w_td, 'loss_il': args.w_il, 'loss_en': args.w_en}
        self.optimizer = torch.optim.Adam(self.network.parameters(), lr=args.learning_rate)
        self.gamma = args.gamma

    def build_state(self, ob, info):
        """ Returns a state representation built from various info sources. """
        obs_ids = self.encode(ob)
        goal_ids = self.encode(info['goal'])
        click = info['valid'][0].startswith('click[')
        estimate = info['estimate_score']
        obs_str = ob.replace('\n', '[SEP]')
        goal_str = info['goal']
        image_feat = info.get('image_feat')
        return State(obs_ids, goal_ids, click, estimate, obs_str, goal_str, image_feat)


    def encode(self, observation, max_length=512):
        """ Encode an observation """
        observation = observation.lower().replace('"', '').replace("'", "").strip()
        observation = observation.replace('[sep]', '[SEP]')
        token_ids = self.tokenizer.encode(observation, truncation=True, max_length=max_length)
        return token_ids

    def decode(self, act):
        act = self.tokenizer.decode(act, skip_special_tokens=True)
        act = act.replace(' [ ', '[').replace(' ]', ']')
        return act
    
    def encode_valids(self, valids, max_length=64):
        """ Encode a list of lists of strs """
        return [[self.encode(act, max_length=max_length) for act in valid] for valid in valids]


    def act(self, states, valid_acts, method, state_strs=None, eps=0.1):
        """ Returns a string action from poss_acts. """
        act_ids = self.encode_valids(valid_acts)

        # sample actions
        act_values, act_sizes, values = self.network.rl_forward(states, act_ids, value=True, act=True)
        act_values = act_values.split(act_sizes)
        if method == 'softmax':
            act_probs = [F.softmax(vals, dim=0) for vals in act_values]
            act_idxs = [torch.multinomial(probs, num_samples=1).item() for probs in act_probs]
        elif method == 'greedy':
            act_idxs = [vals.argmax(dim=0).item() for vals in act_values]
        elif method == 'eps': # eps exploration
            act_idxs = [vals.argmax(dim=0).item() if random.random() > eps else random.randint(0, len(vals)-1) for vals in act_values]
        acts = [acts[idx] for acts, idx in zip(act_ids, act_idxs)]

        # decode actions
        act_strs, act_ids = [], []
        for act, idx, valids in zip(acts, act_idxs, valid_acts):
            if torch.is_tensor(act):
                act = act.tolist()
            if 102 in act:
                act = act[:act.index(102) + 1]
            act_ids.append(act)  # [101, ..., 102]
            if idx is None:  # generative
                act_str = self.decode(act)
            else:  # int
                act_str = valids[idx]
            act_strs.append(act_str)
        return act_strs, act_ids, values
    

    def update(self, transitions, last_values, step=None, rewards_invdy=None):
        returns, advs = discount_reward(transitions, last_values, self.gamma)
        stats_global = defaultdict(float)
        for transition, adv in zip(transitions, advs):
            stats = {}
            log_valid, valid_sizes = self.network.rl_forward(transition.state, transition.valid_acts)
            act_values = log_valid.split(valid_sizes)
            log_a = torch.stack([values[acts.index(act)]
                                        for values, acts, act in zip(act_values, transition.valid_acts, transition.act)])

            stats['loss_pg'] = - (log_a * adv.detach()).mean()
            stats['loss_td'] = adv.pow(2).mean()
            stats['loss_il'] = - log_valid.mean()
            stats['loss_en'] = (log_valid * log_valid.exp()).mean()
            for k in stats:
                stats[k] = self.w[k] * stats[k] / len(transitions)
            stats['loss'] = sum(stats[k] for k in stats)
            stats['returns'] = torch.stack(returns).mean() / len(transitions)
            stats['advs'] = torch.stack(advs).mean() / len(transitions)
            stats['loss'].backward()

            # Compute the gradient norm
            stats['gradnorm_unclipped'] = sum(p.grad.norm(2).item() for p in self.network.parameters() if p.grad is not None)
            nn.utils.clip_grad_norm_(self.network.parameters(), self.clip)
            stats['gradnorm_clipped'] = sum(p.grad.norm(2).item() for p in self.network.parameters() if p.grad is not None)
            for k, v in stats.items():
                stats_global[k] += v.item() if torch.is_tensor(v) else v
            del stats
        self.optimizer.step()
        self.optimizer.zero_grad()
        return stats_global

    def load(self):
        try:
            self.network = torch.load(os.path.join(self.save_path, 'model.pt'))
        except Exception as e:
            print("Error saving model.", e)

    def save(self):
        try:
            torch.save(self.network, os.path.join(self.save_path, 'model.pt'))
        except Exception as e:
            print("Error saving model.", e)
