/*
 * Host-gcc unit tests for the SPMI v2 master FSM.
 *
 * The production binding (pmc_spmi_*) targets a memory-mapped accelerator on
 * the AON island, which is not available in a host build. To exercise the
 * FSM under host gcc we build the same translation unit with
 * SPMI_HOSTED_UNIT_TEST and bind a software-loopback peripheral that mirrors
 * the documented SPMI controller state machine.
 *
 * Coverage:
 *   - simple master_write           : write byte to a slave register.
 *   - master_read   round-trip      : read byte that the loopback latched.
 *   - master_write_burst (4 bytes)  : verifies SID+addr increment is correct.
 *   - error path                    : peripheral asserts PARITY_ERR; the
 *                                     master returns -1 with last_state set
 *                                     to SPMI_STATE_ERROR.
 *   - slave_trigger                 : ownership-transfer command emitted.
 */

#include "spmi.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define SPMI_CTRL_BUSY        (1u << 31)
#define SPMI_CTRL_PARITY_ERR  (1u << 30)
#define SPMI_CTRL_SID_SHIFT   24u
#define SPMI_CTRL_REG_SHIFT    8u
#define SPMI_CTRL_DATA_MASK   0xFFu

#define SPMI_CMD_EXT_WRITEL         0x30u
#define SPMI_CMD_EXT_READL          0x38u
#define SPMI_CMD_TRANSFER_BUS_OWNER 0x1Au

struct fake_slave {
    uint32_t ctrl;
    uint8_t  mem[256];     /* 256 byte address space per SID */
    uint8_t  next_sid;     /* SID that produced the last write */
    uint16_t next_reg;
    uint8_t  last_opcode;
    int      cmd_strobes;
    int      inject_parity_err;
    int      transactions;
};

static uint32_t fake_read(void *ctx)
{
    struct fake_slave *s = (struct fake_slave *)ctx;
    return s->ctrl;
}

static void fake_cmd(void *ctx, uint8_t opcode)
{
    struct fake_slave *s = (struct fake_slave *)ctx;
    s->last_opcode = opcode;
    s->cmd_strobes++;
}

static void fake_write(void *ctx, uint32_t value)
{
    struct fake_slave *s = (struct fake_slave *)ctx;
    uint8_t  sid   = (uint8_t)((value >> SPMI_CTRL_SID_SHIFT) & 0xFu);
    uint16_t reg   = (uint16_t)((value >> SPMI_CTRL_REG_SHIFT) & 0xFFFFu);
    uint8_t  data  = (uint8_t)(value & SPMI_CTRL_DATA_MASK);
    s->next_sid    = sid;
    s->next_reg    = reg;
    s->transactions++;
    if (s->inject_parity_err) {
        s->ctrl = SPMI_CTRL_PARITY_ERR;
        return;
    }
    switch (s->last_opcode) {
    case SPMI_CMD_EXT_WRITEL:
        s->mem[reg & 0xFFu] = data;
        s->ctrl = 0u;
        break;
    case SPMI_CMD_EXT_READL:
        /* Return the byte the slave previously latched. */
        s->ctrl = (uint32_t)s->mem[reg & 0xFFu];
        break;
    case SPMI_CMD_TRANSFER_BUS_OWNER:
        s->ctrl = 0u;
        break;
    default:
        s->ctrl = SPMI_CTRL_PARITY_ERR;
        break;
    }
}

static void test_simple_write(void)
{
    struct fake_slave slave;
    memset(&slave, 0, sizeof(slave));
    struct spmi_master m;
    struct spmi_master_ops ops = { .read = fake_read, .write = fake_write, .cmd = fake_cmd };
    spmi_master_init(&m, &ops, &slave);

    int rc = spmi_master_write(&m, 0x3, 0x123, 0xA5);
    assert(rc == 0);
    assert(slave.next_sid == 0x3);
    assert(slave.next_reg == 0x123);
    assert(slave.mem[0x23] == 0xA5);
    assert(slave.transactions == 1);
    assert(slave.cmd_strobes == 1);
    assert(slave.last_opcode == SPMI_CMD_EXT_WRITEL);
    assert(spmi_last_state(&m) == SPMI_STATE_COMPLETE);
}

static void test_read_roundtrip(void)
{
    struct fake_slave slave;
    memset(&slave, 0, sizeof(slave));
    slave.mem[0x42] = 0x5A;
    struct spmi_master m;
    struct spmi_master_ops ops = { .read = fake_read, .write = fake_write, .cmd = fake_cmd };
    spmi_master_init(&m, &ops, &slave);

    uint8_t value = 0u;
    int rc = spmi_master_read(&m, 0x4, 0x0042, &value);
    assert(rc == 0);
    assert(value == 0x5A);
    assert(slave.next_sid == 0x4);
    assert(slave.next_reg == 0x0042);
}

static void test_burst(void)
{
    struct fake_slave slave;
    memset(&slave, 0, sizeof(slave));
    struct spmi_master m;
    struct spmi_master_ops ops = { .read = fake_read, .write = fake_write, .cmd = fake_cmd };
    spmi_master_init(&m, &ops, &slave);

    const uint8_t bytes[4] = { 0xDE, 0xAD, 0xBE, 0xEF };
    int rc = spmi_master_write_burst(&m, 0x5, 0x80, bytes, 4);
    assert(rc == 0);
    assert(slave.mem[0x80] == 0xDE);
    assert(slave.mem[0x81] == 0xAD);
    assert(slave.mem[0x82] == 0xBE);
    assert(slave.mem[0x83] == 0xEF);
    assert(slave.transactions == 4);
}

static void test_error_path(void)
{
    struct fake_slave slave;
    memset(&slave, 0, sizeof(slave));
    slave.inject_parity_err = 1;
    struct spmi_master m;
    struct spmi_master_ops ops = { .read = fake_read, .write = fake_write, .cmd = fake_cmd };
    spmi_master_init(&m, &ops, &slave);

    int rc = spmi_master_write(&m, 0x1, 0x0010, 0xFF);
    assert(rc == -1);
    assert(spmi_last_state(&m) == SPMI_STATE_ERROR);
}

static void test_slave_trigger(void)
{
    struct fake_slave slave;
    memset(&slave, 0, sizeof(slave));
    struct spmi_master m;
    struct spmi_master_ops ops = { .read = fake_read, .write = fake_write, .cmd = fake_cmd };
    spmi_master_init(&m, &ops, &slave);

    int rc = spmi_slave_trigger(&m, 0x7);
    assert(rc == 0);
    assert(slave.next_sid == 0x7);
    assert(slave.transactions == 1);
    assert(slave.last_opcode == SPMI_CMD_TRANSFER_BUS_OWNER);
}

int main(void)
{
    test_simple_write();
    test_read_roundtrip();
    test_burst();
    test_error_path();
    test_slave_trigger();
    printf("fw/pmc/tests/test_spmi: 5 cases passed\n");
    return 0;
}
