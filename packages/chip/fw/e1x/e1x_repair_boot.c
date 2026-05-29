/*
 * E1X boot-time repair-ROM programming core. See e1x_repair_boot.h for the
 * silicon boundary and register-map references. This file is freestanding: no
 * libc, no heap, no dependency beyond <stdint.h> and the bus callbacks.
 */
#include "e1x_repair_boot.h"

/*
 * Stage one 64-bit word into the programmer and push it, honouring the PUSH
 * register's valid/ready backpressure. Returns 0 on success, non-zero on a
 * latched programmer error or a backpressure timeout.
 */
static int push_word(const e1x_repair_bus_t *bus, uint64_t word) {
    bus->mmio_write(bus->ctx, E1X_REPAIR_PROG_DATA_LO, (uint32_t)(word & 0xffffffffu));
    bus->mmio_write(bus->ctx, E1X_REPAIR_PROG_DATA_HI, (uint32_t)(word >> 32));

    /*
     * The programmer holds at most one pending word. If a prior word has not
     * yet been accepted by the loader, the PUSH write is gated (write_ready low
     * until the loader asserts ready). Spin until pending clears before issuing
     * the next PUSH so we never drop a word.
     */
    for (uint32_t spin = 0; spin < E1X_REPAIR_PUSH_SPIN_BUDGET; spin++) {
        uint32_t status = bus->mmio_read(bus->ctx, E1X_REPAIR_PROG_STATUS);
        if (status & E1X_REPAIR_STATUS_ERROR) {
            return -1;
        }
        if ((status & E1X_REPAIR_STATUS_PENDING_LO) == 0u) {
            bus->mmio_write(bus->ctx, E1X_REPAIR_PROG_PUSH, 1u);
            return 0;
        }
    }
    return -2;
}

e1x_repair_status_t e1x_repair_program_from_rom(const e1x_repair_bus_t *bus,
                                                e1x_repair_result_t *out) {
    e1x_repair_result_t local;
    local.status = E1X_REPAIR_OK;
    local.remap_word_count = 0u;
    local.route_word_count = 0u;
    local.words_streamed = 0u;
    local.programmer_count = 0u;

    if (bus == 0 || bus->read_rom_word == 0 || bus->rom_word_count == 0 ||
        bus->mmio_write == 0 || bus->mmio_read == 0) {
        if (out) {
            out->status = E1X_REPAIR_ERR_NULL_BUS;
        }
        return E1X_REPAIR_ERR_NULL_BUS;
    }

    uint32_t available = bus->rom_word_count(bus->ctx);
    if (available < E1X_REPAIR_ROM_HEADER_WORDS) {
        local.status = E1X_REPAIR_ERR_SHORT_IMAGE;
        if (out) {
            *out = local;
        }
        return local.status;
    }

    if (bus->read_rom_word(bus->ctx, 0u) != E1X_REPAIR_ROM_MAGIC) {
        local.status = E1X_REPAIR_ERR_BAD_MAGIC;
        if (out) {
            *out = local;
        }
        return local.status;
    }

    /* Header counts live in the low 32 bits of words 4 and 5. */
    local.remap_word_count = (uint32_t)(bus->read_rom_word(bus->ctx, 4u) & 0xffffffffu);
    local.route_word_count = (uint32_t)(bus->read_rom_word(bus->ctx, 5u) & 0xffffffffu);

    /*
     * Total declared words must fit inside the available image and not wrap the
     * 32-bit word index. Reject any image whose header over-claims its payload.
     */
    uint64_t declared = (uint64_t)E1X_REPAIR_ROM_HEADER_WORDS +
                        (uint64_t)local.remap_word_count +
                        (uint64_t)local.route_word_count;
    if (declared > (uint64_t)0xffffffffu) {
        local.status = E1X_REPAIR_ERR_COUNT_OVERFLOW;
        if (out) {
            *out = local;
        }
        return local.status;
    }
    if (declared > (uint64_t)available) {
        local.status = E1X_REPAIR_ERR_SHORT_IMAGE;
        if (out) {
            *out = local;
        }
        return local.status;
    }

    /*
     * Reset the programmer (CTRL bit0 clears staged state + pushed count, bit1
     * clears any latched error) before streaming a fresh image.
     */
    bus->mmio_write(bus->ctx, E1X_REPAIR_PROG_CTRL, 0x3u);

    /*
     * Stream the full image: header words first (the loader consumes them to
     * decode counts), then remap words, then route words. The loader and route
     * table expect the words in image order, so we push every word index from 0
     * through declared-1.
     */
    uint32_t total = (uint32_t)declared;
    for (uint32_t index = 0u; index < total; index++) {
        uint64_t word = bus->read_rom_word(bus->ctx, index);
        int rc = push_word(bus, word);
        if (rc == -1) {
            local.status = E1X_REPAIR_ERR_PROGRAMMER;
            break;
        }
        if (rc == -2) {
            local.status = E1X_REPAIR_ERR_PUSH_TIMEOUT;
            break;
        }
        local.words_streamed++;
    }

    /* Drain the final pending word so COUNT reflects every accepted push. */
    if (local.status == E1X_REPAIR_OK) {
        for (uint32_t spin = 0; spin < E1X_REPAIR_PUSH_SPIN_BUDGET; spin++) {
            uint32_t status = bus->mmio_read(bus->ctx, E1X_REPAIR_PROG_STATUS);
            if (status & E1X_REPAIR_STATUS_ERROR) {
                local.status = E1X_REPAIR_ERR_PROGRAMMER;
                break;
            }
            if ((status & E1X_REPAIR_STATUS_PENDING_LO) == 0u) {
                break;
            }
        }
    }

    local.programmer_count = bus->mmio_read(bus->ctx, E1X_REPAIR_PROG_COUNT);

    if (local.status == E1X_REPAIR_OK && local.programmer_count != total) {
        local.status = E1X_REPAIR_ERR_COUNT_MISMATCH;
    }

    if (out) {
        *out = local;
    }
    return local.status;
}
