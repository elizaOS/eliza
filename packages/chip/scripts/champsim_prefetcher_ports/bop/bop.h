#ifndef PREFETCHER_BOP_H
#define PREFETCHER_BOP_H

// Best-Offset Prefetcher (Michaud, HPCA'16)
// Port of the reference algorithm to the ChampSim 2024-12 module API.
// Reference: https://hal.inria.fr/hal-01254863  ("A Best-Offset Prefetcher")
//
// Algorithm summary:
//   - Maintain a recent-requests (RR) table of recently used line addresses.
//   - For each access, evaluate one offset from a candidate list: if
//     (line - offset) is in RR, increment that offset's score.
//   - At the end of a learning phase (round_max rounds reached or
//     max_score saturated), select the offset with the highest score as
//     the new "best offset" used for prefetching subsequent demands.

#include <array>
#include <cstddef>
#include <cstdint>

#include "address.h"
#include "champsim.h"
#include "modules.h"

class bop : public champsim::modules::prefetcher
{
public:
  // Candidate offset list from the reference implementation (52 entries,
  // products of small primes up to 256).
  static constexpr std::array<int32_t, 52> CANDIDATES = {1,  2,  3,  4,  5,  6,  8,  9,  10, 12, 15,  16,  18,  20,  24,  25,  27,
                                                         30, 32, 36, 40, 45, 48, 50, 54, 60, 64, 72,  75,  80,  81,  90,  96,  100,
                                                         108, 120, 125, 128, 135, 144, 150, 160, 162, 180, 192, 200, 216, 225, 240, 243, 250, 256};

  static constexpr uint32_t MAX_ROUNDS = 100;
  static constexpr uint32_t MAX_SCORE = 31;
  static constexpr uint32_t BAD_SCORE_THRESHOLD = 1; // disable prefetch below this
  static constexpr std::size_t RR_SIZE = 256;        // recent-requests entries

  using prefetcher::prefetcher;

  uint32_t prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t cache_hit, bool useful_prefetch, access_type type,
                                    uint32_t metadata_in);
  uint32_t prefetcher_cache_fill(champsim::address addr, long set, long way, uint8_t prefetch, champsim::address evicted_addr, uint32_t metadata_in);
  void prefetcher_cycle_operate();
  void prefetcher_initialize();
  void prefetcher_final_stats();

private:
  std::array<uint64_t, RR_SIZE> rr_{};
  std::array<bool, RR_SIZE> rr_valid_{};
  std::array<uint32_t, CANDIDATES.size()> scores_{};
  uint32_t round_counter_ = 0;
  uint32_t candidate_ptr_ = 0;
  int32_t best_offset_ = 1;
  bool prefetch_enabled_ = true;
  uint64_t pref_issued_ = 0;

  static std::size_t rr_index(uint64_t line);
  bool rr_lookup(uint64_t line) const;
  void rr_insert(uint64_t line);
  void end_phase();
};

#endif
