#include "ipcp.h"

#include <iostream>

#include "cache.h"

void ipcp::prefetcher_initialize()
{
  for (auto& t : trackers_) {
    t = tracker_t{};
  }
  pref_issued_ = 0;
  pref_gs_ = 0;
  pref_cs_ = 0;
  pref_nl_ = 0;
}

uint32_t ipcp::prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t /*cache_hit*/, bool /*useful_prefetch*/,
                                        access_type /*type*/, uint32_t metadata_in)
{
  champsim::block_number cl{addr};
  uint64_t ip_raw = ip.to<uint64_t>();
  uint64_t ip_index = ip_raw & ((1u << NUM_IP_INDEX_BITS) - 1);
  uint16_t ip_tag = static_cast<uint16_t>((ip_raw >> NUM_IP_INDEX_BITS) & ((1u << NUM_IP_TAG_BITS) - 1));
  auto& tr = trackers_[ip_index];

  int32_t observed_stride = 0;
  if (tr.ip_valid && tr.ip_tag == ip_tag) {
    int64_t s = static_cast<int64_t>(cl.to<uint64_t>()) - static_cast<int64_t>(tr.stride);
    // Reconstruct observed stride from the last tracked cache line. Since
    // we only stored stride (not last-line), use it as a single-step
    // running estimator: increment confidence if stride sign/magnitude
    // matches.
    observed_stride = static_cast<int32_t>(s);
    (void)observed_stride;
  }

  // Default: new/conflict IP -> next-line, mark valid.
  if (!tr.ip_valid || tr.ip_tag != ip_tag) {
    tr.ip_tag = ip_tag;
    tr.ip_valid = true;
    tr.pref_class = CLASS_NL;
    tr.confidence = 0;

    champsim::address pf_addr{cl + 1};
    if (champsim::page_number{pf_addr} == champsim::page_number{addr}) {
      if (prefetch_line(pf_addr, true, 0)) {
        ++pref_issued_;
        ++pref_nl_;
      }
    }
    tr.stride = static_cast<int32_t>(cl.to<uint64_t>() & 0xFFFFFFFFu);
    return metadata_in;
  }

  // Same IP: derive stride between the last-stored line and the current line.
  uint32_t last_line_lo = static_cast<uint32_t>(tr.stride);
  uint32_t cur_line_lo = static_cast<uint32_t>(cl.to<uint64_t>() & 0xFFFFFFFFu);
  int32_t stride = static_cast<int32_t>(cur_line_lo - last_line_lo);

  // Class assignment.
  uint32_t new_class = CLASS_NP;
  if (stride == 1 || stride == -1) {
    new_class = CLASS_GS;
  } else if (stride != 0) {
    new_class = CLASS_CS;
  } else {
    new_class = CLASS_NL;
  }

  if (new_class == tr.pref_class) {
    if (tr.confidence < 3) {
      ++tr.confidence;
    }
  } else {
    if (tr.confidence > 0) {
      --tr.confidence;
    } else {
      tr.pref_class = new_class;
    }
  }
  tr.stride = static_cast<int32_t>(cur_line_lo);

  // Issue prefetches per class with degree gated on confidence.
  int degree = (tr.confidence >= 2) ? MAX_DEGREE : ((tr.confidence == 1) ? 2 : 1);
  if (tr.pref_class == CLASS_GS || tr.pref_class == CLASS_CS) {
    if (stride == 0) {
      return metadata_in;
    }
    for (int i = 1; i <= degree; ++i) {
      int64_t delta = static_cast<int64_t>(stride) * i;
      champsim::address pf_addr{cl + delta};
      if (champsim::page_number{pf_addr} != champsim::page_number{addr}) {
        break;
      }
      if (prefetch_line(pf_addr, true, 0)) {
        ++pref_issued_;
        if (tr.pref_class == CLASS_GS) {
          ++pref_gs_;
        } else {
          ++pref_cs_;
        }
      }
    }
  } else if (tr.pref_class == CLASS_NL) {
    champsim::address pf_addr{cl + 1};
    if (champsim::page_number{pf_addr} == champsim::page_number{addr}) {
      if (prefetch_line(pf_addr, true, 0)) {
        ++pref_issued_;
        ++pref_nl_;
      }
    }
  }

  return metadata_in;
}

uint32_t ipcp::prefetcher_cache_fill(champsim::address /*addr*/, long /*set*/, long /*way*/, uint8_t /*prefetch*/, champsim::address /*evicted_addr*/,
                                     uint32_t metadata_in)
{
  return metadata_in;
}

void ipcp::prefetcher_final_stats()
{
  std::cout << "[IPCP] issued=" << pref_issued_ << " gs=" << pref_gs_ << " cs=" << pref_cs_ << " nl=" << pref_nl_ << std::endl;
}
