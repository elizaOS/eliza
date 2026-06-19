#ifndef PREFETCHER_BERTI_H
#define PREFETCHER_BERTI_H

// Berti (Navarro-Torres et al., MICRO'22). Port of the timing-aware delta
// prefetcher to the ChampSim 2024-12 module API.
//
// Algorithmic faithfulness note:
//   The reference Berti drop-in (Berti-Artifact MICRO'22) records demand-
//   to-fill latency and uses it to label deltas as "timely" (delta-on-time
//   for prefetch issue), "late", or "wrong". The ChampSim 2024-12
//   prefetcher interface does not expose per-request fill latency inside
//   prefetcher_cache_operate(); the timing table would have to be wired
//   through the cache subsystem. This port implements Berti's per-IP
//   delta voting and confidence machinery faithfully, but treats every
//   recurring delta as "timely" rather than gating on a measured
//   latency window. The IP table, history-of-deltas voting, and burst
//   throttling logic are unchanged. This deviation is documented in
//   docs/evidence/cache/champsim_external_prefetchers_report.json
//   under `algorithmic_adaptations.berti`.

#include <array>
#include <cstdint>
#include <list>
#include <unordered_map>
#include <vector>

#include "address.h"
#include "champsim.h"
#include "modules.h"

class berti : public champsim::modules::prefetcher
{
public:
  static constexpr std::size_t IP_TABLE_INDEX_BITS = 12;
  static constexpr std::size_t IP_TABLE_ENTRIES = (1u << IP_TABLE_INDEX_BITS);
  static constexpr std::size_t HISTORY_PER_IP = 16; // per-IP recent deltas tracked
  static constexpr int PAGE_BLOCKS = 64;            // 4 KiB / 64 B
  static constexpr int MAX_BURST = 7;
  static constexpr int CONFIDENCE_THRESHOLD = 8;    // votes out of HISTORY_PER_IP
  static constexpr int MAX_DEGREE = 4;

  struct ip_entry {
    bool valid = false;
    uint64_t ip_tag = 0;
    int last_offset = -1; // last page offset accessed by this IP
    uint64_t last_page = 0;
    std::array<int, HISTORY_PER_IP> deltas{};
    std::size_t delta_head = 0;
    std::size_t delta_count = 0;
  };

  using prefetcher::prefetcher;

  uint32_t prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t cache_hit, bool useful_prefetch, access_type type,
                                    uint32_t metadata_in);
  uint32_t prefetcher_cache_fill(champsim::address addr, long set, long way, uint8_t prefetch, champsim::address evicted_addr, uint32_t metadata_in);
  void prefetcher_initialize();
  void prefetcher_final_stats();

private:
  std::vector<ip_entry> ip_table_;
  uint64_t pref_issued_ = 0;
  uint64_t pref_burst_ = 0;

  // Vote for the most-recurring delta in this IP's history. Returns (delta,
  // vote_count). delta == 0 means no winner.
  std::pair<int, int> vote_best_delta(const ip_entry& e) const;
};

#endif
