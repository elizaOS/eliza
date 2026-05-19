# E1 Demo Debug/MMIO Interface

`e1_chip_top` exposes a 4-bit package-facing debug interface and translates it into the internal 32-bit MMIO bus.

## Pins

| Signal | Direction | Description |
| --- | --- | --- |
| `DBG_VALID` | input | Pulses one debug operation. |
| `DBG_LAUNCH` | input | Launches the loaded MMIO transaction when asserted with `DBG_VALID`. |
| `DBG_WRITE` | input | `1` for load/write operations, `0` for read/select operations. |
| `DBG_ADDR[3:0]` | input | Nibble index or command. |
| `DBG_WDATA[3:0]` | input | Nibble payload for load operations. |
| `DBG_RDATA[3:0]` | output | Selected readback nibble. |
| `DBG_READY` | output | High when the bridge accepted the command. |

## Protocol

Address load:

```text
DBG_VALID=1, DBG_WRITE=1, DBG_ADDR=0x0..0x7, DBG_WDATA=address nibble
```

Write-data load:

```text
DBG_VALID=1, DBG_WRITE=1, DBG_ADDR=0x8..0xF, DBG_WDATA=write-data nibble
```

Transaction launch:

```text
DBG_VALID=1, DBG_LAUNCH=1
DBG_WRITE=1 launches an MMIO write.
DBG_WRITE=0 launches an MMIO read and captures the response.
```

Readback nibble select:

```text
DBG_VALID=1, DBG_WRITE=0, DBG_ADDR=0x0..0x7
DBG_RDATA returns the selected captured read-data nibble.
```

The MVP bridge is single-clock and single-transaction. It has no queueing, timeout, error response, or CDC. Those are required before this interface becomes a production debug transport.
