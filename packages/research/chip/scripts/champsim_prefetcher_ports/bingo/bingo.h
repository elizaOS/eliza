#ifndef PREFETCHER_BINGO_H
#define PREFETCHER_BINGO_H

// Bingo (Bakhshalipour et al., HPCA'19). Port of the HPCA'19 spatial-
// pattern prefetcher to ChampSim 2024-12.
//
// Bingo records bit-vector access patterns per spatial region (2 KiB
// here -> 32 blocks of 64 B), keyed by PC + region. On a region-trigger
// access (first touch into a new region) it looks up the PHT by the
// triggering PC at two widths:
//   - PC+address: full address tag (high recall)
//   - PC+offset:  PC plus the offset of the trigger within the region
// matches are union-voted into a prefetch pattern that is streamed.
//
// Storage in this port:
//   - Filter Table  (region -> trigger PC+offset; ~64 entries)
//   - Accumulation Table (region -> pattern bitmap; ~128 entries)
//   - Pattern History Table (PC+offset -> pattern bitmap; ~8 K entries)

#include <array>
#include <cstdint>
#include <list>
#include <optional>
#include <unordered_map>
#include <vector>

#include "address.h"
#include "champsim.h"
#include "modules.h"

class bingo : public champsim::modules::prefetcher
{
public:
  static constexpr int REGION_LOG2 = 11;                          // 2 KiB region
  static constexpr int PATTERN_LEN = (1 << (REGION_LOG2 - 6));    // 32 blocks
  // Smaller tables than the HPCA'19 reference (which sized for 1 GHz +
  // multi-million-instruction warmups). With 2 M warmup + 2 M sim we
  // need the accumulation table to overflow quickly so the PHT trains.
  static constexpr std::size_t FILTER_TABLE_SIZE = 32;
  static constexpr std::size_t ACCUM_TABLE_SIZE = 32;
  static constexpr std::size_t PHT_SIZE = 8192;

  using prefetcher::prefetcher;

  uint32_t prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t cache_hit, bool useful_prefetch, access_type type,
                                    uint32_t metadata_in);
  uint32_t prefetcher_cache_fill(champsim::address addr, long set, long way, uint8_t prefetch, champsim::address evicted_addr, uint32_t metadata_in);
  void prefetcher_initialize();
  void prefetcher_final_stats();

private:
  struct filter_entry {
    uint64_t pc;
    int offset;
  };
  struct accum_entry {
    uint64_t pc;
    int trigger_offset;
    std::array<bool, PATTERN_LEN> pattern;
  };
  struct pht_entry {
    std::array<bool, PATTERN_LEN> pattern;
  };

  template <typename V>
  class lru_map
  {
  public:
    explicit lru_map(std::size_t cap) : cap_(cap) {}
    V* find(uint64_t key)
    {
      auto it = map_.find(key);
      if (it == map_.end()) {
        return nullptr;
      }
      order_.splice(order_.begin(), order_, it->second.lru_it);
      return &it->second.value;
    }
    // Insert and return the evicted (key, value) pair if the table was at
    // capacity. Returning the victim lets the AT->PHT training path see
    // the pattern that just left the accumulation table.
    std::optional<std::pair<uint64_t, V>> insert(uint64_t key, V value)
    {
      auto it = map_.find(key);
      if (it != map_.end()) {
        it->second.value = std::move(value);
        order_.splice(order_.begin(), order_, it->second.lru_it);
        return std::nullopt;
      }
      std::optional<std::pair<uint64_t, V>> victim_out;
      if (map_.size() >= cap_) {
        uint64_t victim = order_.back();
        auto vit = map_.find(victim);
        if (vit != map_.end()) {
          victim_out = std::make_pair(victim, std::move(vit->second.value));
          map_.erase(vit);
        }
        order_.pop_back();
      }
      order_.push_front(key);
      map_.emplace(key, slot{std::move(value), order_.begin()});
      return victim_out;
    }
    void erase(uint64_t key)
    {
      auto it = map_.find(key);
      if (it == map_.end()) {
        return;
      }
      order_.erase(it->second.lru_it);
      map_.erase(it);
    }

  private:
    struct slot {
      V value;
      std::list<uint64_t>::iterator lru_it;
    };
    std::size_t cap_;
    std::unordered_map<uint64_t, slot> map_;
    std::list<uint64_t> order_;
  };

  lru_map<filter_entry> filter_table_{FILTER_TABLE_SIZE};
  lru_map<accum_entry> accum_table_{ACCUM_TABLE_SIZE};
  lru_map<pht_entry> pht_{PHT_SIZE};
  uint64_t pref_issued_ = 0;

  std::array<bool, PATTERN_LEN> find_in_pht(uint64_t pc, uint64_t region_offset, bool& any_hit);
  void insert_into_pht(uint64_t pc, uint64_t trigger_offset, const std::array<bool, PATTERN_LEN>& pattern);
  void evict_region_to_pht(uint64_t region_number, const accum_entry& e);
};

#endif
