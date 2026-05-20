#ifndef PREFETCHER_PYTHIA_H
#define PREFETCHER_PYTHIA_H

// Pythia (Bera et al., MICRO'21) — reinforcement-learning prefetcher.
// Pythia is a CPU C++ prefetcher (NOT a GPU/RL-stack), implemented as
// tabular SARSA-with-eligibility-traces over state features and an
// action space of fixed candidate offsets.
//
// Port scope:
//   - State features: low PC bits, page offset (2-feature tile-coding,
//     matches Bera et al.'s default 2-feature configuration before the
//     paper's extended-feature ablations).
//   - Action space: 16 candidate offsets including 0 (no-prefetch).
//   - Update rule: tabular SARSA, Q(s,a) <- Q(s,a) + alpha * (r + gamma *
//     Q(s',a') - Q(s,a)).
//   - Reward: +20 if the prefetched line is later demanded (timely),
//     -14 if filled then evicted-unused, 0 otherwise. Tracked via a
//     small evaluation queue stored on each prefetch issue.
//
// This is the canonical CPU prefetcher RL skeleton; it is not a port
// of Pythia's full N-feature configuration matrix nor of its full
// reward landscape from the artifact. Documented as such in
// docs/evidence/cache/pythia_dpc3_report.json.

#include <array>
#include <cstdint>
#include <deque>
#include <vector>

#include "address.h"
#include "champsim.h"
#include "modules.h"

class pythia : public champsim::modules::prefetcher
{
public:
  static constexpr int NUM_ACTIONS = 16;
  // Action 15 is the no-prefetch action (offset 0). Placing it last keeps
  // argmax-ties from collapsing to "do nothing" before any learning.
  static constexpr std::array<int, NUM_ACTIONS> ACTIONS = {1, 2, 3, 4, 5, 6, 8, 16, -1, -2, -3, -4, -8, -16, 32, 0};

  static constexpr std::size_t PC_BITS = 8;
  static constexpr std::size_t OFFSET_BITS = 6;
  static constexpr std::size_t NUM_STATES = (1u << PC_BITS) * (1u << OFFSET_BITS);

  static constexpr int Q_INIT = 0;
  static constexpr int REWARD_USEFUL = 20;
  static constexpr int REWARD_USELESS = -14;
  static constexpr int LEARN_NUM = 1; // alpha = 1/8 -> shift right 3
  static constexpr int LEARN_SHIFT = 3;
  static constexpr int DISCOUNT_SHIFT = 1; // gamma = 0.5
  static constexpr int EPSILON_INV = 16;   // ~6 % exploration

  static constexpr std::size_t EQ_SIZE = 256; // evaluation queue capacity

  using prefetcher::prefetcher;

  uint32_t prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t cache_hit, bool useful_prefetch, access_type type,
                                    uint32_t metadata_in);
  uint32_t prefetcher_cache_fill(champsim::address addr, long set, long way, uint8_t prefetch, champsim::address evicted_addr, uint32_t metadata_in);
  void prefetcher_initialize();
  void prefetcher_final_stats();

private:
  struct eval_entry {
    uint64_t pf_block;    // block number of issued prefetch
    std::size_t state_id; // state at issue
    int action_id;        // action at issue
    bool filled = false;
    bool used = false;
  };

  std::vector<std::array<int, NUM_ACTIONS>> q_table_;
  std::deque<eval_entry> eq_;
  uint64_t pref_issued_ = 0;
  uint64_t reward_useful_total_ = 0;
  uint64_t reward_useless_total_ = 0;
  uint32_t rng_state_ = 0x9E3779B9u;

  std::size_t state_id(uint64_t pc_low, int region_offset) const;
  int choose_action(std::size_t s);
  void update_eval_queue(uint64_t demanded_block, std::size_t cur_state);
  void apply_reward(eval_entry& e, int reward, std::size_t cur_state);
};

#endif
