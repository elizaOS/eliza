/*
 * Native verification harness for the E1X boot repair-ROM programming routine.
 *
 * This links the *same* freestanding boot core (fw/e1x/e1x_repair_boot.c) used
 * by the bare-metal image and drives it against a software model of the
 * e1x_repair_mmio_programmer.sv register file. The model latches DATA_LO/HI,
 * applies the single-deep PUSH backpressure, and forwards each accepted 64-bit
 * word into a route-table model that decodes header/remap/route words with the
 * exact bit layout of e1x_repair_rom_loader.sv. After the boot routine returns,
 * the harness verifies:
 *
 *   - the routine reports E1X_REPAIR_OK,
 *   - the programmer accepted exactly header+remap+route words,
 *   - the route-table model's lookups for the manifest's sampled routes return
 *     the expected first-hop direction and hop count,
 *   - a non-programmed (logical_from, logical_to) pair misses.
 *
 * The ROM words and the expected sampled-route triples are injected by the
 * generated header e1x_boot_repair_vectors.h, which scripts/check_e1x_boot_repair_fw.py
 * emits from the real generated ROM hex + repair manifest (no hand-faked data).
 *
 * SILICON BOUNDARY: this proves the boot-time read/parse/MMIO-program logic and
 * the route-table semantics against the real ROM image format. Fuse burning and
 * the OTP read port are silicon concerns and are modeled only in this harness.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "../../../fw/e1x/e1x_repair_boot.h"
#include "e1x_boot_repair_vectors.h"

/* Route-table model: mirrors e1x_repair_route_table.sv decode + lookup. */
#define MODEL_MAX_ROUTES 256u

typedef struct {
    uint32_t logical_from;
    uint32_t logical_to;
    uint32_t dir;
    uint32_t hops;
} route_record_t;

typedef struct {
    /* Loader decode state, indexed by image word position. */
    uint32_t word_index;
    uint32_t remap_count;
    uint32_t route_count;
    uint32_t remaps_seen;
    int magic_ok;

    route_record_t routes[MODEL_MAX_ROUTES];
    uint32_t routes_stored;
    int overflow;

    /* Programmer register state. */
    uint32_t data_lo;
    uint32_t data_hi;
    int pending;        /* a staged word awaiting loader acceptance */
    uint64_t pending_word;
    int error;
    uint32_t words_pushed;
} prog_model_t;

#define HEADER_WORDS 8u

static void loader_consume(prog_model_t *m, uint64_t word) {
    if (m->word_index == 0u) {
        m->magic_ok = (word == E1X_REPAIR_ROM_MAGIC);
    } else if (m->word_index == 4u) {
        m->remap_count = (uint32_t)(word & 0xffffffffu);
    } else if (m->word_index == 5u) {
        m->route_count = (uint32_t)(word & 0xffffffffu);
    } else if (m->word_index >= HEADER_WORDS) {
        if (m->word_index < HEADER_WORDS + m->remap_count) {
            m->remaps_seen++;
        } else if (m->word_index < HEADER_WORDS + m->remap_count + m->route_count) {
            route_record_t rec;
            rec.logical_from = (uint32_t)((word >> 40) & 0xffffffu);
            rec.logical_to = (uint32_t)((word >> 19) & 0x1fffffu);
            rec.dir = (uint32_t)((word >> 16) & 0x7u);
            rec.hops = (uint32_t)(word & 0xffffu);
            if (m->routes_stored < MODEL_MAX_ROUTES) {
                m->routes[m->routes_stored++] = rec;
            } else {
                m->overflow = 1;
            }
        }
    }
    m->word_index++;
}

/* Accept the staged word into the loader; clears pending. */
static void programmer_accept(prog_model_t *m) {
    if (!m->pending) {
        return;
    }
    loader_consume(m, m->pending_word);
    m->pending = 0;
}

static void model_mmio_write(void *ctx, uint32_t offset, uint32_t value) {
    prog_model_t *m = (prog_model_t *)ctx;
    switch (offset) {
    case E1X_REPAIR_PROG_CTRL:
        if (value & 0x1u) {
            /* clear: reset staged state, pushed count, and loader decode */
            memset(m, 0, sizeof(*m));
        }
        if (value & 0x2u) {
            m->error = 0;
        }
        break;
    case E1X_REPAIR_PROG_DATA_LO:
        m->data_lo = value;
        break;
    case E1X_REPAIR_PROG_DATA_HI:
        m->data_hi = value;
        break;
    case E1X_REPAIR_PROG_PUSH:
        /*
         * The RTL gates the PUSH write itself on ready when a word is already
         * pending; the firmware never issues PUSH while pending, so a PUSH here
         * always stages a fresh word. The downstream loader is always ready in
         * this model, so accept immediately on the next status poll.
         */
        if (m->pending) {
            /* would be backpressured in RTL; firmware contract avoids it */
            m->error = 1;
        } else {
            m->pending_word = ((uint64_t)m->data_hi << 32) | (uint64_t)m->data_lo;
            m->pending = 1;
            m->words_pushed++;
        }
        break;
    default:
        m->error = 1;
        break;
    }
}

static uint32_t model_mmio_read(void *ctx, uint32_t offset) {
    prog_model_t *m = (prog_model_t *)ctx;
    switch (offset) {
    case E1X_REPAIR_PROG_STATUS: {
        /*
         * Downstream loader is always ready: a pending word is accepted before
         * the firmware observes it, so STATUS reports not-pending + ready. This
         * matches the RTL handshake where word_ready_i is asserted.
         */
        programmer_accept(m);
        uint32_t status = 0u;
        status |= E1X_REPAIR_STATUS_WORD_READY;
        if (m->error) {
            status |= E1X_REPAIR_STATUS_ERROR;
        }
        return status;
    }
    case E1X_REPAIR_PROG_COUNT:
        return m->words_pushed;
    case E1X_REPAIR_PROG_DATA_LO:
        return m->data_lo;
    case E1X_REPAIR_PROG_DATA_HI:
        return m->data_hi;
    default:
        return 0xE1A00001u;
    }
}

static uint64_t model_read_rom_word(void *ctx, uint32_t index) {
    (void)ctx;
    if (index >= E1X_BOOT_REPAIR_ROM_WORD_COUNT) {
        return 0ull;
    }
    return e1x_boot_repair_rom_words[index];
}

static uint32_t model_rom_word_count(void *ctx) {
    (void)ctx;
    return E1X_BOOT_REPAIR_ROM_WORD_COUNT;
}

static int lookup_route(const prog_model_t *m, uint32_t from, uint32_t to,
                        uint32_t *dir, uint32_t *hops) {
    for (uint32_t i = 0; i < m->routes_stored; i++) {
        if (m->routes[i].logical_from == from && m->routes[i].logical_to == to) {
            *dir = m->routes[i].dir;
            *hops = m->routes[i].hops;
            return 1;
        }
    }
    return 0;
}

int main(void) {
    prog_model_t model;
    memset(&model, 0, sizeof(model));

    e1x_repair_bus_t bus = {
        .read_rom_word = model_read_rom_word,
        .rom_word_count = model_rom_word_count,
        .mmio_write = model_mmio_write,
        .mmio_read = model_mmio_read,
        .ctx = &model,
    };

    e1x_repair_result_t result;
    e1x_repair_status_t status = e1x_repair_program_from_rom(&bus, &result);

    int failures = 0;

    if (status != E1X_REPAIR_OK) {
        printf("FAIL: boot routine status=%d (expected 0)\n", (int)status);
        failures++;
    }

    uint32_t expected_total =
        E1X_REPAIR_ROM_HEADER_WORDS + result.remap_word_count + result.route_word_count;
    if (result.words_streamed != expected_total) {
        printf("FAIL: words_streamed=%u expected=%u\n", result.words_streamed, expected_total);
        failures++;
    }
    if (result.programmer_count != expected_total) {
        printf("FAIL: programmer_count=%u expected=%u\n", result.programmer_count, expected_total);
        failures++;
    }
    if (result.remap_word_count != E1X_BOOT_REPAIR_REMAP_COUNT) {
        printf("FAIL: remap_count=%u expected=%u\n", result.remap_word_count,
               E1X_BOOT_REPAIR_REMAP_COUNT);
        failures++;
    }
    if (result.route_word_count != E1X_BOOT_REPAIR_ROUTE_COUNT) {
        printf("FAIL: route_count=%u expected=%u\n", result.route_word_count,
               E1X_BOOT_REPAIR_ROUTE_COUNT);
        failures++;
    }
    if (model.magic_ok != 1) {
        printf("FAIL: model never observed valid magic\n");
        failures++;
    }
    if (model.overflow != 0) {
        printf("FAIL: route-table model overflowed (increase MODEL_MAX_ROUTES)\n");
        failures++;
    }
    if (model.routes_stored != E1X_BOOT_REPAIR_ROUTE_COUNT) {
        printf("FAIL: routes_stored=%u expected=%u\n", model.routes_stored,
               E1X_BOOT_REPAIR_ROUTE_COUNT);
        failures++;
    }

    /* Verify every sampled route the manifest declared programs correctly. */
    uint32_t verified = 0;
    for (uint32_t i = 0; i < E1X_BOOT_REPAIR_SAMPLE_COUNT; i++) {
        uint32_t from = e1x_boot_repair_samples[i].logical_from;
        uint32_t to = e1x_boot_repair_samples[i].logical_to;
        uint32_t dir = 0, hops = 0;
        if (!lookup_route(&model, from, to, &dir, &hops)) {
            printf("FAIL: sample %u (from=%u to=%u) not programmed\n", i, from, to);
            failures++;
            continue;
        }
        if (dir != e1x_boot_repair_samples[i].dir || hops != e1x_boot_repair_samples[i].hops) {
            printf("FAIL: sample %u (from=%u to=%u) dir=%u/%u hops=%u/%u\n", i, from, to, dir,
                   e1x_boot_repair_samples[i].dir, hops, e1x_boot_repair_samples[i].hops);
            failures++;
            continue;
        }
        verified++;
    }

    /* A pair that was never programmed must miss. */
    uint32_t dir = 0, hops = 0;
    if (lookup_route(&model, 0xfffffeu, 0x1fffffu, &dir, &hops)) {
        printf("FAIL: unprogrammed route unexpectedly hit\n");
        failures++;
    }

    if (failures != 0) {
        printf("RESULT: FAIL (%d assertions failed)\n", failures);
        return 1;
    }
    printf("RESULT: PASS streamed=%u programmer_count=%u routes=%u sampled_verified=%u\n",
           result.words_streamed, result.programmer_count, model.routes_stored, verified);
    return 0;
}
