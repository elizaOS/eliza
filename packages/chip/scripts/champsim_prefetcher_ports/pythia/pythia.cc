#include "pythia.h"

#include <algorithm>
#include <iostream>

#include "cache.h"

void pythia::prefetcher_initialize()
{
  q_table_.assign(NUM_STATES, {});
  for (auto& row : q_table_) {
    row.fill(Q_INIT);
  }
  eq_.clear();
  pref_issued_ = 0;
  reward_useful_total_ = 0;
  reward_useless_total_ = 0;
  rng_state_ = 0x9E3779B9u;
}

std::size_t pythia::state_id(uint64_t pc_low, int region_offset) const
{
  uint64_t pc_part = pc_low & ((1u << PC_BITS) - 1);
  uint64_t off_part = static_cast<uint64_t>(region_offset) & ((1u << OFFSET_BITS) - 1);
  return static_cast<std::size_t>((pc_part << OFFSET_BITS) | off_part);
}

int pythia::choose_action(std::size_t s)
{
  // xorshift32 RNG for determinism.
  uint32_t x = rng_state_;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  rng_state_ = x;

  if ((x % EPSILON_INV) == 0) {
    return static_cast<int>(x % NUM_ACTIONS);
  }
  // Greedy: argmax_a Q(s, a)
  const auto& row = q_table_[s];
  int best = 0;
  int best_q = row[0];
  for (int a = 1; a < NUM_ACTIONS; ++a) {
    if (row[a] > best_q) {
      best_q = row[a];
      best = a;
    }
  }
  return best;
}

void pythia::apply_reward(eval_entry& e, int reward, std::size_t cur_state)
{
  // SARSA update: Q(s,a) += alpha * (r + gamma * max_a' Q(s',a') - Q(s,a))
  int q_sa = q_table_[e.state_id][e.action_id];
  const auto& next_row = q_table_[cur_state];
  int next_best = next_row[0];
  for (int a = 1; a < NUM_ACTIONS; ++a) {
    if (next_row[a] > next_best) {
      next_best = next_row[a];
    }
  }
  int td = reward + (next_best >> DISCOUNT_SHIFT) - q_sa;
  int delta = (td * LEARN_NUM) >> LEARN_SHIFT;
  // Saturate Q values to int16 range to keep storage analogous.
  int new_q = q_sa + delta;
  if (new_q > 32767) {
    new_q = 32767;
  }
  if (new_q < -32768) {
    new_q = -32768;
  }
  q_table_[e.state_id][e.action_id] = new_q;
}

void pythia::update_eval_queue(uint64_t demanded_block, std::size_t cur_state)
{
  for (auto& e : eq_) {
    if (!e.used && e.pf_block == demanded_block) {
      e.used = true;
      apply_reward(e, REWARD_USEFUL, cur_state);
      ++reward_useful_total_;
    }
  }
}

uint32_t pythia::prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t /*cache_hit*/, bool /*useful_prefetch*/,
                                          access_type /*type*/, uint32_t metadata_in)
{
  champsim::block_number cl{addr};
  champsim::page_number page{addr};
  uint64_t pc_low = ip.to<uint64_t>();
  int region_offset = static_cast<int>(cl.to<uint64_t>() & 0x3F);
  std::size_t s = state_id(pc_low, region_offset);

  // Credit any in-flight prefetch evaluation whose target line matches
  // this demand access.
  update_eval_queue(cl.to<uint64_t>(), s);

  int a = choose_action(s);
  int off = ACTIONS[a];
  if (off == 0) {
    return metadata_in;
  }

  champsim::address pf_addr{cl + off};
  if (champsim::page_number{pf_addr} != page) {
    return metadata_in;
  }

  if (prefetch_line(pf_addr, true, 0)) {
    ++pref_issued_;
    if (eq_.size() >= EQ_SIZE) {
      auto& evicted = eq_.front();
      if (!evicted.used) {
        apply_reward(evicted, REWARD_USELESS, s);
        ++reward_useless_total_;
      }
      eq_.pop_front();
    }
    eval_entry ev{};
    ev.pf_block = champsim::block_number{pf_addr}.to<uint64_t>();
    ev.state_id = s;
    ev.action_id = a;
    eq_.push_back(ev);
  }

  return metadata_in;
}

uint32_t pythia::prefetcher_cache_fill(champsim::address addr, long /*set*/, long /*way*/, uint8_t prefetch, champsim::address /*evicted_addr*/,
                                       uint32_t metadata_in)
{
  if (prefetch) {
    champsim::block_number cl{addr};
    uint64_t cl_raw = cl.to<uint64_t>();
    for (auto& e : eq_) {
      if (!e.filled && e.pf_block == cl_raw) {
        e.filled = true;
        break;
      }
    }
  }
  return metadata_in;
}

void pythia::prefetcher_final_stats()
{
  std::cout << "[Pythia] issued=" << pref_issued_ << " rewards_useful=" << reward_useful_total_ << " rewards_useless=" << reward_useless_total_ << std::endl;
}
