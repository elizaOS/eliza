import argparse
import logging
import time
import torch
from collections import defaultdict

import logger
from agent import Agent, TransitionPG
from env import WebEnv

logging.getLogger().setLevel(logging.CRITICAL)


def configure_logger(log_dir, wandb):
    logger.configure(log_dir, format_strs=['log'])
    global tb
    type_strs = ['json', 'stdout']
    if wandb: type_strs += ['wandb']
    tb = logger.Logger(log_dir, [logger.make_output_format(type_str, log_dir) for type_str in type_strs])
    global log
    log = logger.log


def evaluate(agent, env, split, nb_episodes=10):
    with torch.no_grad():
        total_score = 0
        for method in ['greedy']:
            for ep in range(nb_episodes):
                log("Starting {} episode {}".format(split, ep))
                if split == 'eval':
                    score = evaluate_episode(agent, env, split, method)
                elif split == 'test':
                    score = evaluate_episode(agent, env, split, method, idx=ep)
                log("{} episode {} ended with score {}\n\n".format(split, ep, score))
                total_score += score
        avg_score = total_score / nb_episodes
        return avg_score


def evaluate_episode(agent, env, split, method='greedy', idx=None):
    step = 0
    done = False
    ob, info = env.reset(idx)
    state = agent.build_state(ob, info)
    log('Obs{}: {}'.format(step, ob.encode('utf-8')))
    while not done:
        valid_acts = info['valid']
        with torch.no_grad():
            action_str = agent.act([state], [valid_acts], method=method)[0][0]
        log('Action{}: {}'.format(step, action_str))
        ob, rew, done, info = env.step(action_str)
        log("Reward{}: {}, Score {}, Done {}".format(step, rew, info['score'], done))
        step += 1
        log('Obs{}: {}'.format(step, ob.encode('utf-8')))
        state = agent.build_state(ob, info)
    tb.logkv_mean(f'{split}Score', info['score'])
    # category = env.session['goal']['category']
    # tb.logkv_mean(f'{split}Score_{category}', rew)
    if 'verbose' in info:
        for k, v in info['verbose'].items():
            if k.startswith('r'):
                tb.logkv_mean(f'{split}_' + k, v)
    return info['score']


def agg(envs, attr):
    res = defaultdict(int)
    for env in envs:
        for k, v in getattr(env, attr).items():
            res[k] += v
    return res


def train(agent, eval_env, test_env, envs, args):
    start = time.time()
    states, valids, transitions = [], [], []
    state0 = None
    for env in envs:
        ob, info = env.reset()
        if state0 is None:
            state0 = (ob, info)
        states.append(agent.build_state(ob, info))
        valids.append(info['valid'])

    for step in range(1, args.max_steps + 1):
        # get actions from policy
        action_strs, action_ids, values = agent.act(states, valids, method=args.exploration_method)
        
        # log envs[0]
        with torch.no_grad():
            action_values, _ = agent.network.rl_forward(states[:1], agent.encode_valids(valids[:1]))
        actions = sorted(zip(state0[1]['valid'], action_values.tolist()), key=lambda x: - x[1])
        log('State  {}: {}'.format(step, state0[0].lower().encode('utf-8')))
        log('Goal   {}: {}'.format(step, state0[1]['goal'].lower().encode('utf-8')))
        log('Actions{}: {}'.format(step, actions))
        log('>> Values{}: {}'.format(step, float(values[0])))
        log('>> Action{}: {}'.format(step, action_strs[0]))
        state0 = None

        # step in envs
        next_states, next_valids, rewards, dones = [], [], [], []
        for env, action_str, action_id, state in zip(envs, action_strs, action_ids, states):
            ob, reward, done, info = env.step(action_str)
            if state0 is None:  # first state
                state0 = (ob, info)
                r_att = r_opt = 0
                if 'verbose' in info:
                    r_att = info['verbose'].get('r_att', 0)
                    r_option = info['verbose'].get('r_option ', 0)
                    r_price = info['verbose'].get('r_price', 0)
                    r_type = info['verbose'].get('r_type', 0)
                    w_att = info['verbose'].get('w_att', 0)
                    w_option = info['verbose'].get('w_option', 0)
                    w_price = info['verbose'].get('w_price', 0)
                    reward_str = f'{reward/10:.2f} = ({r_att:.2f} * {w_att:.2f} + {r_option:.2f} * {w_option:.2f} + {r_price:.2f} * {w_price:.2f}) * {r_type:.2f}'
                else:
                    reward_str = str(reward)
                log('Reward{}: {}, Done {}\n'.format(step, reward_str, done))
            next_state = agent.build_state(ob, info)
            next_valid = info['valid']
            next_states, next_valids, rewards, dones = \
                next_states + [next_state], next_valids + [next_valid], rewards + [reward], dones + [done]
            if done:
                tb.logkv_mean('EpisodeScore', info['score'])
                category = env.session['goal']['category']
                tb.logkv_mean(f'EpisodeScore_{category}', info['score'])
                if 'verbose' in info:
                    for k, v in info['verbose'].items():
                        if k.startswith('r'):
                            tb.logkv_mean(k, v)

        # RL update
        transitions.append(TransitionPG(states, action_ids, rewards, values, agent.encode_valids(valids), dones))
        if len(transitions) >= args.bptt:
            _, _, last_values = agent.act(next_states, next_valids, method='softmax')
            stats = agent.update(transitions, last_values, step=step)
            for k, v in stats.items():
                tb.logkv_mean(k, v)
            del transitions[:]
            torch.cuda.empty_cache()

        # handle done
        for i, env in enumerate(envs):
            if dones[i]:               
                ob, info = env.reset()
                if i == 0:
                    state0 = (ob, info)
                next_states[i] = agent.build_state(ob, info)
                next_valids[i] = info['valid']
        states, valids = next_states, next_valids

        if step % args.eval_freq == 0:
            evaluate(agent, eval_env, 'eval')

        if step % args.test_freq == 0:
            evaluate(agent, test_env, 'test', 500)

        if step % args.log_freq == 0:
            tb.logkv('Step', step)
            tb.logkv('FPS', int((step * len(envs)) / (time.time() - start)))
            for k, v in agg(envs, 'stats').items():
                tb.logkv(k, v)
            items_clicked = agg(envs, 'items_clicked')
            tb.logkv('ItemsClicked', len(items_clicked))
            tb.dumpkvs()

        if step % args.ckpt_freq == 0:
            agent.save()


def parse_args():
    parser = argparse.ArgumentParser()
    # logging
    parser.add_argument('--seed', default=0, type=int)
    parser.add_argument('--output_dir', default='logs')
    parser.add_argument('--ckpt_freq', default=10000, type=int)
    parser.add_argument('--eval_freq', default=500, type=int)
    parser.add_argument('--test_freq', default=5000, type=int)
    parser.add_argument('--log_freq', default=100, type=int)
    parser.add_argument('--wandb', default=1, type=int)

    # rl
    parser.add_argument('--num_envs', default=4, type=int)
    parser.add_argument('--step_limit', default=100, type=int)
    parser.add_argument('--max_steps', default=300000, type=int)
    parser.add_argument('--learning_rate', default=1e-5, type=float)
    parser.add_argument('--gamma', default=.9, type=float)
    parser.add_argument('--clip', default=10, type=float)
    parser.add_argument('--bptt', default=8, type=int)
    parser.add_argument('--exploration_method', default='softmax', type=str, choices=['eps', 'softmax'])
    parser.add_argument('--w_pg', default=1, type=float)
    parser.add_argument('--w_td', default=1, type=float)
    parser.add_argument('--w_il', default=0, type=float)
    parser.add_argument('--w_en', default=1, type=float)

    # model
    parser.add_argument('--network', default='bert', type=str, choices=['bert', 'rnn'])
    parser.add_argument('--bert_path', default="", type=str, help='which bert to load')
    parser.add_argument('--embedding_dim', default=128, type=int)
    parser.add_argument('--hidden_dim', default=128, type=int)
    parser.add_argument('--grad_encoder', default=1, type=int)
    parser.add_argument('--get_image', default=1, type=int, help='use image in models')

    # env
    parser.add_argument('--num', default=None, type=int)
    parser.add_argument('--click_item_name', default=1, type=int)
    parser.add_argument('--state_format', default='text_rich', type=str)
    parser.add_argument('--human_goals', default=1, type=int, help='use human goals')
    parser.add_argument('--num_prev_obs', default=0, type=int, help='number of previous observations')
    parser.add_argument('--num_prev_actions', default=0, type=int, help='number of previous actions')
    parser.add_argument('--extra_search_path', default="./data/goal_query_predict.json", type=str, help='path for extra search queries')
    

    # experimental 
    parser.add_argument('--ban_buy', default=0, type=int, help='ban buy action before selecting options')
    parser.add_argument('--score_handicap', default=0, type=int, help='provide score in state')
    parser.add_argument('--go_to_item', default=0, type=int)
    parser.add_argument('--go_to_search', default=0, type=int)
    parser.add_argument('--harsh_reward', default=0, type=int)


    parser.add_argument('--debug', default=0, type=int, help='debug mode')
    parser.add_argument("--f", help="a dummy argument to fool ipython", default="1")

    return parser.parse_known_args()


def main():
    args, unknown = parse_args()
    if args.debug:
        args.num_envs = 2
        args.wandb = 0
        args.human_goals = 0
        args.num = 100
    print(unknown)
    print(args)
    configure_logger(args.output_dir, args.wandb)
    agent = Agent(args)
    train_env = WebEnv(args, split='train', id='train_')
    server = train_env.env.server
    eval_env = WebEnv(args, split='eval', id='eval_', server=server)
    test_env = WebEnv(args, split='test', id='test_', server=server)
    envs = [WebEnv(args, split='train', server=server, id=f'train{i}_') for i in range(args.num_envs)]
    print("loaded")
    train(agent, eval_env, test_env, envs, args)


if __name__ == "__main__":
    main()
