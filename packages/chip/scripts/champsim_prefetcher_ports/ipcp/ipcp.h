#ifndef PREFETCHER_IPCP_H
#define PREFETCHER_IPCP_H

// IPCP — Instruction-Pointer-Classifier Prefetcher (Pakalapati & Panda,
// ISCA'20). Port of the canonical L2C variant to the ChampSim 2024-12
// module API. Reference impl from CMU-SAFARI/Pythia (prefetcher/ipcp_L2.cc),
// which is itself the CRC2 IPCP submission.
//
// Five classes track per-IP behavior:
//   - GS  (Global Stream, monotonic +1 / -1)
//   - CS  (Constant Stride, arbitrary fixed stride)
//   - CPLX (Complex Stride, signature-based — folded into stride here)
//   - NL  (Next Line)
//   - NP  (No prefetch)
// The L2 variant prefetches on GS, CS and NL classes within the same 4 KiB
// page; per-IP table is 64 entries with a 9-bit tag.

#include <array>
#include <cstdint>

#include "address.h"
#include "champsim.h"
#include "modules.h"

class ipcp : public champsim::modules::prefetcher
{
public:
  static constexpr std::size_t NUM_IP_INDEX_BITS = 6;
  static constexpr std::size_t NUM_IP_TAG_BITS = 9;
  static constexpr std::size_t NUM_IP_TABLE_ENTRIES = (1u << NUM_IP_INDEX_BITS);

  static constexpr uint32_t CLASS_GS = 1;
  static constexpr uint32_t CLASS_CS = 2;
  static constexpr uint32_t CLASS_NL = 4;
  static constexpr uint32_t CLASS_NP = 0;

  static constexpr int MAX_DEGREE = 4;

  struct tracker_t {
    uint16_t ip_tag = 0;
    bool ip_valid = false;
    int32_t stride = 0; // signed page-block stride
    uint32_t pref_class = CLASS_NP;
    uint8_t confidence = 0; // 2-bit saturating counter
  };

  using prefetcher::prefetcher;

  uint32_t prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t cache_hit, bool useful_prefetch, access_type type,
                                    uint32_t metadata_in);
  uint32_t prefetcher_cache_fill(champsim::address addr, long set, long way, uint8_t prefetch, champsim::address evicted_addr, uint32_t metadata_in);
  void prefetcher_initialize();
  void prefetcher_final_stats();

private:
  std::array<tracker_t, NUM_IP_TABLE_ENTRIES> trackers_{};
  uint64_t pref_issued_ = 0;
  uint64_t pref_gs_ = 0;
  uint64_t pref_cs_ = 0;
  uint64_t pref_nl_ = 0;
};

#endif
